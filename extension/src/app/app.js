/**
 * MultiChatAI — extension page controller.
 *
 * Responsibilities:
 *   - boot: load state, render sidebar/board, connect to the service worker
 *   - send a prompt to every enabled model at once (one turn in the transcript)
 *   - consume streaming events from the background and paint the columns
 *   - persist conversations and render history
 *
 * The board is only re-rendered between runs; during a run the columns are
 * patched in place so scrolling and in-flight markdown stay intact.
 */

import {
  getProvider,
  MODE_API,
  MODE_EMBED,
  MODE_WEB,
  threadUrlFor,
} from '../shared/providers.js';
import * as store from './state.js';
import { panelVerdict, runDeadline } from './run-policy.js';
import { buildSummaryPrompt, summaryCopyText } from './summary-request.js';
import { renderMarkdown } from './markdown.js';
import { ColumnBoard } from './views/columns.js';
import { renderSidebar } from './views/sidebar.js';
import { SettingsView } from './views/settings.js';
import {
  autoGrow,
  copyText,
  debounce,
  escapeHtml,
  formatBytes,
  formatClock,
  formatHistoryTime,
  throttle,
  toast,
  topicFromPrompt,
  uid,
} from './util.js';

const MAX_ATTACHMENTS = 8;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

const dom = {
  appRoot: /** @type {HTMLElement} */ (document.getElementById('app-root')),
  viewChat: /** @type {HTMLElement} */ (document.getElementById('view-chat')),
  viewSettings: /** @type {HTMLElement} */ (document.getElementById('view-settings')),
  historyList: /** @type {HTMLElement} */ (document.getElementById('history-list')),
  historyCount: /** @type {HTMLElement} */ (document.getElementById('history-count')),
  sidebarModelList: /** @type {HTMLElement} */ (document.getElementById('sidebar-model-list')),
  addModelShortcut: /** @type {HTMLElement} */ (document.getElementById('add-model-shortcut')),
  newChatBtn: /** @type {HTMLElement} */ (document.getElementById('new-chat')),
  settingsBtn: /** @type {HTMLElement} */ (document.getElementById('settings-btn')),
  settingsBack: /** @type {HTMLElement} */ (document.getElementById('settings-back')),
  settingsNav: /** @type {HTMLElement} */ (document.getElementById('settings-nav')),
  settingsBody: /** @type {HTMLElement} */ (document.getElementById('settings-body')),
  titleEl: /** @type {HTMLElement} */ (document.getElementById('conversation-title')),
  metaEl: /** @type {HTMLElement} */ (document.getElementById('conversation-meta')),
  headActions: /** @type {HTMLElement} */ (document.querySelector('.main-head-actions')),
  stopBtn: /** @type {HTMLElement} */ (document.getElementById('stop-btn')),
  columnsScroll: /** @type {HTMLElement} */ (document.getElementById('columns-scroll')),
  columns: /** @type {HTMLElement} */ (document.getElementById('columns')),
  emptyState: /** @type {HTMLElement} */ (document.getElementById('empty-state')),
  emptyOpenSettings: /** @type {HTMLElement} */ (document.getElementById('empty-open-settings')),
  prompt: /** @type {HTMLTextAreaElement} */ (document.getElementById('prompt')),
  sendBtn: /** @type {HTMLButtonElement} */ (document.getElementById('send-btn')),
  summarizeBtn: /** @type {HTMLButtonElement} */ (document.getElementById('summarize-btn')),
  summaryPanel: /** @type {HTMLElement} */ (document.getElementById('summary-panel')),
  summarySub: /** @type {HTMLElement} */ (document.getElementById('summary-sub')),
  summaryBodyEl: /** @type {HTMLElement} */ (document.getElementById('summary-body')),
  summaryScope: /** @type {HTMLElement} */ (document.getElementById('summary-scope')),
  summaryCopy: /** @type {HTMLButtonElement} */ (document.getElementById('summary-copy')),
  summaryAgain: /** @type {HTMLButtonElement} */ (document.getElementById('summary-again')),
  summaryStop: /** @type {HTMLButtonElement} */ (document.getElementById('summary-stop')),
  summaryModelChip: /** @type {HTMLElement} */ (document.getElementById('summarize-model-chip')),
  summaryModelSelect: /** @type {HTMLSelectElement} */ (document.getElementById('summarize-model')),
  summaryClose: /** @type {HTMLElement} */ (document.getElementById('summary-close')),
  fileInput: /** @type {HTMLInputElement} */ (document.getElementById('file-input')),
  attachmentsEl: /** @type {HTMLElement} */ (document.getElementById('attachments')),
};

/** @type {Array<{id:string,name:string,type:string,size:number,kind:'text'|'image',text?:string,dataUrl?:string}>} */
let attachments = [];
/** @type {ColumnBoard|null} */
let board = null;
/** @type {SettingsView|null} */
let settingsView = null;
/** @type {chrome.runtime.Port|null} */
let port = null;
/** @type {Map<string, {resolve: Function, reject: Function}>} */
const pendingCalls = new Map();
/**
 * @type {{runId:string, conv:any, turn:any, pending:Set<string>,
 *         meta:Map<string, any>, startedAt:number}|null}
 */
let activeRun = null;
/** The run that just ended, so a late `final` can still deliver its rendered HTML. */
let lastRun = null;

const persistSoon = debounce(() => {
  if (activeRun) void store.persistConversation(activeRun.conv);
}, 900);

/* ────────────────────────────── background link ────────────────────────────── */

function connect() {
  try {
    port = chrome.runtime.connect({ name: 'multichat-app' });
  } catch (error) {
    port = null;
    setTimeout(connect, 800);
    return;
  }
  port.onMessage.addListener(handleBackgroundMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const entry of pendingCalls.values()) entry.reject(new Error('Background was reloaded.'));
    pendingCalls.clear();
    if (activeRun) onBackgroundLost();
    setTimeout(connect, 700);
  });
  port.postMessage({ type: 'ping' });
}

/**
 * The worker went away while a run was in flight: its run registry is gone, so
 * no `final` will ever arrive for the models still pending.
 *
 * Embedded panels keep working on their own (they are the provider's own page),
 * so they get a short extra window and are settled by their readiness reports.
 * Everything else is reported straight away instead of leaving Stop on screen.
 */
function onBackgroundLost() {
  if (!activeRun) return;
  const now = Date.now();
  for (const [modelId, info] of [...activeRun.meta]) {
    const record = board?.columns.get(modelId);
    if (record && record.embedded) {
      info.deadlineAt = Math.min(info.deadlineAt, now + 30000);
      continue;
    }
    finalizeModel(modelId, {
      status: 'error',
      message: 'The extension background restarted before this answer arrived.',
      hint: 'Press Send again to ask this model the question once more.',
    });
  }
}

function bgSend(message) {
  if (!port) connect();
  try {
    port.postMessage(message);
  } catch {
    port = null;
    setTimeout(() => bgSend(message), 400);
  }
}

/** Request/response over the port, keyed by requestId. */
function bgCall(message, timeoutMs = 30000) {
  const requestId = uid('req');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(requestId);
      reject(new Error('No answer from the extension background. Reload the page and retry.'));
    }, timeoutMs);
    pendingCalls.set(requestId, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    bgSend({ ...message, requestId });
  });
}

function handleBackgroundMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  /*
   * A summary is a run of its own: one model, not the board. Its messages share
   * the run vocabulary, so they are routed by run id before anything else — that
   * way a summary can never paint a column or unsettle a real round.
   */
  if (summary.runId && msg.runId === summary.runId) {
    if (msg.type === 'run-status') onSummaryStatus(msg);
    else if (msg.type === 'delta') onSummaryDelta(msg);
    else if (msg.type === 'final') onSummaryFinal(msg);
    else if (msg.type === 'error') onSummaryError(msg);
    return;
  }

  switch (msg.type) {
    case 'reply': {
      const entry = pendingCalls.get(msg.requestId);
      if (entry) {
        pendingCalls.delete(msg.requestId);
        entry.resolve(msg.data ?? null);
      }
      break;
    }
    case 'run-status':
      onRunStatus(msg);
      break;
    case 'delta':
      onDelta(msg);
      break;
    case 'final':
      onFinal(msg);
      break;
    case 'error':
      onRunError(msg);
      break;
    case 'log':
      console.debug('[MultiChatAI]', msg.message);
      break;
    case 'embed-status':
      noteEmbedStatus(
        msg.modelId,
        Boolean(msg.ready),
        Boolean(msg.signedIn),
        msg.hasComposer !== false,
        msg.visible !== false,
      );
      break;
    default:
      break;
  }
}

/* ────────────────────────────── run lifecycle ────────────────────────────── */

/** modelId → the last state an embedded panel pushed (see MULTICHAI_STATE). */
const frameState = new Map();
/** modelId → verdict of the last finished run, so status polls cannot overwrite it. */
const runPillState = new Map();

function currentAnswer(modelId) {
  if (!activeRun) return null;
  return activeRun.turn.answers[modelId] || null;
}

function runMeta(modelId) {
  if (!activeRun) return null;
  return activeRun.meta.get(modelId) || null;
}

/**
 * Settle one model of the run that is in flight. Idempotent — the first caller
 * wins — and every path funnels through here: a `final` from the worker, the
 * panel saying “I am ready for the next question”, the Stop button, or the
 * deadline. That is why the column status and the transcript cannot disagree.
 *
 * @param {string} modelId
 * @param {{status:'done'|'panel'|'stopped'|'timeout'|'error', text?:string, ms?:number,
 *          message?:string, hint?:string}} outcome
 */
function finalizeModel(modelId, outcome) {
  const run = activeRun;
  if (!run || !run.pending.has(modelId)) return;
  run.pending.delete(modelId);
  run.meta.delete(modelId);

  // The provider's own link to this conversation (kept per turn so opening the
  // history can reload the real thread, not just our text copy).
  const threadUrl = (frameState.get(modelId) || {}).threadUrl || '';

  const answer = currentAnswer(modelId);
  const record = board?.columns.get(modelId);
  const embedded = Boolean(record && record.embedded);
  const status = String(outcome.status || 'done');
  const text = typeof outcome.text === 'string' ? outcome.text : undefined;
  const finishedAt = Date.now();
  const ms = Number.isFinite(outcome.ms)
    ? outcome.ms
    : answer
      ? finishedAt - (answer.startedAt || finishedAt)
      : null;

  if (answer) {
    if (text) answer.text = text;
    if (threadUrl) answer.threadUrl = threadUrl;
    // The rendered answer, replayed by history instead of a text-only copy.
    if (outcome.html) answer.html = String(outcome.html);
    answer.status = status === 'panel' ? 'done' : status;
    answer.error = status === 'error' ? outcome.message || 'Request failed' : '';
    answer.endedAt = finishedAt;
    answer.ms = ms;
    answer.note =
      status === 'panel'
        ? embedded
          ? 'Answered in the panel'
          : 'Answered in the page'
        : status === 'timeout'
          ? answer.text
            ? 'Partial answer'
            : 'No answer captured'
          : '';
  }

  runPillState.set(modelId, status);

  /*
   * Painting is wrapped: a broken column must never keep the run (and the
   * composer) hostage. The bookkeeping above already happened, so the run still
   * finishes even if a DOM call throws.
   */
  try {
    if (status === 'done' || status === 'panel') {
      board?.finish(modelId, text || '', ms);
      if (!text) {
        board?.setStatus(modelId, 'done', embedded ? 'Answered in the panel' : 'Answered in the page');
      }
    } else if (status === 'stopped') {
      board?.finish(modelId, text || '', ms);
      board?.setStatus(
        modelId,
        'aborted',
        text ? 'Stopped' : embedded ? 'Stopped · answer stays in the panel' : 'Stopped · no answer',
      );
    } else if (status === 'timeout') {
      board?.setStatus(modelId, 'timeout', text ? 'Partial answer' : 'No answer captured');
      if (embedded && !text) {
        board?.setEmbedNotice(
          modelId,
          'This panel never said it was finished. It may still be generating — ask again when it is.',
        );
      }
    } else {
      board?.fail(modelId, outcome.message || 'Request failed', outcome.hint || null);
    }
  } catch (error) {
    console.warn('[MultiChatAI] could not paint the column:', error);
  }

  updateComposerState();
  if (!activeRun.pending.size) void endRun();

  // One line per settled browser-session answer: history is only as rich as this
  // capture, so it should be visible in the console when it comes back empty.
  if (embedded && status !== 'error') {
    const captured = answer && answer.html ? `${Math.round(answer.html.length / 1024)} KB of HTML` : 'text only';
    console.info(`[MultiChatAI] ${record.descriptor.name}: history copy captured (${captured})`);
  }
}

function onRunStatus(msg) {
  if (!activeRun || msg.runId !== activeRun.runId) return;
  if (!activeRun.pending.has(msg.modelId)) return;
  const started = msg.status === 'started';
  board?.setStatus(
    msg.modelId,
    started ? 'streaming' : 'pending',
    msg.detail || (started ? 'Waiting for reply…' : 'Opening model…'),
  );
}

function onDelta(msg) {
  if (!activeRun || msg.runId !== activeRun.runId) return;
  if (!activeRun.pending.has(msg.modelId)) return;
  const answer = currentAnswer(msg.modelId);
  if (answer) {
    answer.text = msg.text || answer.text;
    answer.status = 'streaming';
  }
  const info = runMeta(msg.modelId);
  if (info) {
    info.textSeen = true;
    info.readyStreak = 0;
  }
  board?.setText(msg.modelId, msg.text || '', true);
  board?.setStatus(msg.modelId, 'streaming', 'Streaming…');
  persistSoon();
}

function onFinal(msg) {
  if (!activeRun || msg.runId !== activeRun.runId) {
    acceptLateHtml(msg);
    return;
  }
  if (msg.captured === false && !msg.stop) {
    finalizeModel(msg.modelId, { status: 'panel', text: '', ms: msg.ms, html: msg.html });
    return;
  }
  finalizeModel(msg.modelId, {
    status: msg.stop ? 'stopped' : 'done',
    text: msg.text || '',
    ms: msg.ms,
    html: msg.html,
  });
}

/**
 * The app can settle a column from the panel's own readiness report, a moment
 * before the worker's `final` arrives. That late message still carries the
 * rendered answer — keep it, or history would have only the text.
 */
function acceptLateHtml(msg) {
  const run = lastRun;
  if (!run || !msg || msg.runId !== run.runId || !msg.html) return;
  if (Date.now() - run.at > 120000) return;
  const answer = run.turn.answers ? run.turn.answers[msg.modelId] : null;
  if (!answer || answer.html) return;
  answer.html = String(msg.html);
  void store.persistConversation(run.conv);
}

function onRunError(msg) {
  if (!activeRun || msg.runId !== activeRun.runId) return;
  finalizeModel(msg.modelId, {
    status: 'error',
    message: msg.message || 'Request failed',
    hint: msg.hint || null,
  });
}

async function endRun() {
  const run = activeRun;
  activeRun = null;
  setRunning(false);
  if (!run) return;
  lastRun = { runId: run.runId, conv: run.conv, turn: run.turn, at: Date.now() };
  await store.persistConversation(run.conv);
  // Deliberately no renderBoard() here: the run is over, the columns already show
  // their answers, and rebuilding would reload every embedded page. Model-list
  // edits update the board on their own (see the settings actions).
  renderHeader();
  renderSidebarNow();
}

/** Composer is only usable when at least one model is selected and no run is in flight. */
function updateComposerState() {
  const models = store.enabledModels();
  const hasModels = models.length > 0;
  const running = Boolean(activeRun);
  const waiting = running ? activeRun.pending.size : 0;

  dom.prompt.disabled = !hasModels;
  dom.fileInput.disabled = !hasModels;
  dom.sendBtn.disabled = !hasModels || running;
  dom.sendBtn.setAttribute('aria-disabled', dom.sendBtn.disabled ? 'true' : 'false');

  /*
   * Summarize reads text that already exists, so it waits for exactly that: some
   * answer with words in it. It is refused mid-run, because a summary of half an
   * answer is worse than no summary.
   */
  const conv = store.activeConversation();
  const hasText = Boolean(
    conv &&
      conv.turns.some((entry) =>
        Object.values(entry.answers || {}).some((answer) => String((answer && answer.text) || '').trim()),
      ),
  );
  dom.summarizeBtn.disabled = !hasModels || running || !hasText;
  dom.summarizeBtn.setAttribute('aria-pressed', summary.open ? 'true' : 'false');
  dom.summarizeBtn.title = !hasModels
    ? 'Add a model first'
    : running
      ? 'Wait for the answers to finish, then summarise'
      : !hasText
        ? 'Ask something first — there is nothing to summarise yet'
        : summary.open
          ? 'Close the summary'
          : 'Summarise: what every model agrees on, then a table of where they differ';

  const box = dom.prompt.closest('.composer-box');
  if (box) box.classList.toggle('is-locked', !hasModels);

  // The Stop button always says how many answers are still outstanding, so it is
  // obvious when it should have gone away.
  const stopLabel = dom.stopBtn.querySelector('span');
  if (stopLabel) stopLabel.textContent = waiting > 1 ? `Stop (${waiting})` : 'Stop';

  // Full-width view of one column: say so, because Send still asks every model.
  const focusedName = board?.focusedKey
    ? (board.columns.get(board.focusedKey) || {}).descriptor?.name || 'one model'
    : '';

  dom.prompt.placeholder = !hasModels
    ? 'Please add a model in Settings → Models first…'
    : running
      ? waiting > 1
        ? `Waiting for ${waiting} of ${models.length} models… press Stop to cancel`
        : 'One model is still answering… press Stop to cancel'
      : summary.open
        ? `Summary by ${summarizerName(store.getModel(summary.modelId) || summarizerModel())} — Esc goes back; Send still asks every model`
        : focusedName
          ? `Full view: ${focusedName} — Return (or Esc) goes back; Send still asks every model`
          : 'Ask every selected model the same question…';
}

function setRunning(running) {
  dom.stopBtn.hidden = !running;
  updateComposerState();
}

/* ─────────────────── panel readiness & run watchdog ─────────────────── */

/**
 * A column's model id from a message source (the iframe window).
 * Identical iframes are matched by identity, never by URL.
 */
function columnKeyForSource(source) {
  if (!board || !source) return '';
  for (const [key, record] of board.columns) {
    if (record.iframe && record.iframe.contentWindow === source) return key;
  }
  return '';
}

/**
 * An embedded panel pushed its state: composer present? generating?
 *
 * The panel is the only part of the system that sees the provider page, so its
 * "ready for the next question" is the completion signal the user asked for — it
 * works even when the worker has been restarted and no `final` will ever arrive.
 */
function onFrameState(event) {
  const data = event && event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'MULTICHAI_STATE') return;
  const key = columnKeyForSource(event.source);
  if (!key) return;

  const record = board?.columns.get(key);
  const providerId = record ? record.descriptor.providerId : '';
  const state = {
    at: Date.now(),
    ready: data.ready === true,
    busy: data.busy === true,
    hasComposer: data.hasComposer === true,
    sendReady: data.sendReady === true,
    signedIn: data.signedIn === true,
    url: typeof data.url === 'string' ? data.url : '',
    // The provider's own link to this conversation, once it has one.
    threadUrl: threadUrlFor(providerId, data.url || ''),
    // Does the panel have a “New chat” control of its own (no reload needed)?
    canStartNewChat: data.canStartNewChat === true,
    visible: data.visible !== false,
    // The page itself says its realtime channel is blocked (Grok's WebSocket).
    blocked: data.blocked === true,
    styled: data.styled === true,
  };
  frameState.set(key, state);
  embedReady.add(key);

  const info = runMeta(key);
  if (info && state.threadUrl) info.threadUrl = state.threadUrl;

  maybeSettleFromPanel(key, state);

  if (state.blocked) {
    noteBlockedPanel(key);
    return;
  }

  if (!activeRun || !activeRun.pending.has(key)) {
    noteEmbedStatus(key, true, state.signedIn, state.hasComposer, state.visible);
  }
}

/**
 * A panel whose site reports its realtime link is blocked — Grok streams over a
 * WebSocket to its own server, and a network/security policy that blocks it makes
 * every send fail. Nothing in the extension can tunnel that; say what does work.
 */
function noteBlockedPanel(key) {
  const record = board?.columns.get(key);
  const name = record ? record.descriptor.name : 'This model';
  board?.setStatus(key, 'error', 'Realtime link blocked');
  board?.setEmbedNotice(
    key,
    `${name} streams over its own WebSocket, and that connection is blocked here — so sending cannot work in this panel. Use an API key for this model, or drive a tab you already have open (“Use a tab instead”).`,
    true,
  );
}

/** Turn a readiness report into a settle decision for a pending model. */
function maybeSettleFromPanel(key, state) {
  if (!activeRun || !activeRun.pending.has(key)) return;
  const info = runMeta(key);
  if (!info) return;

  if (state.busy) {
    info.busySeen = true;
    info.readyStreak = 0;
    return;
  }
  if (!state.ready) {
    info.readyStreak = 0;
    return;
  }
  info.readyStreak += 1;

  const answer = currentAnswer(key);
  const verdict = panelVerdict({
    ready: true,
    busy: false,
    readyStreak: info.readyStreak,
    elapsedMs: Date.now() - info.startedAt,
    busySeen: info.busySeen,
    textSeen: info.textSeen,
    haveText: Boolean(answer && answer.text),
  });
  if (verdict === 'wait') return;

  finalizeModel(key, {
    status: verdict === 'done' ? 'done' : 'panel',
    text: (answer && answer.text) || '',
  });
}

/** Settle models whose deadline passed — the guarantee that Stop cannot wedge. */
function checkDeadlines() {
  if (!activeRun) return;
  const now = Date.now();
  for (const [modelId, info] of [...activeRun.meta]) {
    if (now <= info.deadlineAt) continue;
    finalizeModel(modelId, {
      status: 'timeout',
      message: `No finished answer within ${Math.round((info.deadlineAt - info.startedAt) / 1000)}s.`,
      hint: 'The page may still be generating. Check that panel, then ask again or press ⟳.',
    });
  }
}

/**
 * Re-post the embed identity handshake. The worker's frame registry lives in
 * memory and vanishes when it restarts, so this heals it silently.
 */
function refreshIdentities() {
  if (!board) return;
  for (const [key, record] of board.columns) {
    if (!record.embedded || record.view === 'snapshot' || !record.mountedSrc) continue;
    board.mountEmbed(key, { src: record.mountedSrc, modelId: key });
  }
}

/**
 * 2 s tick: keep the worker awake during a run (MV3 evicts idle workers, which
 * would silently lose the run), heal the frame registry, and enforce deadlines.
 */
let tickCount = 0;
function tick() {
  tickCount += 1;
  const summaryRunning = summary.status === 'running';
  if (!activeRun && !summaryRunning) return;
  // The worker is evicted when idle, which would silently lose the run.
  if (tickCount % 5 === 0) bgSend({ type: 'ping' });
  if (tickCount % 5 === 0) refreshIdentities();
  if (activeRun) checkDeadlines();
  if (summaryRunning) checkSummaryDeadline();
}

/* ────────────────────────────── rendering ────────────────────────────── */

function applyTheme() {
  document.documentElement.dataset.theme = store.state.settings.theme === 'light' ? 'light' : 'dark';
}

function renderSidebarNow() {
  renderSidebar({
    listEl: dom.historyList,
    countEl: dom.historyCount,
    rows: store.state.index,
    activeId: store.state.activeId,
    onOpen: (id) => void openConversation(id),
    onDelete: (id) => void removeConversation(id),
  });
}

/** The compact model list at the bottom of the sidebar (above Settings). */
function renderSidebarModels() {
  const models = store.state.settings.models;
  if (!models.length) {
    dom.sidebarModelList.innerHTML =
      '<p class="sidebar-models-empty">No models yet — open Settings to add one.</p>';
    return;
  }

  dom.sidebarModelList.innerHTML = models
    .map((model) => {
      const provider = getProvider(model.providerId);
      const color = (provider && provider.color) || '#8b93a7';
      const label =
        model.mode === MODE_API && model.modelName
          ? `${model.label || (provider && provider.label) || model.providerId} · ${model.modelName}`
          : model.label || (provider && provider.label) || model.providerId;
      const state =
        model.enabled === false
          ? 'off'
          : model.mode === MODE_API
            ? 'api'
            : model.mode === MODE_EMBED
              ? 'embed'
              : 'tab';
      return `<button class="sidebar-model" type="button" data-model="${escapeHtml(model.id)}"
                title="${escapeHtml(label)} — click to edit">
        <span class="sidebar-model-dot" style="--dot:${escapeHtml(color)}"></span>
        <span class="sidebar-model-label">${escapeHtml(label)}</span>
        <span class="sidebar-model-mode">${state}</span>
      </button>`;
    })
    .join('');
}

function renderHeader() {
  const conv = store.activeConversation();
  const models = store.enabledModels();

  dom.titleEl.textContent = conv ? conv.title : 'New chat';

  if (!models.length) {
    dom.metaEl.textContent =
      'Please add a model in Settings → Models — the input box stays disabled until then.';
  } else if (!conv || !conv.turns.length) {
    dom.metaEl.textContent = `${models.length} model${
      models.length === 1 ? '' : 's'
    } ready — ask once, read all answers.`;
  } else {
    const turnIndex = store.visibleTurnIndex(conv);
    const turn = conv.turns[turnIndex];
    dom.metaEl.textContent = `Turn ${turnIndex + 1} of ${conv.turns.length} · ${formatHistoryTime(
      turn.createdAt,
    )} · ${models.length} model${models.length === 1 ? '' : 's'} selected`;
  }

  let picker = /** @type {HTMLSelectElement|null} */ (document.getElementById('turn-picker'));
  if (conv && conv.turns.length > 1) {
    if (!picker) {
      picker = document.createElement('select');
      picker.id = 'turn-picker';
      picker.className = 'turn-picker';
      picker.title = 'View an earlier turn';
      picker.addEventListener('change', () => {
        // Switching turns rebuilds the board, which would throw away the
        // in-flight streaming columns — so it is locked while a run is active.
        if (activeRun) {
          picker.value = String(store.visibleTurnIndex(store.activeConversation()));
          return;
        }
        store.state.viewTurn = Number(picker.value);
        renderHeader();
        // Showing a different turn changes the answers themselves, so this one
        // needs a full repaint rather than the surgical model-list sync.
        renderBoard({ rebuild: true });
        // An open summary is about the turn on the board: follow the picker.
        if (summary.open) renderSummary();
      });
      dom.headActions.insertBefore(picker, dom.stopBtn);
    }
    picker.disabled = Boolean(activeRun);
    picker.innerHTML = conv.turns
      .map(
        (turn, index) =>
          `<option value="${index}">Turn ${index + 1} · ${escapeHtml(formatClock(turn.createdAt))}</option>`,
      )
      .join('');
    picker.value = String(store.visibleTurnIndex(conv));
  } else if (picker) {
    picker.remove();
  }

  // The summariser chip lives here too, so it follows the model list.
  updateSummaryPicker();
}

/** Column descriptors for the models selected right now (labels de-duplicated). */
function buildColumnDescriptors() {
  const descriptors = store
    .enabledModels()
    .map((model) => ColumnBoard.describe(model, getProvider(model.providerId)));

  // Adding the same provider twice would give two columns the same headline, so
  // duplicated providers are titled by model name and subtitled by provider.
  const nameCounts = new Map();
  for (const descriptor of descriptors) {
    nameCounts.set(descriptor.name, (nameCounts.get(descriptor.name) || 0) + 1);
  }
  for (const descriptor of descriptors) {
    if ((nameCounts.get(descriptor.name) || 0) < 2) continue;
    if (!descriptor.subtitle || descriptor.subtitle === 'browser session') continue;
    const provider = getProvider(descriptor.providerId);
    const providerLabel = provider ? provider.label : descriptor.providerId;
    descriptor.name = descriptor.subtitle;
    descriptor.subtitle = `${providerLabel} · ${descriptor.mode === MODE_API ? 'API' : 'web'}`;
  }
  return descriptors;
}

/**
 * Repaint the column board.
 *
 * - `rebuild: false` (default) reconciles in place: only the columns of removed
 *   or newly added models are touched, so the chat already on screen keeps its
 *   rendered answers and scroll position. This is what a model-list edit uses.
 * - `rebuild: true` throws the columns away and rebuilds them from the current
 *   turn (used when switching conversations or reloading the page).
 *
 * Either way the column set is exactly the models selected right now.
 */
function renderBoard({ rebuild = false } = {}) {
  if (!board) return;
  const conv = store.activeConversation();
  const turn = store.visibleTurn(conv);
  const descriptors = buildColumnDescriptors();

  if (rebuild) {
    board.render(descriptors);
    if (turn) board.showTurn(turn);
  } else {
    const created = board.sync(descriptors);
    if (turn) {
      board.showTurn(turn, created);
      for (const key of created) {
        const answer = turn.answers ? turn.answers[key] : null;
        if (!answer) board.setStatus(key, 'idle', 'No answer in this turn');
      }
    }
  }

  /*
   * Reopening a conversation: **use the model's own link** when one was recorded, so
   * the provider re-renders exactly what it produced — graphs, tables, artifacts,
   * images. That is a page load, which is the price of exactness (a framed site may
   * ask you to sign in again). Turns without a recorded link — signed out at the
   * time, or recorded before links existed — show the saved copy instead.
   */
  if (conv && conv.turns.length) {
    for (const descriptor of descriptors) {
      if (descriptor.mode !== MODE_EMBED) continue;
      const threadUrl = threadUrlForTurn(conv, turn, descriptor.key);
      /*
       * Loading the link only makes sense if the panel is actually signed in: a
       * signed-out Gemini just bounces to Google's login, which looks like “history
       * does nothing”. The panel reports its own state, so use it — and fall back to
       * the saved copy in that case.
       */
      const live = frameState.get(descriptor.key);
      const signedOut = Boolean(live && live.signedIn === false);
      if (threadUrl && !signedOut) board.restoreThread(descriptor.key, threadUrl);
      else board.showSnapshot(descriptor.key, conv.turns, threadUrl);
    }
  }

  mountEmbeds(descriptors);
  updateComposerState();
}

/**
 * The provider's own conversation link for the turn on show — or the newest one
 * this model reported, since older turns may predate link recording and the
 * provider's thread contains the whole conversation anyway.
 */
function threadUrlForTurn(conv, turn, modelId) {
  if (!conv) return '';
  const candidates = turn ? [turn] : [];
  for (let index = conv.turns.length - 1; index >= 0; index -= 1) {
    if (conv.turns[index] !== turn) candidates.push(conv.turns[index]);
  }
  for (const candidate of candidates) {
    const answer = candidate.answers ? candidate.answers[modelId] : null;
    if (answer && answer.threadUrl) return answer.threadUrl;
  }
  return '';
}

/** Short recap of the conversation, used when an embedded page starts fresh. */
function buildRecap(conv, modelId, maxChars = 1200) {
  if (!conv || !conv.turns.length) return '';
  const lines = [];
  for (const turn of conv.turns.slice(-4)) {
    const answer = turn.answers ? turn.answers[modelId] : null;
    const text = ((answer && answer.text) || '').trim().replace(/\s+/g, ' ').slice(0, 400);
    lines.push(`Q: ${turn.prompt}`);
    if (text) lines.push(`A: ${text}`);
  }
  const recap = lines.join('\n');
  return recap.length > maxChars ? `${recap.slice(0, maxChars)}…` : recap;
}

/* ─────────────────────────── summary of the round ─────────────────────────── */

/**
 * The summary is written by a *model*, not by this window.
 *
 * One column is designated the summariser — the chip in the top bar, the first
 * column by default. Pressing **Summarize** hands that model every answer of the
 * round and asks for the consensus bullets plus the difference table; the panel
 * shows what it writes, then adds the one thing a model cannot know: the link to
 * each model's own chat.
 *
 * The ask travels through the ordinary run pipeline, so API, embedded and tab
 * models all work. For a panel or tab model the prompt really is typed into its
 * own chat — its thread will show that, which the panel says out loud.
 */
const summary = {
  open: false,
  scope: 'round',
  /** The model that writes it (a model id), and the turn it is about. */
  modelId: '',
  turnId: '',
  runId: '',
  /** idle | running | done | cancelled | error */
  status: 'idle',
  text: '',
  detail: '',
  error: '',
  hint: '',
  finishedAt: 0,
  deadlineAt: 0,
  sources: [],
};

/** How long to keep listening after Cancel before settling the panel ourselves. */
const SUMMARY_GRACE_MS = 600;
/** A whole-chat summary reads the last N turns, not the whole history. */
const SUMMARY_TURNS = 6;

function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** Model label exactly as its column shows it (labels are de-duplicated). */
function modelLabel(model, provider) {
  const record = board?.columns.get(model.id);
  if (record && record.descriptor) return record.descriptor.name;
  return model.label || (provider ? provider.label : 'Model');
}

/** The model that writes the summary: the stored choice, else the first column. */
function summarizerModel() {
  const models = store.enabledModels();
  if (!models.length) return null;
  const wanted = store.state.settings.summarizerModelId;
  return models.find((model) => model.id === wanted) || models[0];
}

function summarizerName(model) {
  if (!model) return 'the model';
  return modelLabel(model, getProvider(model.providerId));
}

/** Keep the “Summary by …” chip in step with the model list. */
function updateSummaryPicker() {
  const select = dom.summaryModelSelect;
  if (!select || !dom.summaryModelChip) return;

  const models = store.enabledModels();
  const signature = models.map((model) => `${model.id}:${summarizerName(model)}`).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      ...models.map((model) => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = summarizerName(model);
        return option;
      }),
    );
  }

  const chosen = summarizerModel();
  if (chosen) select.value = chosen.id;
  dom.summaryModelChip.hidden = models.length === 0;
  select.disabled = !chosen || summary.status === 'running';
}

/** One entry per selected model: its text for this scope, plus its own chat link. */
function buildSummarySources(scope) {
  const conv = store.activeConversation();
  const turn = store.visibleTurn(conv);

  return store.enabledModels().map((model) => {
    const provider = getProvider(model.providerId);
    const modeLabel =
      model.mode === MODE_API
        ? 'via API'
        : model.mode === MODE_EMBED
          ? 'in its browser panel'
          : 'in its own tab';

    let text = '';
    if (scope === 'round') {
      const answer = turn && turn.answers ? turn.answers[model.id] : null;
      text = (answer && answer.text) || '';
    } else if (conv) {
      const offset = Math.max(0, conv.turns.length - SUMMARY_TURNS);
      text = conv.turns
        .slice(offset)
        .map((entry, index) => {
          const answer = entry.answers ? entry.answers[model.id] : null;
          const body = ((answer && answer.text) || '').trim();
          if (!body) return '';
          return `[Turn ${offset + index + 1}] Q: ${entry.prompt}\nA: ${body}`;
        })
        .filter(Boolean)
        .join('\n\n');
    }

    const threadUrl = conv ? threadUrlForTurn(conv, turn, model.id) : '';
    // Only the provider's own thread counts as “the historical chat”; say what
    // kind of model it is when there is none, instead of an empty link.
    const note =
      model.mode === MODE_API
        ? 'API model — its transcript lives in this window'
        : model.mode === MODE_WEB
          ? 'runs in its own tab — no link was recorded'
          : 'this panel did not report its chat URL';

    return { key: model.id, name: summarizerName(model), text, threadUrl, note, modeLabel };
  });
}

function summaryScopeLabel() {
  return summary.scope === 'chat' ? 'the whole chat' : 'this round';
}

function summarySubtitle() {
  const chosen = store.getModel(summary.modelId) || summarizerModel();
  const name = summarizerName(chosen);

  if (summary.status === 'running') return `${name} is writing the summary of ${summaryScopeLabel()}…`;
  if (summary.status === 'error') return `${name} could not write the summary.`;
  if (summary.status === 'cancelled') return `Stopped before ${name} finished.`;

  const sources = summary.sources.length ? summary.sources : buildSummarySources(summary.scope);
  const answered = sources.filter((source) => (source.text || '').trim()).length;
  const silent = sources.filter((source) => !(source.text || '').trim()).map((source) => source.name);
  const counts = silent.length
    ? `${answered} of ${sources.length} answers · no text from ${silent.join(', ')}`
    : `${answered} answer${answered === 1 ? '' : 's'}`;
  return `${name} · ${summaryScopeLabel()} · ${counts}`;
}

function summaryLinksBlock() {
  const block = node('section', 'summary-block');
  block.append(node('h3', '', 'Each model’s own chat'));
  block.append(
    node(
      'p',
      'summary-hint',
      'The provider’s own thread for what is summarised above, when the column reported one.',
    ),
  );

  const list = node('ul', 'summary-links');
  const sources = summary.sources.length ? summary.sources : buildSummarySources(summary.scope);
  for (const source of sources) {
    const item = node('li');
    if (/^https?:\/\//i.test(source.threadUrl)) {
      const link = node('a', '', source.name);
      link.href = source.threadUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = source.threadUrl;
      item.append(link, node('span', 'summary-link-note', 'open the provider’s thread'));
    } else {
      item.append(node('span', '', source.name), node('span', 'summary-link-note', source.note));
    }
    list.append(item);
  }
  block.append(list);
  return block;
}

function summaryFootNote() {
  const chosen = store.getModel(summary.modelId);
  const name = summarizerName(chosen);
  const time = summary.finishedAt ? formatClock(summary.finishedAt) : '';
  const parts = [`Written by ${name}`];
  if (chosen && chosen.mode !== MODE_API) parts.push('asked in its own chat');
  if (time) parts.push(time);
  return `${parts.join(' · ')} — this window only added the links.`;
}

function summaryBody() {
  const chosen = store.getModel(summary.modelId);
  const nodes = [];

  if (summary.status === 'running') {
    const block = node('section', 'summary-block');
    const status = node('div', 'summary-status');
    status.append(node('span', 'spinner'));
    status.append(node('span', '', summary.detail || `Asking ${summarizerName(chosen)}…`));
    block.append(status);
    if (chosen && chosen.mode !== MODE_API) {
      block.append(
        node(
          'p',
          'summary-note',
          `The prompt is typed into ${summarizerName(chosen)}’s own chat — that thread will show it.`,
        ),
      );
    }
    nodes.push(block);
  } else if (summary.status === 'error') {
    const block = node('section', 'summary-block');
    const box = node('div', 'summary-error');
    box.append(node('strong', '', summary.error || 'The summary could not be written.'));
    if (summary.hint) box.append(node('span', 'summary-error-hint', summary.hint));
    box.append(
      node('span', 'summary-error-hint', 'Pick another model in the top bar, or press “Ask again”.'),
    );
    block.append(box);
    nodes.push(block);
  }

  if (summary.text.trim()) {
    const block = node('section', 'summary-block summary-answer');
    const answer = node('div', 'answer');
    // Model output → Markdown → HTML. renderMarkdown escapes its input, so this
    // cannot inject markup the model did not produce as text.
    answer.innerHTML = renderMarkdown(summary.text);
    block.append(answer);
    nodes.push(block);
  } else if (summary.status === 'done') {
    const block = node('section', 'summary-block');
    block.append(
      node(
        'p',
        'summary-empty',
        'The model returned an empty answer — ask again, or pick another model in the top bar.',
      ),
    );
    nodes.push(block);
  }

  if (summary.status === 'done' || summary.status === 'cancelled') {
    nodes.push(summaryLinksBlock());
    nodes.push(node('p', 'summary-foot', summaryFootNote()));
  }
  return nodes;
}

function renderSummary() {
  if (!summary.open) return;

  const busy = summary.status === 'running';
  for (const button of dom.summaryScope.querySelectorAll('button[data-scope]')) {
    button.setAttribute('aria-pressed', button.dataset.scope === summary.scope ? 'true' : 'false');
    // Switching scope mid-run would leave that run without a panel.
    button.disabled = busy;
  }

  dom.summarySub.textContent = summarySubtitle();
  dom.summaryAgain.hidden = busy;
  dom.summaryStop.hidden = !busy;
  dom.summaryCopy.disabled = busy || !summary.text.trim();
  dom.summaryBodyEl.replaceChildren(...summaryBody());
}

/** Show the turn's stored summary when it matches, otherwise ask the model. */
function showOrAskSummary() {
  const conv = store.activeConversation();
  const turn = store.visibleTurn(conv);
  const saved = turn && turn.summary;

  summary.turnId = turn ? turn.id : '';
  summary.sources = buildSummarySources(summary.scope);

  if (
    saved &&
    saved.text &&
    saved.modelId === summary.modelId &&
    saved.scope === summary.scope
  ) {
    summary.status = 'done';
    summary.text = saved.text;
    summary.detail = '';
    summary.error = '';
    summary.hint = '';
    summary.finishedAt = saved.createdAt || Date.now();
    renderSummary();
    updateComposerState();
    return;
  }
  generateSummary();
}

/** Ask the chosen model for the summary — one run, one model, nothing stored yet. */
function generateSummary() {
  const models = store.enabledModels();
  if (!models.length) {
    toast('Add a model in Settings → Models first.', 'error');
    return;
  }

  const chosen = summarizerModel() || models[0];
  summary.modelId = chosen.id;
  if (!summary.turnId) {
    const turn = store.visibleTurn(store.activeConversation());
    summary.turnId = turn ? turn.id : '';
  }

  const question =
    summary.scope === 'round'
      ? (store.visibleTurn(store.activeConversation()) || {}).prompt || ''
      : '';
  summary.sources = buildSummarySources(summary.scope);
  const request = buildSummaryPrompt({
    question,
    scope: summary.scope,
    sources: summary.sources,
  });

  if (!request.answeredCount) {
    summary.status = 'error';
    summary.text = '';
    summary.error = 'There is no readable answer in this window to summarise.';
    summary.hint = 'Ask something first, or open the model panels that are not signed out.';
    renderSummary();
    return;
  }

  summary.runId = uid('sum');
  summary.status = 'running';
  summary.text = '';
  summary.error = '';
  summary.hint = '';
  summary.finishedAt = 0;
  summary.detail = `Asking ${summarizerName(chosen)} for the summary…`;
  const timeoutSec = Number(store.state.settings.timeoutSec) || 180;
  summary.deadlineAt = Date.now() + timeoutSec * 1000 + 15000;

  renderSummary();
  updateComposerState();
  // The worker's frame registry may be empty after a restart; re-announce the
  // panels so an embedded summariser can actually be typed into.
  refreshIdentities();
  bgSend({
    type: 'run',
    payload: {
      runId: summary.runId,
      prompt: request.prompt,
      attachments: [],
      modelIds: [chosen.id],
      history: [],
      recaps: {},
    },
  });
}

/** Store a finished summary on the turn it describes, so reopening is free. */
function rememberSummary() {
  const conv = store.activeConversation();
  if (!conv || !summary.text.trim()) return;
  const turn = conv.turns.find((entry) => entry.id === summary.turnId);
  if (!turn) return;
  turn.summary = {
    modelId: summary.modelId,
    modelName: summarizerName(store.getModel(summary.modelId)),
    scope: summary.scope,
    text: summary.text,
    createdAt: summary.finishedAt || Date.now(),
  };
  void store.persistConversation(conv);
}

function settleSummary(status, text, error = '', hint = '') {
  if (!summary.runId) return;
  summary.runId = '';
  summary.status = status;
  summary.text = String(text || '');
  summary.error = error;
  summary.hint = hint || '';
  summary.deadlineAt = 0;

  if (status === 'done' && summary.text.trim()) {
    summary.finishedAt = Date.now();
    rememberSummary();
  }
  renderSummary();
  updateComposerState();
}

function onSummaryStatus(msg) {
  if (summary.status !== 'running') return;
  if (!msg.detail) return;
  summary.detail = msg.detail;
  const line = dom.summaryBodyEl.querySelector('.summary-status span:last-child');
  if (line) line.textContent = msg.detail;
}

const paintSummarySoon = throttle(() => {
  if (summary.open && summary.status === 'running') renderSummary();
}, 140);

function onSummaryDelta(msg) {
  summary.text = msg.text || summary.text;
  paintSummarySoon();
}

function onSummaryFinal(msg) {
  settleSummary(msg.stop ? 'cancelled' : 'done', msg.text || summary.text);
}

function onSummaryError(msg) {
  settleSummary('error', summary.text, msg.message || 'The model did not answer.', msg.hint || '');
}

/** Stop the summary run; settle locally if the worker does not answer in time. */
function abortSummary({ timedOut = false } = {}) {
  if (summary.status !== 'running') return;
  const runId = summary.runId;
  bgSend({ type: 'abort', runId });

  setTimeout(() => {
    if (summary.runId !== runId) return; // a `final` arrived and settled it
    if (timedOut) {
      settleSummary(
        'error',
        summary.text,
        'The model did not finish in time.',
        'Ask again, or pick a faster model in the top bar.',
      );
      return;
    }
    settleSummary('cancelled', summary.text);
  }, SUMMARY_GRACE_MS);
}

/** The panel owns its own deadline: a dead worker must not leave it spinning. */
function checkSummaryDeadline() {
  if (summary.status !== 'running' || !summary.deadlineAt) return;
  if (Date.now() < summary.deadlineAt) return;
  abortSummary({ timedOut: true });
}

function openSummary() {
  const models = store.enabledModels();
  if (!models.length) {
    toast('Add a model in Settings → Models first.', 'error');
    return;
  }

  const chosen = summarizerModel();
  summary.open = true;
  summary.modelId = chosen ? chosen.id : '';
  summary.turnId = '';
  dom.summaryPanel.hidden = false;
  dom.columnsScroll.classList.add('is-summary');
  dom.summaryPanel.scrollTop = 0;

  showOrAskSummary();
  updateSummaryPicker();
  updateComposerState();
}

function closeSummary() {
  if (!summary.open) return;
  if (summary.status === 'running') {
    abortSummary();
    // Closing means “I am done here”: settle now rather than when the worker
    // eventually answers, so a later Send cannot see a half-open run.
    summary.runId = '';
    summary.deadlineAt = 0;
    summary.status = 'idle';
  }
  summary.open = false;
  dom.summaryPanel.hidden = true;
  dom.columnsScroll.classList.remove('is-summary');
  updateComposerState();
  updateSummaryPicker();
}

async function copySummary() {
  if (!summary.text.trim()) {
    toast('Nothing to copy yet.', 'info');
    return;
  }
  const text = summaryCopyText({
    text: summary.text,
    modelName: summarizerName(store.getModel(summary.modelId)),
    models: summary.sources.length ? summary.sources : buildSummarySources(summary.scope),
  });
  const ok = await copyText(text);
  toast(ok ? 'Summary copied as Markdown' : 'Copy failed', ok ? 'ok' : 'error');
}

/* ───────────────────────────── embedded panels ───────────────────────────── */

/** Embedded frames that have reported in. */
const embedReady = new Set();
/** modelId → when its iframe was mounted (for the "no response" timeout). */
const embedMountedAt = new Map();

/** Mount/refresh the iframe of every embedded column on the board. */
function mountEmbeds(descriptors) {
  if (!board) return;

  // Forget bookkeeping for columns that no longer exist. This looks at the board,
  // not at `descriptors`: callers mount a single panel (e.g. “Open live chat”), and
  // pruning against that subset would declare every other panel dead.
  for (const key of [...embedMountedAt.keys()]) {
    if (!board.columns.has(key)) {
      embedMountedAt.delete(key);
      embedReady.delete(key);
    }
  }

  for (const descriptor of descriptors) {
    if (descriptor.mode !== MODE_EMBED) continue;
    const provider = getProvider(descriptor.providerId);
    if (!provider) continue;
    if (board.isSnapshot(descriptor.key)) continue;
    // Never point a panel that already shows a page back at its home URL: that is
    // a navigation, and it would undo a restored conversation (or the user's own
    // place in the site).
    if (board.hasMount(descriptor.key)) continue;
    if (!embedMountedAt.has(descriptor.key)) embedMountedAt.set(descriptor.key, Date.now());
    board.mountEmbed(descriptor.key, { src: provider.homeUrl, modelId: descriptor.key });
  }
}

/**
 * Apply a panel report to a column header.
 *
 * Ready + signed in        → "Signed in"
 * Ready, composer, no user → "Sign in inside this panel"
 * Ready, no composer       → the provider refused to render a chat in a frame
 *                            (DeepSeek's CDN answers 403 to framed requests);
 *                            offer the tab fallback instead of pretending.
 *
 * Never called while a run is pending for that model, and never after a run has
 * left its own verdict in the pill: "Done"/"Stopped" must not flicker back to
 * "Signed in" on the next liveness poll.
 */
function noteEmbedStatus(modelId, ready, signedIn, hasComposer = true, visible = true) {
  if (!board || !modelId || !ready) return;
  // A column showing a saved copy has its live page hidden on purpose: everything
  // inside it measures 0×0, which is not a framing problem. Same for a panel that
  // is itself hidden right now.
  if (board.isSnapshot(modelId) || !visible) return;

  // Declared before the branches: the sign-in-page branch below needs the name and
  // the provider's framing policy (a `const` declared later would be a TDZ error).
  const record = board.columns.get(modelId);
  const provider = record ? getProvider(record.descriptor.providerId) : null;

  if (!hasComposer) {
    /*
     * The panel reported in, so its page *did* load. A loaded page without a composer
     * is a sign-in screen (Copilot's signed-out page is only a “Sign in” wall), not a
     * site refusing to be framed — say the accurate thing.
     */
    if (!signedIn) {
      const name = record ? record.descriptor.name : 'This model';
      board.setStatus(modelId, 'warn', 'Sign in needed · use a tab');
      board.setEmbedNotice(
        modelId,
        `${name} shows a sign-in page inside the panel. Open it once in a tab to sign in, then press ⟳ here — or switch this model to “Use a tab instead”.`,
        true,
      );
      return;
    }
    board.setStatus(modelId, 'error', 'Not usable here');
    board.setEmbedNotice(
      modelId,
      'This site refused to load its chat inside the panel. Switch this model to “Use a tab instead”, or use an API key.',
      true,
    );
    return;
  }

  embedReady.add(modelId);
  if (activeRun && activeRun.pending.has(modelId)) return;
  if (runPillState.get(modelId)) return;

  const canSignInHere = !(provider && provider.web && provider.web.signInInFrame === false);

  if (signedIn) {
    board.setStatus(modelId, 'done', 'Signed in');
    board.setEmbedNotice(modelId, '');
    return;
  }

  /*
   * A provider whose sign-in cannot complete in a frame (Google answers 403 to
   * framed OAuth) must not be told to “sign in inside this panel”: that button is
   * the one that returns 403. Point at the tab path instead.
   */
  if (!canSignInHere) {
    board.setStatus(modelId, 'warn', 'Sign in needed · use a tab');
    board.setEmbedNotice(
      modelId,
      `${record.descriptor.name} will not complete a sign-in inside a panel (Google answers 403). Press “Use a tab instead”, sign in there once, then reopen this panel.`,
      true,
    );
    return;
  }

  board.setStatus(modelId, 'warn', 'Sign in inside this panel');
  board.setEmbedNotice(modelId, '');
}

/** Re-check every embedded panel; flag the ones that never came up. */
async function pollEmbeds() {
  if (!board) return;
  for (const [key, record] of board.columns) {
    if (!record.embedded) continue;
    if (board.isSnapshot(key)) continue;

    // The panel pushes its own state every 1.5s — prefer that over asking the
    // worker, whose frame registry is empty after a restart.
    const pushed = frameState.get(key);
    if (pushed && Date.now() - pushed.at < 6000) {
      noteEmbedStatus(key, true, pushed.signedIn, pushed.hasComposer, pushed.visible);
      continue;
    }

    let status = null;
    try {
      status = await bgCall({ type: 'embed-status', modelId: key }, 4000);
    } catch {
      status = null;
    }
    if (status && status.ready) {
      noteEmbedStatus(
        key,
        true,
        Boolean(status.signedIn),
        status.hasComposer !== false,
        status.visible !== false,
      );
      continue;
    }
    const mountedAt = embedMountedAt.get(key) || 0;
    if (!embedReady.has(key) && Date.now() - mountedAt > 20000) {
      board.setStatus(key, 'error', 'No response');
      board.setEmbedNotice(
        key,
        'This page did not load inside the panel. Press ⟳ to reload it, or open it once in a tab to sign in, then reload.',
      );
    }
  }
}

function renderAll() {
  applyTheme();
  renderHeader();
  renderSidebarNow();
  renderSidebarModels();
  renderBoard({ rebuild: true });
  updateComposerState();
}

/** True while applying a change written by another context (see watchStorage). */
let adoptingStorageChange = false;

store.subscribe((reason) => {
  if (reason === 'history') {
    renderSidebarNow();
    return;
  }
  if (reason === 'settings') {
    applyTheme();
    renderHeader();
    renderSidebarModels();
    // Surgical update: a removed/added model changes the column set only; the
    // answers already on screen are not re-rendered.
    renderBoard();
    // An open summary lists the models too, so it follows an edited model list.
    if (summary.open) renderSummary();
    // Only a change coming from outside may safely repaint the settings panel;
    // repainting after a local edit would steal the caret from the user.
    if (adoptingStorageChange) settingsView?.refresh();
    return;
  }
  if (reason === 'init' || reason === 'active') renderAll();
});

/**
 * Keep the window in step with storage. Another app tab — or the worker — can
 * change the model list; without this the board would only refresh on reload.
 */
function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (Object.prototype.hasOwnProperty.call(changes, 'settings')) {
      const next = changes.settings.newValue;
      if (next && JSON.stringify(next) !== JSON.stringify(store.state.settings)) {
        adoptingStorageChange = true;
        try {
          store.applySettingsFromStorage(next);
        } finally {
          adoptingStorageChange = false;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'apiKeys')) {
      store.applyApiKeysFromStorage(changes.apiKeys.newValue || {});
    }

    if (Object.prototype.hasOwnProperty.call(changes, 'conversationIndex')) {
      const next = changes.conversationIndex.newValue;
      if (Array.isArray(next)) store.applyIndexFromStorage(next);
    }
  });
}

/* ────────────────────────────── actions ────────────────────────────── */

function ensureConversation() {
  let conv = store.activeConversation();
  if (conv) return conv;
  conv = store.makeConversation();
  store.state.conversations.set(conv.id, conv);
  store.state.activeId = conv.id;
  void chrome.storage.local.set({ activeConversationId: conv.id });
  return conv;
}

async function send() {
  if (activeRun) {
    toast('Still waiting for answers — press Stop first.', 'error');
    return;
  }
  const text = dom.prompt.value.trim();
  if (!text) {
    dom.prompt.focus();
    return;
  }
  const models = store.enabledModels();
  if (!models.length) {
    toast('Add at least one model in Settings → Models.', 'error');
    settingsView?.open('models');
    return;
  }

  // Sending is about the answers, so the summary gets out of their way first.
  closeSummary();

  const conv = ensureConversation();
  const firstTurn = conv.turns.length === 0;

  /** @type {any} */
  const turn = {
    id: uid('t'),
    prompt: text,
    attachments: attachments.map((item) => ({ ...item })),
    createdAt: Date.now(),
    answers: {},
  };
  for (const model of models) {
    turn.answers[model.id] = {
      providerId: model.providerId,
      label: model.label,
      mode: model.mode,
      modelName: model.modelName || '',
      text: '',
      status: 'pending',
      error: '',
      startedAt: Date.now(),
      endedAt: null,
      ms: null,
    };
  }

  const history = conv.turns.map((past) => ({
    prompt: past.prompt,
    answers: Object.fromEntries(
      Object.entries(past.answers || {}).map(([key, value]) => [key, value.text || '']),
    ),
  }));

  /*
   * An embedded column that was showing a saved transcript has to reopen the
   * provider page before it can be driven. The provider starts a fresh thread, so
   * a compact recap of the conversation is prefixed to the prompt to continue the
   * topic instead of restarting it.
   */
  /** @type {Record<string, string>} */
  const recaps = {};
  for (const model of models) {
    if (model.mode !== MODE_EMBED) continue;
    if (!board?.isSnapshot(model.id)) continue;
    /*
     * The panel is showing a saved copy, so the prompt has to carry the context
     * itself — unless that panel is already sitting on this very thread (the user
     * opened it with “Open in …”), in which case a recap would duplicate what the
     * site already has.
     */
    const wantedUrl = threadUrlForTurn(conv, null, model.id);
    const panelUrl = (frameState.get(model.id) || {}).threadUrl || '';
    if (!wantedUrl || panelUrl !== wantedUrl) recaps[model.id] = buildRecap(conv, model.id);
    board.openLive(model.id);
  }

  conv.turns.push(turn);
  if (firstTurn) conv.title = topicFromPrompt(text);
  // A new turn is the newest one, so drop any "viewing an older turn" selection.
  store.state.viewTurn = null;

  const runId = uid('run');
  const startedAt = Date.now();
  const timeoutSec = Number(store.state.settings.timeoutSec) || 180;

  /*
   * Per-model bookkeeping. `deadlineAt` is the promise that the Stop button can
   * never stay on screen forever: even if the worker is restarted and every
   * other signal is lost, the model settles when its deadline passes.
   */
  /** @type {Map<string, {startedAt:number, deadlineAt:number, busySeen:boolean, textSeen:boolean, readyStreak:number}>} */
  const meta = new Map();
  for (const model of models) {
    meta.set(model.id, {
      startedAt,
      deadlineAt: runDeadline({ startedAt, timeoutSec }),
      busySeen: false,
      textSeen: false,
      readyStreak: 0,
    });
    // This run owns the column header again (status polls must not overwrite it).
    runPillState.delete(model.id);
  }

  activeRun = {
    runId,
    conv,
    turn,
    pending: new Set(models.map((model) => model.id)),
    meta,
    startedAt,
  };

  // Reconcile the board with the model list (this keeps embedded iframes alive
  // instead of reloading the provider pages on every Send), then start a fresh
  // answer pane for the columns that render text here.
  board?.sync(buildColumnDescriptors());
  for (const model of models) {
    const record = board?.columns.get(model.id);
    if (record && record.embedded) {
      board.setEmbedNotice(model.id, '');
      board.setStatus(model.id, 'pending', 'Sending…');
    } else {
      board?.clearAnswer(model.id);
      board?.setStatus(model.id, 'pending', 'Sending…');
    }
  }
  dom.emptyState.hidden = true;
  setRunning(true);
  renderHeader();

  // Re-announce the panels first: the worker's frame registry may be empty
  // (fresh worker, or a restart since the panels were mounted).
  refreshIdentities();

  bgSend({
    type: 'run',
    payload: {
      runId,
      prompt: text,
      attachments: turn.attachments,
      modelIds: models.map((model) => model.id),
      history,
      recaps,
    },
  });

  dom.prompt.value = '';
  autoGrow(dom.prompt);
  attachments = [];
  renderAttachments();
  await store.persistConversation(conv);
  renderSidebarNow();
}

/**
 * Stop the run.
 *
 * Two things happen at once:
 *   1. the worker is asked to abort (best effort — it may be gone);
 *   2. the app settles every model still pending *itself* after a short grace,
 *      so the button always works. Without step 2 the UI depended on a `final`
 *      message that never arrives when the worker was restarted mid-run — which
 *      is how Stop used to become un-stoppable.
 *
 * The grace is what lets an answer that is already on its way land (and keeps
 * the text of a model that had just finished) instead of throwing it away.
 */
const STOP_GRACE_MS = 600;

/**
 * Settle every model still pending, right now.
 *
 * Used whenever the user changes topic (New chat, opening a history entry,
 * deleting a conversation): they have already walked away from the answer, so it
 * must not keep the window hostage. Refusing to switch until a slow model finishes
 * — or until a `final` that may never arrive — is how “New chat” appeared broken.
 */
function settleRemaining(run) {
  for (const modelId of [...run.pending]) {
    const answer = currentAnswer(modelId);
    finalizeModel(modelId, { status: 'stopped', text: (answer && answer.text) || '' });
  }
  // Whatever happened inside finalizeModel, this run is over.
  if (activeRun === run) {
    run.pending.clear();
    run.meta.clear();
    void endRun();
  }
}

/** Abandon the run in flight (returns false when there was none). */
function abandonRun() {
  const run = activeRun;
  if (!run) return false;
  clearTimeout(run.stopTimer);
  bgSend({ type: 'abort', runId: run.runId });
  settleRemaining(run);
  toast('Stopped the answer that was still running', 'info', 1800);
  return true;
}

function stop() {
  const run = activeRun;
  if (!run) return;

  bgSend({ type: 'abort', runId: run.runId });

  clearTimeout(run.stopTimer);
  run.stopTimer = setTimeout(() => {
    if (activeRun !== run) return; // a final arrived and ended the run already
    settleRemaining(run);
    toast('Stopped', 'info', 1200);
  }, STOP_GRACE_MS);
}

/**
 * Start a new topic.
 *
 * This only empties the window. It deliberately does **not** re-render the board:
 * a rebuild recreates each embedded <iframe>, which navigates the provider page
 * and pops its cookie banner (DeepSeek, every single time) and loses the thread
 * the panel was showing. The pages stay exactly where they are; the next prompt
 * is simply a new conversation on this side.
 *
 * If the user asked for “fresh chat in each model tab”, each panel is told to
 * press the site's **own** New chat control — also without a page load.
 */
async function newChat() {
  try {
    // A new topic means the old answer is no longer wanted: stop it instead of
    // refusing (that refusal is what made this button look dead).
    abandonRun();
    closeSummary();

    await store.startNewChat();

    // A new chat belongs in the chat view, even if Settings was open.
    settingsView?.close();

    dom.prompt.value = '';
    attachments = [];
    renderAttachments();
    autoGrow(dom.prompt);

    runPillState.clear();
    board?.resetForNewChat();
    renderHeader();
    renderSidebarNow();
    renderSidebarModels();
    updateComposerState();

    if (store.state.settings.resetProviderChatsOnNewChat) {
      reloadPanelsForNewChat();
      // Tab-mode models: ask their tabs to start over as well.
      bgSend({ type: 'reset-provider-chats' });
    }
    dom.prompt.focus();
  } catch (error) {
    // Never leave the click silently doing nothing.
    console.warn('[MultiChatAI] could not start a new chat:', error);
    toast(`Could not start a new chat: ${error?.message || error}`, 'error', 6000);
  }
}

/**
 * “New chat” starts a fresh session in every model by **reloading its column**.
 *
 * Pressing the site's own “New chat” button was cheaper but unreliable: providers
 * disagree about that control (DeepSeek has no <button>, some SPAs keep the old
 * thread alive), and when it misses the panel silently stays on the previous
 * conversation. A reload cannot miss. It costs one page load per column, which is
 * exactly what “start a new session” means.
 */
function reloadPanelsForNewChat() {
  if (!board) return;
  for (const [key, record] of board.columns) {
    if (!record.embedded) continue;
    const provider = getProvider(record.descriptor.providerId);
    board.startFresh(key, provider ? provider.homeUrl : record.mountedSrc);
    // The panel is about to be a different document: forget what it said about
    // itself, and give the fresh load a full window before it is called unresponsive.
    frameState.delete(key);
    embedReady.delete(key);
    embedMountedAt.set(key, Date.now());
  }
}

async function openConversation(id) {
  if (!id) return;
  // Switching topic abandons an answer the user has walked away from.
  if (activeRun && activeRun.conv.id !== id) abandonRun();
  closeSummary();
  const conv = await store.loadConversation(id);
  if (!conv) {
    toast('That conversation could not be loaded.', 'error');
    return;
  }
  await store.setActiveConversation(id);
}

async function removeConversation(id) {
  const row = store.state.index.find((item) => item.id === id);
  const label = row ? row.title : 'this chat';
  if (!window.confirm(`Delete “${label}” permanently?`)) return;
  if (activeRun && activeRun.conv.id === id) abandonRun();
  await store.deleteConversation(id);
  closeSummary();
  renderAll();
}

/**
 * A provider that refuses to be framed gets a one-click escape hatch: switch the
 * model to tab mode and open its site once (an explicit click, not automatic).
 */
async function switchEmbedToTab(descriptor) {
  const model = store.getModel(descriptor.key);
  if (!model) return;
  await store.updateModel(descriptor.key, { mode: 'web' });
  toast(`${model.label}: switched to “existing tab” — sign in there, then press Send`, 'ok', 6000);
  openProvider(model.providerId, { active: true });
}

function openProvider(providerId, options = {}) {

  const provider = getProvider(providerId);
  if (!provider) return;
  bgSend({ type: 'open-provider-tab', providerId, active: options.active !== false });
}

/* ────────────────────────────── attachments ────────────────────────────── */

function renderAttachments() {
  dom.attachmentsEl.hidden = attachments.length === 0;
  dom.attachmentsEl.innerHTML = attachments
    .map(
      (item) => `<span class="attachment" title="${escapeHtml(item.name)} · ${formatBytes(item.size)}">
        <span class="attachment-name">${escapeHtml(item.name)}</span>
        <button class="attachment-remove" type="button" data-remove="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">
          <svg class="ico" aria-hidden="true"><use href="#i-x" /></svg>
        </button>
      </span>`,
    )
    .join('');
}

dom.attachmentsEl.addEventListener('click', (event) => {
  const btn = /** @type {HTMLElement} */ (event.target).closest('[data-remove]');
  if (!btn) return;
  attachments = attachments.filter((item) => item.id !== btn.getAttribute('data-remove'));
  renderAttachments();
});

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsText(file);
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function ingestFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast(`At most ${MAX_ATTACHMENTS} attachments per message.`, 'error');
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast(`${file.name} is larger than ${formatBytes(MAX_FILE_BYTES)} — skipped.`, 'error');
      continue;
    }
    const isImage = /^image\//.test(file.type);
    try {
      if (isImage) {
        const dataUrl = await readAsDataUrl(file);
        attachments.push({
          id: uid('a'),
          name: file.name,
          type: file.type || 'image/png',
          size: file.size,
          kind: 'image',
          dataUrl,
        });
      } else {
        const text = (await readAsText(file)).slice(0, MAX_TEXT_CHARS);
        attachments.push({
          id: uid('a'),
          name: file.name,
          type: file.type || 'text/plain',
          size: file.size,
          kind: 'text',
          text,
        });
      }
    } catch (error) {
      toast(`Could not read ${file.name}`, 'error');
    }
  }
  renderAttachments();
}

/* ────────────────────────────── wiring ────────────────────────────── */

const settingsActions = {
  getModels: () => store.state.settings.models,
  getSettings: () => store.state.settings,
  getTurnCount: () => store.state.index.length,

  addModel: async (providerId, mode) => {
    try {
      const model = await store.addModel({ providerId, mode });
      // Adding a model only adds a column to the right-hand window — it never
      // opens a tab. Browser-session models are connected later, on demand,
      // with the "Sign in / open tab" button on that model's card.
      toast(
        model.mode === MODE_API
          ? `Added ${model.label} — column created, answers run inside the extension`
          : model.mode === MODE_EMBED
            ? `Added ${model.label} — its free web chat is loading in the new column`
            : `Added ${model.label} — open its site once so the column can use that tab`,
        'ok',
        model.mode === MODE_API ? 3600 : 6000,
      );
      renderBoard();
      renderHeader();
      renderSidebarModels();
    } catch (error) {
      toast(error.message || 'Could not add that model', 'error');
    }
  },

  removeModel: async (modelId) => {
    const model = store.getModel(modelId);
    await store.removeModel(modelId);
    if (model) toast(`Removed ${model.label || model.providerId}`, 'info');
    // Remove just that column; the others keep their rendered answers.
    renderBoard();
    renderHeader();
    renderSidebarModels();
  },

  updateModel: async (modelId, patch) => {
    await store.updateModel(modelId, patch);
    renderBoard();
    renderHeader();
    renderSidebarModels();
  },

  getApiKey: (modelId) => store.getApiKey(modelId),
  setApiKey: async (modelId, key) => {
    await store.setApiKey(modelId, key);
  },

  testApi: async (modelId) => {
    try {
      const data = await bgCall({ type: 'test-api', modelId }, 60000);
      return data || { ok: false, message: 'No result' };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  },

  checkProvider: async (providerId) => {
    try {
      const data = await bgCall({ type: 'check-provider', providerId }, 25000);
      return data || { ok: false, signedIn: false, message: 'No result' };
    } catch (error) {
      return { ok: false, signedIn: false, message: error.message };
    }
  },

  openProvider: async (providerId, options) => openProvider(providerId, options),
  saveSettings: (patch) => store.saveSettings(patch),

  clearHistory: async () => {
    if (!window.confirm('Delete every saved conversation? This cannot be undone.')) return;
    await store.clearAllConversations();
    closeSummary();
    renderAll();
    toast('History cleared', 'ok');
  },
};

function wireUi() {
  dom.newChatBtn.addEventListener('click', () => void newChat());
  dom.settingsBtn.addEventListener('click', () => settingsView?.open('models'));
  dom.addModelShortcut.addEventListener('click', () => settingsView?.open('models'));
  dom.emptyOpenSettings.addEventListener('click', () => settingsView?.open('models'));
  dom.sidebarModelList.addEventListener('click', (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('[data-model]')) {
      settingsView?.open('models');
    }
  });
  dom.sendBtn.addEventListener('click', () => void send());
  dom.stopBtn.addEventListener('click', () => stop());

  dom.summarizeBtn.addEventListener('click', () => {
    if (summary.open) closeSummary();
    else openSummary();
  });
  dom.summaryClose.addEventListener('click', () => closeSummary());
  dom.summaryCopy.addEventListener('click', () => void copySummary());
  dom.summaryScope.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement|null} */ (event.target).closest('button[data-scope]');
    if (!button || summary.status === 'running') return;
    const scope = button.dataset.scope === 'chat' ? 'chat' : 'round';
    if (scope === summary.scope) return;
    summary.scope = scope;
    dom.summaryPanel.scrollTop = 0;
    // Another scope is another question: use its stored answer, or ask again.
    showOrAskSummary();
    renderSummary();
  });

  // Pick the summarising model from the top bar. It is a setting, so it survives
  // a reload; while the panel is open the summary is re-asked immediately.
  dom.summaryModelSelect.addEventListener('change', () => {
    const value = dom.summaryModelSelect.value;
    if (!value) return;
    void store.saveSettings({ summarizerModelId: value });
    summary.modelId = value;
    summary.sources = [];
    if (summary.open) showOrAskSummary();
  });

  dom.summaryAgain.addEventListener('click', () => {
    if (summary.status === 'running') return;
    generateSummary();
  });

  dom.summaryStop.addEventListener('click', () => abortSummary());

  // Esc closes the summary first, then leaves the full-width view, before it
  // closes Settings (capture phase, so the settings panel does not swallow it).
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      if (summary.open) {
        event.stopPropagation();
        closeSummary();
        return;
      }
      if (!board?.focusedKey) return;
      event.stopPropagation();
      board.setFocus('');
    },
    true,
  );

  dom.prompt.addEventListener('input', () => autoGrow(dom.prompt));
  dom.prompt.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  });

  dom.fileInput.addEventListener('change', async (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    await ingestFiles(input.files);
    input.value = '';
  });

  // Drag & drop files onto the composer.
  const composer = /** @type {HTMLElement} */ (document.querySelector('.composer'));
  ['dragover', 'dragenter'].forEach((type) =>
    composer.addEventListener(type, (event) => {
      event.preventDefault();
      composer.classList.add('is-dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    composer.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'dragleave') composer.classList.remove('is-dragover');
    }),
  );
  composer.addEventListener('drop', (event) => {
    composer.classList.remove('is-dragover');
    const files = /** @type {DragEvent} */ (event).dataTransfer?.files;
    if (files && files.length) void ingestFiles(files);
  });
}

async function boot() {
  await store.initState();

  board = new ColumnBoard({
    root: dom.columns,
    emptyEl: dom.emptyState,
    onCopy: async (descriptor, text) => {
      if (!text) {
        toast('Nothing to copy yet.', 'info');
        return;
      }
      const ok = await copyText(text);
      toast(ok ? `Copied ${descriptor.name}'s answer` : 'Copy failed', ok ? 'ok' : 'error');
    },
    onOpen: (descriptor) => openProvider(descriptor.providerId, { active: true }),
    onSwitchTab: (descriptor) => void switchEmbedToTab(descriptor),
    onOpenLive: (descriptor) => {
      mountEmbeds(buildColumnDescriptors().filter((entry) => entry.key === descriptor.key));
    },
    onFocusChange: () => {
      // Focus mode is a layout change: only the composer hint needs updating.
      updateComposerState();
    },
  });

  settingsView = new SettingsView({
    appRoot: dom.appRoot,
    viewChat: dom.viewChat,
    viewSettings: dom.viewSettings,
    navEl: dom.settingsNav,
    bodyEl: dom.settingsBody,
    backBtn: dom.settingsBack,
    actions: settingsActions,
  });

  wireUi();
  connect();
  watchStorage();
  renderAll();
  autoGrow(dom.prompt);
  // Keep embedded panels honest: ask each frame whether it is alive/signed in.
  setInterval(() => void pollEmbeds(), 5000);
  // Panels push their own readiness (see bridge.js) — this is the completion
  // signal that does not depend on the worker surviving the run.
  window.addEventListener('message', onFrameState);
  // Run watchdog: deadlines, worker keep-alive, frame-registry healing.
  setInterval(tick, 2000);
  // Read-only diagnostic for scripts/embed-test.mjs: what each panel last said
  // about itself (ready / busy / signed in).
  window.__multichaiPanelStates = () => Object.fromEntries(frameState);

  // Restore the conversation the user was last looking at.
  if (store.state.activeId) {
    const conv = await store.loadConversation(store.state.activeId);
    if (conv) {
      renderAll();
    } else {
      await store.setActiveConversation(null);
    }
  }

  /*
   * A panel keeps the content script it was loaded with. After an extension update
   * that script is the *previous* build — no HTML capture, older readiness reports —
   * so history would keep behaving like the old version while everything else is
   * new. Reload the panels once per version to end that mismatch.
   */
  void reloadPanelsAfterUpdate();

  if (!store.state.settings.models.length) settingsView.open('models');
  dom.prompt.focus();
}

/**
 * Reload the embedded panels once per extension version.
 *
 * The content script inside a framed provider page is only replaced when that page
 * loads. Without this, every update ran a new app page against old bridges inside
 * the columns — which is exactly how “history still shows plain text” survived a
 * version that had already fixed it.
 */
const VERSION_KEY = 'extensionVersion';

async function reloadPanelsAfterUpdate() {
  const current = chrome.runtime.getManifest().version;
  let stored = '';
  try {
    const data = await chrome.storage.local.get(VERSION_KEY);
    stored = typeof data[VERSION_KEY] === 'string' ? data[VERSION_KEY] : '';
  } catch {
    return;
  }
  if (stored === current) return;
  try {
    await chrome.storage.local.set({ [VERSION_KEY]: current });
  } catch {
    /* storage is best effort here */
  }
  // First run of this build: the panels were mounted a moment ago, they are new.
  if (!stored) return;

  if (!board) return;
  let reloaded = 0;
  for (const [key, record] of board.columns) {
    if (!record.embedded || !record.mountedSrc) continue;
    board.reload(key);
    reloaded += 1;
  }
  if (reloaded) toast(`Reloaded ${reloaded} panel(s) for v${current}`, 'info', 4000);
}

void boot();
