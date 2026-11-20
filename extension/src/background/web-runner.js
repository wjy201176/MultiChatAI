/**
 * Browser-session execution: drive a provider page with the user's own login.
 *
 * Two transports, one protocol:
 *
 *   embed — the provider's chat page is framed inside a column of the app
 *           (free web chat, no API key). The content-script bridge inside that
 *           frame answers; the worker targets it with `frameId`.
 *   tab   — the provider page is a normal tab the user opened; the bridge in its
 *           top frame answers.
 *
 * Nothing here ever creates a tab or a window: `embed` frames are rendered by
 * the app page, and `tab` mode only uses tabs that already exist.
 */

import { getProvider } from '../shared/providers.js';
import {
  createBridgeRunId,
  expectBridgeRun,
  forgetBridgeRun,
  settleBridgeRun,
} from './bridge-hub.js';

const BRIDGE_READY_TIMEOUT = 25000;
const EMBED_PING_TIMEOUT = 6000;

/** modelId → { tabId, frameId, at } for iframes embedded in the app page. */
const embedFrames = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ───────────────────────────── frame registry ───────────────────────────── */

/** Called when a bridge inside an embedded column announces itself. */
export function registerEmbedFrame(modelId, tabId, frameId) {
  if (!modelId || typeof tabId !== 'number' || typeof frameId !== 'number') return;
  embedFrames.set(modelId, { tabId, frameId, at: Date.now() });
}

export function forgetEmbedFrame(modelId) {
  embedFrames.delete(modelId);
}

export function embedFrameFor(modelId) {
  return embedFrames.get(modelId) || null;
}

/**
 * Probe one embedded panel: is its bridge alive, and is the user signed in there?
 * @returns {Promise<{ready: boolean, signedIn: boolean, host: string}>}
 */
export async function describeEmbedFrame(modelId) {
  const frame = embedFrameFor(modelId);
  if (!frame) return { ready: false, signedIn: false, host: '' };
  const ping = await pingFrame(frame.tabId, frame.frameId, 3000);
  if (!ping) {
    forgetEmbedFrame(modelId);
    return { ready: false, signedIn: false, host: '' };
  }
  return {
    ready: true,
    signedIn: Boolean(ping.signedIn),
    hasComposer: Boolean(ping.hasComposer),
    // A hidden column (saved copy shown) measures 0×0 inside the frame: that is not
    // “the site refuses to be framed”, so the app is told whether it is on screen.
    visible: ping.visible !== false,
    host: ping.host || '',
  };
}

/** Send a probe to one frame; null when it is gone. */
async function pingFrame(tabId, frameId, timeoutMs = EMBED_PING_TIMEOUT) {
  try {
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'MULTICHAI_PING' }, { frameId }),
      sleep(timeoutMs).then(() => null),
    ]);
    return reply || null;
  } catch {
    return null;
  }
}

/* ───────────────────────────── tab discovery ───────────────────────────── */

export async function findProviderTabs(provider) {
  if (!provider || !provider.web) return [];
  try {
    const tabs = await chrome.tabs.query({ url: provider.web.urlPatterns });
    return tabs.filter((tab) => typeof tab.id === 'number');
  } catch {
    return [];
  }
}

/** Open (or focus) the provider's own site — only on an explicit user action. */
export async function openProviderTab(providerId, { active = false } = {}) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  if (!provider.web) {
    const tab = await chrome.tabs.create({ url: provider.homeUrl, active });
    return { tabId: tab.id, created: true, apiOnly: true };
  }

  const [existing] = await findProviderTabs(provider);
  if (!existing) {
    const tab = await chrome.tabs.create({ url: provider.homeUrl, active });
    return { tabId: tab.id, created: true, apiOnly: false };
  }

  if (active) {
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    if (typeof existing.windowId === 'number') {
      await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
  }
  return { tabId: existing.id, created: false, apiOnly: false };
}

/** One probe to a tab's top frame. Returns null when no bridge is listening. */
async function pingBridge(tabId) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'MULTICHAI_PING' });
    return reply || null;
  } catch {
    return null;
  }
}

async function waitForBridge(tabId, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const reply = await pingBridge(tabId);
    if (reply && reply.ready) return reply;
    if (Date.now() - started > timeoutMs) return null;
    await sleep(350);
  }
}

/**
 * Does the provider tab exist, is the bridge alive, and is the user signed in?
 * @returns {Promise<{ok: boolean, signedIn: boolean, message: string}>}
 */
export async function checkProvider(providerId) {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, signedIn: false, message: 'Unknown provider.' };
  if (!provider.web) {
    return { ok: false, signedIn: false, message: `${provider.label} is API-only in MultiChatAI.` };
  }

  const [tab] = await findProviderTabs(provider);
  if (!tab) {
    return {
      ok: false,
      signedIn: false,
      message: `No ${provider.label} tab is open — the embedded panel does not need one.`,
    };
  }

  const ping = await waitForBridge(tab.id, 4000);
  if (!ping) {
    return {
      ok: false,
      signedIn: false,
      message: 'The tab is open but the page has not loaded its chat UI yet.',
    };
  }

  return ping.signedIn
    ? { ok: true, signedIn: true, message: `Signed in · ${provider.label}` }
    : { ok: true, signedIn: false, message: 'Tab open, not signed in — sign in there, then check again.' };
}

/* ───────────────────────────── prompt dispatch ───────────────────────────── */

/**
 * Send one prompt to a bridge (tab top frame or embedded frame) and stream the
 * answer back through the bridge hub.
 *
 * @param {Object} options
 * @param {any} options.provider
 * @param {number} options.tabId
 * @param {number|undefined} options.frameId  undefined → the tab's top frame
 * @param {string} options.prompt
 * @param {Array} options.attachments
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @param {(text: string, phase: string) => void} [options.onProgress]
 * @param {string} [options.endpoint] human label for error messages
 * @returns {Promise<{text: string, stopped?: boolean}>}
 */
async function dispatchRun({
  provider,
  tabId,
  frameId,
  prompt,
  attachments,
  timeoutMs,
  signal,
  onProgress,
  endpoint,
}) {
  const bridgeRunId = createBridgeRunId();
  /** @type {{resolve: Function, reject: Function}} */
  let handlers = { resolve: () => {}, reject: () => {} };

  const answerPromise = new Promise((resolve, reject) => {
    handlers = { resolve, reject };
    expectBridgeRun(bridgeRunId, {
      resolve,
      reject,
      onProgress: (text, phase) => onProgress?.(text, phase),
    });
  });

  const sendToTarget = (message) =>
    frameId === undefined
      ? chrome.tabs.sendMessage(tabId, message)
      : chrome.tabs.sendMessage(tabId, message, { frameId });

  const abortHandler = () => {
    sendToTarget({ type: 'MULTICHAI_ABORT', runId: bridgeRunId }).catch(() => {});
    // Let the page click its own Stop button and report partial text first.
    setTimeout(() => settleBridgeRun(bridgeRunId, ''), 1500);
  };

  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }

  const guard = setTimeout(() => {
    forgetBridgeRun(bridgeRunId);
    const error = new Error(`${provider.label} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    error.hint = 'The page adapter may need an update, or the model is still generating.';
    handlers.reject(error);
  }, timeoutMs + 8000);

  try {
    const reply = await sendToTarget({
      type: 'MULTICHAI_RUN',
      runId: bridgeRunId,
      prompt,
      attachments,
      timeoutMs,
    });

    if (!reply || !reply.accepted) {
      forgetBridgeRun(bridgeRunId);
      const error = new Error(`${provider.label} did not accept the prompt${endpoint ? ` (${endpoint})` : ''}.`);
      error.hint = 'Reload that panel once, then press Send again.';
      throw error;
    }

    return await answerPromise;
  } finally {
    clearTimeout(guard);
    forgetBridgeRun(bridgeRunId);
    if (signal) signal.removeEventListener?.('abort', abortHandler);
  }
}

/* ───────────────────────────── embedded panels ───────────────────────────── */

/**
 * Send a prompt into a provider page that is framed inside a column.
 *
 * @param {Object} options
 * @param {any} options.model
 * @param {any} options.provider
 * @param {string} options.prompt
 * @param {Array} options.attachments
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @param {(text: string, phase: string) => void} [options.onProgress]
 * @returns {Promise<{text: string, stopped?: boolean}>}
 */
export async function runEmbedModel({
  model,
  provider,
  prompt,
  recap = '',
  attachments = [],
  timeoutMs,
  signal,
  onProgress,
}) {
  if (!provider.web) {
    throw new Error(`${provider.label} cannot be embedded.`);
  }

  let frame = embedFrameFor(model.id);
  if (!frame) {
    // The iframe may have just been (re)mounted: give it a moment.
    const started = Date.now();
    while (!frame && Date.now() - started < 8000) {
      await sleep(300);
      frame = embedFrameFor(model.id);
    }
  }

  if (!frame) {
    const error = new Error(`The ${provider.label} panel has not loaded yet.`);
    error.hint = `Reload the panel (⟳ in the column header) — or use “Open in tab” once to sign in, then reload.`;
    throw error;
  }

  const ping = await pingFrame(frame.tabId, frame.frameId);
  if (!ping) {
    forgetEmbedFrame(model.id);
    const error = new Error(`The ${provider.label} panel stopped responding.`);
    error.hint = 'Reload the panel (⟳ in the column header) and press Send again.';
    throw error;
  }

  if (!ping.hasComposer) {
    const error = new Error(`${provider.label} is not showing a usable chat inside the panel.`);
    error.hint = 'Some sites refuse to be framed. Press “Use a tab instead” (one click) or switch this model to API-key mode.';
    throw error;
  }

  if (!ping.signedIn) {
    const error = new Error(`${provider.label} is showing a sign-in screen inside the panel.`);
    error.hint = 'Sign in inside that column (or press “Open in tab” once, then ⟳), then press Send again.';
    throw error;
  }

  onProgress?.('', 'typing');
  // The framed page may be a fresh thread (it was just reopened), so carry the
  // previous exchange along instead of losing the topic.
  const promptToType = recap
    ? `Earlier in this conversation:\n${recap}\n\n---\n\n${prompt}`
    : prompt;
  return dispatchRun({
    provider,
    tabId: frame.tabId,
    frameId: frame.frameId,
    prompt: promptToType,
    attachments,
    timeoutMs,
    signal,
    onProgress,
    endpoint: 'embedded panel',
  });
}

/* ───────────────────────────── provider tabs ───────────────────────────── */

/**
 * Send one prompt to a provider tab the user already has open.
 *
 * @param {Object} options
 * @param {any} options.model
 * @param {any} options.provider
 * @param {string} options.prompt
 * @param {Array} options.attachments
 * @param {number} options.timeoutMs
 * @param {AbortSignal} [options.signal]
 * @param {(text: string, phase: string) => void} [options.onProgress]
 * @returns {Promise<{text: string, stopped?: boolean}>}
 */
export async function runWebModel({
  model,
  provider,
  prompt,
  attachments = [],
  timeoutMs,
  signal,
  onProgress,
}) {
  if (!provider.web) {
    throw new Error(`${provider.label} cannot be driven through its web app.`);
  }

  const [tab] = await findProviderTabs(provider);
  if (!tab) {
    const error = new Error(`No ${provider.label} tab is open.`);
    error.hint = `This model is set to “existing tab”. Open ${provider.homeUrl} once and keep it open, switch the model to “embedded”, or use API-key mode.`;
    throw error;
  }

  onProgress?.('', 'waiting');
  const ping = await waitForBridge(tab.id, BRIDGE_READY_TIMEOUT);
  if (!ping) {
    const error = new Error(`The ${provider.label} tab is open but its chat UI is not ready.`);
    error.hint = 'Bring that tab to the front, make sure you can chat there, then press Send again.';
    throw error;
  }

  if (!ping.signedIn) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    const error = new Error(`You are not signed in to ${provider.label}.`);
    error.hint = 'That tab was brought to the front — sign in, then press Send again.';
    throw error;
  }

  return dispatchRun({
    provider,
    tabId: tab.id,
    frameId: undefined,
    prompt,
    attachments,
    timeoutMs,
    signal,
    onProgress,
    endpoint: 'tab',
  });
}

/**
 * Navigate the managed provider tabs back to their "new chat" screen.
 * Only touches tabs that match a provider host — never the user's other tabs.
 */
export async function resetProviderChats(providerIds) {
  const touched = [];
  for (const providerId of new Set(providerIds || [])) {
    const provider = getProvider(providerId);
    if (!provider || !provider.web) continue;
    const tabs = await findProviderTabs(provider);
    for (const tab of tabs) {
      /*
       * Press the site's own “New chat” first. Navigating the tab would reload
       * the page — cookie banner, sign-in flash, lost scroll — just to start a
       * thread; the button does it in place. Navigation stays as the fallback for
       * pages whose control the adapter cannot find.
       */
      const clicked = await chrome.tabs
        .sendMessage(tab.id, { type: 'MULTICHAI_NEW_CHAT' })
        .catch(() => null);
      if (!clicked || !clicked.ok) {
        await chrome.tabs.update(tab.id, { url: provider.homeUrl }).catch(() => {});
      }
      touched.push({ providerId, tabId: tab.id });
    }
  }
  return touched;
}
