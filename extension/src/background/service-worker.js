/**
 * MultiChatAI service worker.
 *
 * Owns:
 *   - the toolbar action (opens the app tab)
 *   - the long-lived port used by the app page
 *   - fan-out of one prompt to N models (API mode and browser-session mode in
 *     parallel), streaming partial answers back as they arrive
 *   - abort handling ("Stop")
 *   - small request/response helpers for the settings screen (test key, check
 *     login, open provider tab)
 *
 * The worker keeps no state that matters across restarts: everything durable
 * lives in chrome.storage, and a disconnected port simply reconnects.
 */

import { MODE_API, MODE_EMBED, PROVIDERS } from '../shared/providers.js';
import { runApiModel, testApiModel } from './api.js';
import { handleBridgeMessage } from './bridge-hub.js';
import { embedRuleCount, ensureEmbedRules } from './embed-rules.js';
import {
  checkProvider,
  describeEmbedFrame,
  embedFrameFor,
  openProviderTab,
  registerEmbedFrame,
  resetProviderChats,
  runEmbedModel,
  runWebModel,
} from './web-runner.js';

const APP_PREFIX = chrome.runtime.getURL('src/app/');
const DEFAULT_TIMEOUT_SEC = 180;

/** @type {Set<chrome.runtime.Port>} */
const appPorts = new Set();
/** @type {Map<string, {controllers: Map<string, AbortController>}>} */
const activeRuns = new Map();

/* ────────────────────────────── toolbar / install ────────────────────────────── */

async function openApp() {
  const all = await chrome.tabs.query({});
  const existing = all.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(APP_PREFIX));
  if (existing && typeof existing.id === 'number') {
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    if (typeof existing.windowId === 'number') {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    return existing.id;
  }
  const tab = await chrome.tabs.create({ url: `${APP_PREFIX}app.html` });
  return tab.id;
}

chrome.action.onClicked.addListener(() => {
  void openApp();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get(['settings']);
  if (!stored.settings) {
    await chrome.storage.local.set({
      settings: {
        models: [],
        theme: 'dark',
        timeoutSec: DEFAULT_TIMEOUT_SEC,
        resetProviderChatsOnNewChat: false,
        historyLimit: 100,
      },
    });
  }
  // Framing rules must exist before the first embedded column renders.
  await ensureEmbedRules();
  if (details.reason === 'install') void openApp();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureEmbedRules();
});

// The worker can be started by any event; make sure the rules are present.
void ensureEmbedRules();

/* ────────────────────────────── embedded frames ────────────────────────────── */

/** A bridge inside an embedded column announced itself. */
function handleHello(message, sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (typeof tabId !== 'number' || typeof frameId !== 'number') return;
  if (!message.modelId) return;

  registerEmbedFrame(message.modelId, tabId, frameId);
  broadcast({
    type: 'embed-status',
    modelId: message.modelId,
    ready: true,
    signedIn: Boolean(message.signedIn),
    hasComposer: Boolean(message.hasComposer),
    host: message.host || '',
  });
}

function broadcast(message) {
  for (const port of appPorts) send(port, message);
}

/* ────────────────────────────── app port ────────────────────────────── */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'multichat-app') return;
  appPorts.add(port);

  port.onMessage.addListener((message) => {
    void handleAppMessage(port, message);
  });

  port.onDisconnect.addListener(() => {
    appPorts.delete(port);
  });

  send(port, { type: 'pong', version: chrome.runtime.getManifest().version });
});

function send(port, message) {
  try {
    port.postMessage(message);
  } catch {
    appPorts.delete(port);
  }
}

function reply(port, requestId, data) {
  if (!requestId) return;
  send(port, { type: 'reply', requestId, data });
}

async function handleAppMessage(port, message) {
  if (!message || typeof message !== 'object') return;
  const { type } = message;

  try {
    switch (type) {
      case 'ping':
        send(port, { type: 'pong', version: chrome.runtime.getManifest().version });
        return;

      case 'run':
        await startRun(port, message.payload);
        return;

      case 'abort':
        abortRun(message.runId);
        return;

      case 'open-provider-tab': {
        const result = await openProviderTab(message.providerId, { active: Boolean(message.active) });
        reply(port, message.requestId, { ok: true, ...result });
        return;
      }

      case 'check-provider': {
        const result = await checkProvider(message.providerId);
        reply(port, message.requestId, result);
        return;
      }

      case 'reset-provider-chats': {
        const stored = await chrome.storage.local.get(['settings']);
        const models = (stored.settings && stored.settings.models) || [];
        // Only tab-mode models have a tab whose conversation can be reset.
        const providerIds = models
          .filter((model) => model.mode !== MODE_API && model.mode !== MODE_EMBED)
          .map((model) => model.providerId);
        const touched = await resetProviderChats(providerIds);
        reply(port, message.requestId, { ok: true, touched: touched.length });
        return;
      }

      case 'embed-status': {
        const status = await describeEmbedFrame(message.modelId);
        reply(port, message.requestId, status);
        return;
      }

      case 'embed-rules': {
        const count = await embedRuleCount();
        reply(port, message.requestId, { ok: true, rules: count });
        return;
      }

      case 'test-api': {
        const model = await loadModel(message.modelId);
        if (!model) {
          reply(port, message.requestId, { ok: false, message: 'That model is no longer configured.' });
          return;
        }
        const result = await testApiModel(model);
        reply(port, message.requestId, result);
        return;
      }

      default:
        return;
    }
  } catch (error) {
    if (message.requestId) {
      reply(port, message.requestId, { ok: false, message: error?.message || String(error) });
    } else {
      send(port, { type: 'log', message: `command ${type} failed: ${error?.message || error}` });
    }
  }
}

/* ────────────────────────────── content bridge ────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('MULTICHAI_')) {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'MULTICHAI_RESULT' || message.type === 'MULTICHAI_PROGRESS') {
    handleBridgeMessage(message);
  } else if (message.type === 'MULTICHAI_HELLO') {
    handleHello(message, sender);
  }

  sendResponse({ ok: true });
  return false;
});

/* ────────────────────────────── runs ────────────────────────────── */

async function loadModel(modelId) {
  const stored = await chrome.storage.local.get(['settings', 'apiKeys']);
  const settings = stored.settings || { models: [] };
  const apiKeys = stored.apiKeys || {};
  const model = (settings.models || []).find((entry) => entry.id === modelId) || null;
  if (!model) return null;
  const provider = PROVIDERS[model.providerId] || null;
  return { model, provider, apiKey: apiKeys[modelId] || '', settings };
}

/** Turn the page's conversation history into per-model prompt/answer pairs. */
function historyFor(history, modelId) {
  return (history || []).map((turn) => ({
    prompt: turn.prompt || '',
    answer: (turn.answers && turn.answers[modelId]) || '',
  }));
}

function abortRun(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  for (const controller of run.controllers.values()) {
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  }
}

async function startRun(port, payload) {
  const { runId, prompt = '', attachments = [], modelIds = [], history = [], recaps = {} } = payload || {};
  if (!runId || !Array.isArray(modelIds) || !modelIds.length) return;

  const stored = await chrome.storage.local.get(['settings']);
  const timeoutSec = Math.max(
    30,
    Number((stored.settings && stored.settings.timeoutSec) || DEFAULT_TIMEOUT_SEC),
  );
  const timeoutMs = timeoutSec * 1000;

  const controllers = new Map();
  activeRuns.set(runId, { controllers });

  const post = (message) => send(port, { ...message, runId });

  const tasks = modelIds.map(async (modelId) => {
    const loaded = await loadModel(modelId);
    if (!loaded || !loaded.provider) {
      post({
        type: 'error',
        modelId,
        message: 'This model is no longer configured.',
        hint: 'Add it again in Settings → Models.',
      });
      return;
    }

    const { model, provider, apiKey } = loaded;
    const controller = new AbortController();
    controllers.set(modelId, controller);
    const startedAt = Date.now();

    try {
      if (model.mode === MODE_API) {
        post({ type: 'run-status', modelId, status: 'started', detail: 'Contacting the API…' });
        /*
         * An API call has no page to watch, so the only bound on it is this
         * timer. Without it a stalled socket keeps the run (and the Stop button)
         * alive indefinitely; the app has a deadline too, but reporting a real
         * timeout is more useful than "stop".
         */
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        try {
          const text = await runApiModel({
            model,
            provider,
            apiKey,
            prompt,
            attachments,
            history: historyFor(history, modelId),
            signal: controller.signal,
            onDelta: (partial) => {
              if (controller.signal.aborted) return;
              post({ type: 'delta', modelId, text: partial });
            },
          });
          post({ type: 'final', modelId, text, ms: Date.now() - startedAt });
          return;
        } catch (error) {
          if (!timedOut) throw error;
          const timeout = new Error(
            `${provider.label} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
          );
          timeout.hint = 'The model may be slow or rate-limited. Ask again, or use a different model.';
          throw timeout;
        } finally {
          clearTimeout(timer);
        }
      }

      const progress = (text, phase) => {
        if (phase === 'typing') {
          post({ type: 'run-status', modelId, status: 'started', detail: 'Typing the prompt…' });
          return;
        }
        if (phase === 'waiting') {
          post({ type: 'run-status', modelId, status: 'started', detail: 'Waiting for the answer…' });
          return;
        }
        if (text) post({ type: 'delta', modelId, text });
      };

      if (model.mode === MODE_EMBED) {
        post({ type: 'run-status', modelId, status: 'started', detail: 'Sending to the embedded chat…' });
        const result = await runEmbedModel({
          model,
          provider,
          prompt,
          recap: (recaps && recaps[modelId]) || '',
          attachments,
          timeoutMs,
          signal: controller.signal,
          onProgress: progress,
        });
        post({
          type: 'final',
          modelId,
          text: result.text || '',
          ms: Date.now() - startedAt,
          stop: Boolean(result.stopped),
          captured: result.captured !== false,
          // Rendered answer (HTML), so history can show it without a page load.
          html: result.html || '',
        });
        return;
      }

      post({ type: 'run-status', modelId, status: 'started', detail: 'Sending to the model tab…' });
      const result = await runWebModel({
        model,
        provider,
        prompt,
        attachments,
        timeoutMs,
        signal: controller.signal,
        onProgress: progress,
      });
      post({
        type: 'final',
        modelId,
        text: result.text || '',
        ms: Date.now() - startedAt,
        stop: Boolean(result.stopped),
        html: result.html || '',
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        post({
          type: 'final',
          modelId,
          text: error.partialText || '',
          ms: Date.now() - startedAt,
          stop: true,
        });
        return;
      }
      post({
        type: 'error',
        modelId,
        message: error?.message || String(error),
        hint: error?.hint || null,
      });
    }
  });

  try {
    await Promise.allSettled(tasks);
  } finally {
    activeRuns.delete(runId);
  }
}
