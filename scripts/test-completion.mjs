#!/usr/bin/env node
/**
 * Unit test for the bridge's completion decision (src/content/completion.js).
 *
 * This is the logic that decides when a browser-session run is over, and it has
 * been wrong twice:
 *   1. it only trusted scraped answer text, so a panel whose answer container the
 *      adapter did not recognise waited for the full timeout;
 *   2. it treated "send button disabled" as "still generating" — but the send
 *      button of an *empty* composer is disabled on every provider, which is
 *      exactly the state after submitting. That made every such run hang until
 *      the timeout with the Stop button staring at the user.
 *
 * The rule now is the one the user asked for: a model is done when its page is
 * ready for the next question (composer available, the site's own stop control
 * gone) — with a bounded grace period for pages that show no signals at all.
 *
 * No browser needed: the module is loaded into a `vm` sandbox with a fake
 * `window`, so every branch can be asserted deterministically.
 *
 * Usage: node scripts/test-completion.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'extension', 'src', 'content', 'completion.js');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: 'completion.js' });

const { decide } = sandbox.window.MultiChatAICompletion;
if (typeof decide !== 'function') {
  console.error('✗ completion.js did not expose decide()');
  process.exit(1);
}

/** An ordinary finished turn: the page was busy, then went idle with text. */
const base = {
  hasComposer: true,
  busy: false,
  sawBusy: true,
  elapsedMs: 6000,
  quietMs: 3000,
  stablePolls: 2,
  readyPolls: 3,
  haveText: true,
};

const cases = [
  {
    name: 'the site is still generating (stop control on screen) → keep waiting',
    state: { ...base, busy: true, quietMs: 800 },
    expected: 'wait',
  },
  {
    name: 'answer settled, page ready for the next question → done',
    state: { ...base },
    expected: 'done',
  },
  {
    name: 'text still changing → keep waiting',
    state: { ...base, quietMs: 200, stablePolls: 0 },
    expected: 'wait',
  },
  {
    name: 'too early to trust an idle page (first 2s) → keep waiting',
    state: { ...base, elapsedMs: 1200 },
    expected: 'wait',
  },
  {
    name: 'answered but the adapter cannot read the text → done-no-text',
    state: { ...base, haveText: false, stablePolls: 1 },
    expected: 'done-no-text',
  },
  {
    name: 'regression: idle page with an empty composer (send button disabled) is not "busy"',
    state: {
      ...base,
      haveText: false,
      sawBusy: false,
      stablePolls: 0,
      elapsedMs: 6000,
      quietMs: 6000,
      readyPolls: 3,
    },
    expected: 'wait', // inside the no-signal grace window, but working towards done
  },
  {
    name: 'page never showed any signal and the grace period is over → give up waiting',
    state: {
      hasComposer: true,
      busy: false,
      sawBusy: false,
      elapsedMs: 21000,
      quietMs: 21000,
      stablePolls: 0,
      readyPolls: 4,
      haveText: false,
    },
    expected: 'done-no-text',
  },
  {
    name: 'page has no usable composer (loading / sign-in) → never done',
    state: { ...base, hasComposer: false, elapsedMs: 90000 },
    expected: 'wait',
  },
  {
    name: 'idle for a single poll only (a blip) → keep waiting',
    state: { ...base, readyPolls: 1 },
    expected: 'wait',
  },
  {
    name: 'a site that never drops its stop control → finish after the long quiet window',
    state: { ...base, busy: true, quietMs: 95000, stablePolls: 20 },
    expected: 'done',
  },
  {
    name: 'right after Send an idle-looking page is not done yet',
    state: {
      hasComposer: true,
      busy: false,
      sawBusy: false,
      elapsedMs: 2000,
      quietMs: 2000,
      stablePolls: 0,
      readyPolls: 2,
      haveText: false,
    },
    expected: 'wait',
  },
  {
    name: 'text settled but the site still says busy → keep waiting',
    state: { ...base, busy: true, quietMs: 4000, stablePolls: 5 },
    expected: 'wait',
  },
];

let failures = 0;
for (const testCase of cases) {
  const actual = decide(testCase.state);
  const ok = actual === testCase.expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${testCase.name} — ${actual}${ok ? '' : ` (expected ${testCase.expected})`}`,
  );
}

console.log(`\n${cases.length - failures}/${cases.length} completion checks passed`);
if (failures) process.exit(1);
