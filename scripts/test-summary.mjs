#!/usr/bin/env node
/**
 * Unit tests for src/app/summary-request.js — the prompt that asks one model to
 * write the comparison summary, plus the Markdown the Copy button produces.
 *
 * No browser, no network: the exact text is the contract, so it can be pinned
 * down here.
 *
 * Usage: node scripts/test-summary.mjs
 */

import { buildSummaryPrompt, summaryCopyText, summaryLinksMarkdown } from '../extension/src/app/summary-request.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const SOURCES = [
  {
    key: 'm1',
    name: 'llama3.2',
    modeLabel: 'via API',
    text: '- Latency matters more than raw quality.\n- Cats are independent and quiet.',
    threadUrl: 'https://chatgpt.com/c/abc',
  },
  {
    key: 'm2',
    name: 'qwen2.5',
    modeLabel: 'in its browser panel',
    text: '- Latency matters more than raw quality.\n- Cats are affectionate when they choose.',
    threadUrl: '',
  },
];

const built = buildSummaryPrompt({
  question: 'Compare cats and dogs',
  sources: SOURCES,
});

/* ── 1. shape ──────────────────────────────────────────────────────────── */

check(
  'the prompt asks for “Agreed” and a difference table',
  built.prompt.includes('### Agreed') && built.prompt.includes('### Where they differ'),
);
check('the prompt carries the question', built.prompt.includes('THE QUESTION\nCompare cats and dogs'));
check(
  'every model is listed with its own answer',
  built.prompt.includes('=== 1. llama3.2, via API ===') &&
    built.prompt.includes('=== 2. qwen2.5, in its browser panel ===') &&
    built.prompt.includes('Cats are independent and quiet.') &&
    built.prompt.includes('Cats are affectionate when they choose.'),
);
check(
  'the table has one column per model, in board order',
  built.prompt.includes('| Item | llama3.2 | qwen2.5 |') &&
    built.prompt.includes('One column per model, in this order: llama3.2, qwen2.5.'),
);
check(
  'the model is told not to invent links',
  /Do not add a preamble, a closing remark, sources or links/.test(built.prompt),
);
check('both answers are counted', built.answeredCount === 2, `${built.answeredCount}`);

/* ── 2. missing text and truncation ────────────────────────────────────── */

const partial = buildSummaryPrompt({
  question: 'Compare cats and dogs',
  sources: [...SOURCES, { key: 'm3', name: 'mistral', text: '   ' }],
});
check(
  'a model with no readable answer is marked and named in the rules',
  partial.prompt.includes('=== 3. mistral ===\n(no readable answer') &&
    partial.prompt.includes('mistral produced no readable answer'),
  `answered=${partial.answeredCount}`,
);

const long = buildSummaryPrompt({
  question: 'Compare',
  sources: [
    { key: 'a', name: 'A', text: `${'First sentence about latency. '.repeat(300)}LAST-WORDS-AT-THE-END` },
    { key: 'b', name: 'B', text: 'Short answer.' },
  ],
  perAnswerLimit: 500,
  totalLimit: 4000,
});
check(
  'a long answer is cut evenly, and says so',
  long.prompt.includes('[answer cut here]') && !long.prompt.includes('LAST-WORDS-AT-THE-END'),
  `${long.models[0].chars} chars kept`,
);
check(
  'a short answer is left alone',
  long.models[1].chars === 'Short answer.'.length && long.models[1].truncated === false,
);
check(
  'the answer section stays inside the budget',
  long.totalChars <= 4000 && long.share <= 500,
  `${long.totalChars} chars · share ${long.share}`,
);

/* ── 3. whole-chat wording ─────────────────────────────────────────────── */

const wholeChat = buildSummaryPrompt({
  scope: 'chat',
  sources: [
    {
      key: 'm1',
      name: 'llama3.2',
      text: '[Turn 1] Q: first\nA: one\n\n[Turn 2] Q: second\nA: two',
    },
  ],
});
check(
  'a whole-chat summary is labelled per turn',
  wholeChat.prompt.includes('THE CONVERSATION') &&
    wholeChat.prompt.includes('[Turn 1] Q: first') &&
    wholeChat.prompt.includes('[Turn 2] Q: second'),
);
check('a whole-chat prompt does not claim a single question', !wholeChat.prompt.includes('THE QUESTION'));

/* ── 4. determinism and unicode ────────────────────────────────────────── */

const again = buildSummaryPrompt({ question: 'Compare cats and dogs', sources: SOURCES });
check('the same answers produce the same prompt', again.prompt === built.prompt);

const chinese = buildSummaryPrompt({
  question: '比较猫和狗',
  sources: [{ key: 'a', name: '模型A', text: '猫比较独立，适合小户型。' }],
});
check(
  'Chinese questions and answers survive verbatim',
  chinese.prompt.includes('比较猫和狗') && chinese.prompt.includes('猫比较独立，适合小户型。'),
);

/* ── 5. copy & links ───────────────────────────────────────────────────── */

const links = summaryLinksMarkdown(SOURCES);
check(
  'links list the provider thread and say when there is none',
  links.includes('- llama3.2: https://chatgpt.com/c/abc') && links.includes('- qwen2.5: no saved link'),
  links.split('\n')[1],
);

const copy = summaryCopyText({ text: '### Agreed\n\n- latency', modelName: 'llama3.2', models: SOURCES });
check(
  'copy text is the summary plus the links',
  copy.startsWith('## Summary by llama3.2') && copy.includes('- latency') && copy.includes('no saved link'),
);

/* ── summary ───────────────────────────────────────────────────────────── */

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} summary-request checks passed`);
if (failed.length) {
  console.error('\n✗ failed:');
  for (const entry of failed) console.error(`  - ${entry.name}`);
  process.exit(1);
}
console.log('✓ all good (extension/src/app/summary-request.js)');
