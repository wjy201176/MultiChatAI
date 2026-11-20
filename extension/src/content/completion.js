/**
 * Completion state machine for the browser-session bridge.
 *
 * Loaded as a classic content script before bridge.js (MV3 content scripts are
 * not modules), and unit-tested in Node by scripts/test-completion.mjs.
 *
 * Why a separate file: deciding "did the model finish?" is the difference between
 * a lively chat and a Stop button the user has to press by hand. The decision is
 * based on the page's own state machine — *is this page ready for the next
 * question?* — not on scraped text and not on the send button:
 *
 *   busy      the site is generating (its own stop control is on screen)
 *   ready     the composer is there and no stop control is on screen
 *
 * A **disabled send button** must never mean "busy": on almost every provider the
 * send button is disabled while the composer is empty, which is exactly the state
 * you are in once the prompt has been submitted. Treating that as "generating"
 * made every run wait for the full timeout with the Stop button on screen after
 * every model had visibly answered.
 *
 * `decide` is pure: give it the observed state, get the verdict.
 */
window.MultiChatAICompletion = (function () {
  'use strict';

  /** A page cannot be "ready for the next question" this soon after Send. */
  const MIN_ELAPSED_MS = 2000;
  /** With text in hand: how long the text must have been stable. */
  const TEXT_QUIET_MS = 1500;
  /** Consecutive idle polls before "ready" is trusted (one poll is a blip). */
  const READY_POLLS = 2;
  /** No busy signal and no readable text at all: stop waiting after this. */
  const NO_SIGNAL_MS = 20000;
  /** A page that keeps a stop control up forever: give up on it eventually. */
  const STUCK_BUSY_QUIET_MS = 90000;

  /**
   * @param {Object} state
   * @param {boolean} state.hasComposer  the page shows a usable message box
   * @param {boolean} state.busy         the site's stop control is on screen
   * @param {boolean} state.sawBusy      the site was busy at least once
   * @param {number}  state.elapsedMs    time since the prompt was sent
   * @param {number}  state.quietMs      time since the answer text last changed
   * @param {number}  state.stablePolls  consecutive polls with unchanged text
   * @param {number}  state.readyPolls   consecutive polls that looked idle
   * @param {boolean} state.haveText     any answer text was captured
   * @returns {'wait'|'done'|'done-no-text'}
   */
  function decide(state) {
    const {
      hasComposer = false,
      busy = false,
      sawBusy = false,
      elapsedMs = 0,
      quietMs = 0,
      stablePolls = 0,
      readyPolls = 0,
      haveText = false,
    } = state || {};

    // The page is not usable (still loading, sign-in screen): nothing to decide.
    if (!hasComposer) return 'wait';

    if (busy) {
      // Last resort for a page that never takes its stop control down.
      if (haveText && quietMs > STUCK_BUSY_QUIET_MS) return 'done';
      return 'wait';
    }

    if (elapsedMs < MIN_ELAPSED_MS) return 'wait';

    // Text in hand: it must have stopped changing before we call it final.
    if (haveText && (quietMs < TEXT_QUIET_MS || stablePolls < 1)) return 'wait';

    // The page looked idle for a couple of polls and we know it worked on this
    // prompt (it was busy, or text arrived) → the model is ready for the next one.
    if ((sawBusy || haveText) && readyPolls >= READY_POLLS) {
      return haveText ? 'done' : 'done-no-text';
    }

    // Nothing on the page ever told us this prompt was being answered. Keep the
    // run open for a grace period (some pages hide their stop control while
    // generating), then let the user ask the next question instead of blocking.
    if (!sawBusy && !haveText && elapsedMs > NO_SIGNAL_MS && readyPolls >= 1) {
      return 'done-no-text';
    }

    return 'wait';
  }

  return { decide };
})();
