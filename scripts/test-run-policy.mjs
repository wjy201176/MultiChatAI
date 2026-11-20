#!/usr/bin/env node
/**
 * Unit test for the app's run policy (src/app/run-policy.js).
 *
 * Two guarantees are asserted here, because both were broken in practice:
 *   - a column settles when its panel reports "ready for the next question",
 *     not only when the worker manages to send a `final` message;
 *   - every model has a deadline, so the Stop button can never stay on screen
 *     (and the composer can never stay locked) forever.
 *
 * The module is a plain ES module, but this checkout is not a `type: module`
 * package, so it is copied to a temporary .mjs file before importing. It has no
 * relative imports of its own, so the copy is self-contained.
 *
 * Usage: node scripts/test-run-policy.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'extension', 'src', 'app', 'run-policy.js');

const copy = path.join(os.tmpdir(), `multichatai-run-policy-${process.pid}.mjs`);
fs.copyFileSync(SOURCE, copy);
let mod;
try {
  mod = await import(pathToFileURL(copy).href);
} finally {
  fs.rmSync(copy, { force: true });
}

const { panelVerdict, runDeadline, MIN_READY_MS, NO_SIGNAL_MS } = mod;
if (typeof panelVerdict !== 'function' || typeof runDeadline !== 'function') {
  console.error('✗ run-policy.js did not export panelVerdict()/runDeadline()');
  process.exit(1);
}

/** A panel that was busy and is now ready, with an answer already captured. */
const base = {
  ready: true,
  busy: false,
  readyStreak: 2,
  elapsedMs: 8000,
  busySeen: true,
  textSeen: true,
  haveText: true,
};

const cases = [
  {
    name: 'panel is generating → wait',
    state: { ...base, busy: true },
    expected: 'wait',
  },
  {
    name: 'panel has no composer yet → wait',
    state: { ...base, ready: false },
    expected: 'wait',
  },
  {
    name: 'ready only once (a blip) → wait',
    state: { ...base, readyStreak: 1 },
    expected: 'wait',
  },
  {
    name: 'ready right after Send → wait',
    state: { ...base, elapsedMs: MIN_READY_MS - 500 },
    expected: 'wait',
  },
  {
    name: 'was busy, ready again, text captured → done',
    state: { ...base },
    expected: 'done',
  },
  {
    name: 'was busy, ready again, no readable text → done-no-text',
    state: { ...base, haveText: false },
    expected: 'done-no-text',
  },
  {
    name: 'text streamed in, ready again → done',
    state: { ...base, busySeen: false, textSeen: true },
    expected: 'done',
  },
  {
    name: 'no signal at all, still inside the grace window → wait',
    state: { ...base, busySeen: false, textSeen: false, haveText: false, elapsedMs: 9000 },
    expected: 'wait',
  },
  {
    name: 'no signal at all, grace window over → done-no-text',
    state: {
      ...base,
      busySeen: false,
      textSeen: false,
      haveText: false,
      elapsedMs: NO_SIGNAL_MS + 1000,
    },
    expected: 'done-no-text',
  },
];

let failures = 0;
for (const testCase of cases) {
  const actual = panelVerdict(testCase.state);
  const ok = actual === testCase.expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${testCase.name} — ${actual}${ok ? '' : ` (expected ${testCase.expected})`}`,
  );
}

/* ── deadlines: the guarantee that Stop can never wedge ───────────────────── */

const startedAt = 1_000_000;
const deadlineCases = [
  {
    name: 'default 180s timeout gets a 25s slack',
    actual: runDeadline({ startedAt, timeoutSec: 180 }),
    expected: startedAt + 205_000,
  },
  {
    name: 'a short timeout still leaves room for the page',
    actual: runDeadline({ startedAt, timeoutSec: 30 }),
    expected: startedAt + 55_000,
  },
  {
    name: 'a huge timeout is capped',
    actual: runDeadline({ startedAt, timeoutSec: 3600 }),
    expected: startedAt + 300_000,
  },
  {
    name: 'a missing timeout falls back to 180s',
    actual: runDeadline({ startedAt }),
    expected: startedAt + 205_000,
  },
];

for (const testCase of deadlineCases) {
  const ok = testCase.actual === testCase.expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${testCase.name} — +${testCase.actual - startedAt}ms${
      ok ? '' : ` (expected +${testCase.expected - startedAt}ms)`
    }`,
  );
}

const total = cases.length + deadlineCases.length;
console.log(`\n${total - failures}/${total} run-policy checks passed`);
if (failures) process.exit(1);
