/**
 * Bridge hub — the service worker's side of the browser-session protocol.
 *
 * The content script in a provider tab streams three message types back:
 *   MULTICHAI_PROGRESS { runId, text, phase }
 *   MULTICHAI_RESULT   { runId, ok, text, error, hint, stopped }
 * plus the synchronous MULTICHAI_PING probe used for status checks.
 *
 * `runId` here is a bridge-scoped id (one per model per turn), so two columns
 * asking the same provider at the same time cannot cross their streams.
 */

/** @type {Map<string, {resolve: Function, reject: Function, onProgress?: Function, onAbort?: Function}>} */
const pending = new Map();

let counter = 0;

export function createBridgeRunId() {
  counter = (counter + 1) % 1e6;
  return `b${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * @param {string} runId
 * @param {{resolve: Function, reject: Function, onProgress?: Function}} handlers
 */
export function expectBridgeRun(runId, handlers) {
  pending.set(runId, handlers);
}

export function forgetBridgeRun(runId) {
  pending.delete(runId);
}

/** Resolve a bridge run locally (used when the user presses Stop). */
export function settleBridgeRun(runId, text, stopped = true) {
  const entry = pending.get(runId);
  if (!entry) return;
  pending.delete(runId);
  entry.resolve({ text: text || '', stopped });
}

/**
 * Route a content-script message to the waiting run.
 * @returns {boolean} true when the message belonged to a known run
 */
export function handleBridgeMessage(message) {
  if (!message || !message.runId) return false;
  const entry = pending.get(message.runId);
  if (!entry) return false;

  if (message.type === 'MULTICHAI_PROGRESS') {
    if (typeof entry.onProgress === 'function') {
      entry.onProgress(message.text || '', message.phase || 'streaming');
    }
    return true;
  }

  if (message.type === 'MULTICHAI_RESULT') {
    pending.delete(message.runId);
    if (message.ok) {
      entry.resolve({
        text: message.text || '',
        stopped: Boolean(message.stopped),
        captured: message.captured !== false,
        // The rendered answer, for replaying history without reloading the site.
        html: typeof message.html === 'string' ? message.html : '',
      });
    } else {
      const error = new Error(message.error || 'The site adapter failed.');
      error.hint = message.hint || null;
      error.name = 'BridgeError';
      entry.reject(error);
    }
    return true;
  }

  return false;
}

/** Number of in-flight browser-session runs (used by the worker health log). */
export function pendingBridgeRuns() {
  return pending.size;
}
