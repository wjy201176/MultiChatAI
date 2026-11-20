/**
 * Run policy for the app page: when is a model's answer over, and when do we
 * stop waiting for it no matter what?
 *
 * The worker reports a finished answer with a `final` message, but the app must
 * not *depend* on that message: the MV3 service worker can be restarted mid-run
 * (then its run registry is gone and no `final` will ever arrive), and a page
 * adapter can fail to recognise an answer. Two independent safety nets live here:
 *
 *   1. panel readiness — an embedded panel pushes its own state (“composer is
 *      back, stop control gone”) every 1.5s; that *is* “this model is ready for
 *      the next question”, which is what the user asked to be measured.
 *   2. a hard deadline per model — the last resort that guarantees the Stop
 *      button can never stay on screen forever.
 *
 * Both functions are pure and unit-tested by scripts/test-run-policy.mjs.
 */

/** A panel cannot be "ready for the next question" this soon after Send. */
export const MIN_READY_MS = 2000;
/** Consecutive readiness reports before the verdict is trusted. */
export const READY_STREAK = 2;
/** Nothing at all heard from the panel: give up waiting after this. */
export const NO_SIGNAL_MS = 20000;
/** Extra time on top of the model timeout before the app gives up on its own. */
export const DEADLINE_SLACK_MS = 25000;
/** Never let a single model hold the composer longer than this. */
export const MAX_DEADLINE_MS = 300000;

/**
 * Absolute time by which a model's answer must be settled, whatever happens.
 * @param {{startedAt: number, timeoutSec?: number, slackMs?: number}} options
 */
export function runDeadline({ startedAt, timeoutSec, slackMs = DEADLINE_SLACK_MS }) {
  const budget = Math.max(30, Number(timeoutSec) || 180) * 1000;
  return startedAt + Math.min(budget + slackMs, MAX_DEADLINE_MS);
}

/**
 * Verdict for one model from a panel readiness report.
 *
 * @param {Object} state
 * @param {boolean} state.ready       composer present and not generating
 * @param {boolean} state.busy        the site's stop control is on screen
 * @param {number}  state.readyStreak consecutive readiness reports
 * @param {number}  state.elapsedMs   time since this model was asked
 * @param {boolean} state.busySeen    the panel was busy at least once
 * @param {boolean} state.textSeen    streamed text arrived at least once
 * @param {boolean} state.haveText    there is text to keep in the transcript
 * @returns {'wait'|'done'|'done-no-text'}
 */
export function panelVerdict(state) {
  const {
    ready = false,
    busy = false,
    readyStreak = 0,
    elapsedMs = 0,
    busySeen = false,
    textSeen = false,
    haveText = false,
  } = state || {};

  if (busy) return 'wait';
  if (!ready) return 'wait';
  if (elapsedMs < MIN_READY_MS) return 'wait';
  if (readyStreak < READY_STREAK) return 'wait';

  // The panel worked on this prompt and is ready again → the answer is over.
  if (busySeen || textSeen) return haveText ? 'done' : 'done-no-text';

  // It never showed any sign of working on the prompt: it may still be
  // generating with no signal we can read, so keep waiting for a grace period.
  if (elapsedMs > NO_SIGNAL_MS) return haveText ? 'done' : 'done-no-text';

  return 'wait';
}
