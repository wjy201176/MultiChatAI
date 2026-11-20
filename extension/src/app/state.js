/**
 * Application state + persistence.
 *
 * Storage layout in chrome.storage.local:
 *   settings              → DEFAULT_SETTINGS + model entries (no secrets)
 *   apiKeys               → { [modelId]: 'sk-...' }  (never rendered in lists)
 *   conversationIndex     → [{ id, title, createdAt, updatedAt, turnCount }]
 *   conv:<id>             → full conversation { id, title, createdAt, updatedAt, turns[] }
 *   activeConversationId  → string|null
 *
 * Conversations are stored one key per conversation so that streaming updates
 * never rewrite the whole history, and the sidebar can render from the small
 * index without loading transcripts.
 */

import {
  DEFAULT_SETTINGS,
  MODE_API,
  MODE_EMBED,
  availableModes,
  getProvider,
} from '../shared/providers.js';
import { uid } from './util.js';

const KEY_SETTINGS = 'settings';
const KEY_API_KEYS = 'apiKeys';
const KEY_INDEX = 'conversationIndex';
const KEY_ACTIVE = 'activeConversationId';
const CONV_PREFIX = 'conv:';

const listeners = new Set();

export const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  apiKeys: /** @type {Record<string,string>} */ ({}),
  /** @type {Array<{id,title,createdAt,updatedAt,turnCount}>} */
  index: [],
  /** @type {Map<string, any>} loaded conversation transcripts */
  conversations: new Map(),
  activeId: /** @type {string|null} */ (null),
  /** Which turn the column board is showing (null = latest). */
  viewTurn: /** @type {number|null} */ (null),
  ready: false,
};

/** @param {(reason?: string) => void} fn */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(reason = 'update') {
  for (const fn of listeners) {
    try {
      fn(reason);
    } catch (error) {
      console.error('[MultiChatAI] listener failed', error);
    }
  }
}

/** Merge defaults so older/partial settings objects stay valid. */
function withDefaults(raw) {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...(raw || {}) };
  settings.models = Array.isArray(settings.models) ? settings.models.filter(isValidModel) : [];

  /*
   * Migrate a profile written before `settingsVersion` existed. Back then “New
   * chat” left every model panel on its old conversation, which is not what the
   * window is for: a new topic should start clean everywhere. Flip it once — as
   * soon as the user saves any setting, the stamp is written and this stops.
   */
  if (!Number.isFinite(raw?.settingsVersion)) {
    settings.resetProviderChatsOnNewChat = true;
    settings.settingsVersion = 2;
  }
  return settings;
}

function isValidModel(model) {
  return Boolean(model && typeof model === 'object' && getProvider(model.providerId));
}

/** Load everything the UI needs. Call once at boot. */
export async function initState() {
  const stored = await chrome.storage.local.get([KEY_SETTINGS, KEY_API_KEYS, KEY_INDEX, KEY_ACTIVE]);
  state.settings = withDefaults(stored[KEY_SETTINGS]);
  state.apiKeys = stored[KEY_API_KEYS] || {};
  const index = Array.isArray(stored[KEY_INDEX]) ? stored[KEY_INDEX] : [];
  state.index = index.filter((item) => item && item.id).sort(byUpdatedDesc);
  state.activeId = typeof stored[KEY_ACTIVE] === 'string' ? stored[KEY_ACTIVE] : null;
  state.ready = true;
  notify('init');
}

function byUpdatedDesc(a, b) {
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/* ─────────────────────────────── settings ─────────────────────────────── */

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch, settingsVersion: 2 };
  await chrome.storage.local.set({ [KEY_SETTINGS]: state.settings });
  notify('settings');
}

export function enabledModels() {
  return state.settings.models.filter((model) => model.enabled !== false);
}

export function getModel(modelId) {
  return state.settings.models.find((model) => model.id === modelId) || null;
}

/** Create (but do not persist) a model entry for the given provider + mode. */
export function makeModel({ providerId, mode }) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const fallback = provider.web ? MODE_EMBED : MODE_API;
  const resolvedMode = availableModes(provider).includes(mode) ? mode : fallback;

  return {
    id: uid('m'),
    providerId,
    mode: resolvedMode,
    label: provider.label,
    modelName: resolvedMode === MODE_API ? provider.api.defaultModel : '',
    enabled: true,
    addedAt: Date.now(),
  };
}

export async function addModel({ providerId, mode }) {
  const model = makeModel({ providerId, mode });
  await saveSettings({ models: [...state.settings.models, model] });
  return model;
}

export async function updateModel(modelId, patch) {
  const models = state.settings.models.map((model) =>
    model.id === modelId ? { ...model, ...patch } : model,
  );
  await saveSettings({ models });
}

export async function removeModel(modelId) {
  const models = state.settings.models.filter((model) => model.id !== modelId);
  const apiKeys = { ...state.apiKeys };
  delete apiKeys[modelId];
  state.apiKeys = apiKeys;
  await chrome.storage.local.set({ [KEY_API_KEYS]: apiKeys });
  await saveSettings({ models });
}

export function getApiKey(modelId) {
  return state.apiKeys[modelId] || '';
}

/* ──────────────── applying changes written by another context ──────────────── */

/**
 * Adopt settings that another app tab (or the worker) wrote to storage.
 * Deliberately does NOT write back, so this cannot ping-pong with
 * chrome.storage.onChanged.
 */
export function applySettingsFromStorage(raw) {
  state.settings = withDefaults(raw);
  notify('settings');
}

export function applyApiKeysFromStorage(raw) {
  state.apiKeys = raw && typeof raw === 'object' ? raw : {};
}

export function applyIndexFromStorage(rows) {
  state.index = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id)
    .sort(byUpdatedDesc);
  notify('history');
}

export async function setApiKey(modelId, key) {
  const apiKeys = { ...state.apiKeys };
  if (key) apiKeys[modelId] = key;
  else delete apiKeys[modelId];
  state.apiKeys = apiKeys;
  await chrome.storage.local.set({ [KEY_API_KEYS]: apiKeys });
  notify('settings');
}

/* ───────────────────────────── conversations ───────────────────────────── */

export function makeConversation() {
  const now = Date.now();
  return { id: uid('c'), title: 'New chat', createdAt: now, updatedAt: now, turns: [] };
}

export function activeConversation() {
  if (!state.activeId) return null;
  return state.conversations.get(state.activeId) || null;
}

/** Load a conversation transcript into memory (no-op when cached). */
export async function loadConversation(id) {
  if (state.conversations.has(id)) return state.conversations.get(id);
  const key = CONV_PREFIX + id;
  const stored = await chrome.storage.local.get(key);
  const conv = stored[key];
  if (!conv) return null;
  if (!Array.isArray(conv.turns)) conv.turns = [];
  state.conversations.set(id, conv);
  return conv;
}

export async function setActiveConversation(id) {
  state.activeId = id;
  state.viewTurn = null;
  await chrome.storage.local.set({ [KEY_ACTIVE]: id });
  if (id) await loadConversation(id);
  notify('active');
}

/**
 * Start a new chat **without** a board rebuild.
 *
 * `setActiveConversation(null)` notifies `active`, and the app's listener answers
 * that by re-rendering every column — which recreates the embedded <iframe>s and
 * therefore reloads every provider page (cookie banners, slower, and the panel
 * loses the thread it was showing). Starting a new topic only has to empty this
 * window, so the caller resets the columns in place instead; see `newChat()` in
 * app.js.
 */
export async function startNewChat() {
  state.activeId = null;
  state.viewTurn = null;
  await chrome.storage.local.set({ [KEY_ACTIVE]: null });
  notify('history'); // the sidebar loses its active row; nothing else re-renders
}

function indexEntry(conv) {
  return {
    id: conv.id,
    title: conv.title || 'New chat',
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turnCount: conv.turns.length,
  };
}

/** Persist one conversation (transcript + index row) and refresh the sidebar. */
export async function persistConversation(conv) {
  if (!conv) return;
  conv.updatedAt = Date.now();
  state.conversations.set(conv.id, conv);
  const rows = state.index.filter((row) => row.id !== conv.id);
  rows.push(indexEntry(conv));
  rows.sort(byUpdatedDesc);

  const limit = Math.max(10, Number(state.settings.historyLimit) || 100);
  const kept = rows.slice(0, limit);
  const dropped = rows.slice(limit);

  state.index = kept;
  await chrome.storage.local.set({ [CONV_PREFIX + conv.id]: conv, [KEY_INDEX]: kept });
  if (dropped.length) {
    await chrome.storage.local.remove(dropped.map((row) => CONV_PREFIX + row.id));
    for (const row of dropped) state.conversations.delete(row.id);
  }
  notify('history');
}

export async function deleteConversation(id) {
  state.conversations.delete(id);
  state.index = state.index.filter((row) => row.id !== id);
  if (state.activeId === id) {
    state.activeId = null;
    await chrome.storage.local.set({ [KEY_ACTIVE]: null });
  }
  await chrome.storage.local.remove(CONV_PREFIX + id);
  await chrome.storage.local.set({ [KEY_INDEX]: state.index });
  notify('history');
}

export async function clearAllConversations() {
  const keys = state.index.map((row) => CONV_PREFIX + row.id);
  state.conversations.clear();
  state.index = [];
  state.activeId = null;
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [KEY_INDEX]: [], [KEY_ACTIVE]: null });
  notify('history');
}

/** Turn the current view into the conversation shown on the board. */
export function visibleConversation() {
  const conv = activeConversation();
  return conv;
}

/** Index of the turn the board should display. */
export function visibleTurnIndex(conv) {
  if (!conv || !conv.turns.length) return -1;
  if (state.viewTurn == null) return conv.turns.length - 1;
  return Math.max(0, Math.min(conv.turns.length - 1, state.viewTurn));
}

/** The turn object shown on the board, or null. */
export function visibleTurn(conv = activeConversation()) {
  const index = visibleTurnIndex(conv);
  return index >= 0 ? conv.turns[index] : null;
}
