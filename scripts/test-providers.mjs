#!/usr/bin/env node
/**
 * Unit test for the provider catalog's conversation-link recognition
 * (`threadUrlFor` in src/shared/providers.js).
 *
 * Why it matters: reopening a topic means pointing the column at the model's **own**
 * URL for that chat, because only the provider's page restores the whole rendering
 * (charts, tables, artifacts). Recognising that URL is therefore the difference
 * between “the real conversation comes back” and “a plain-text copy of it”.
 *
 * The module is a plain ES module in a checkout that is not `type: module`, so it
 * is copied to a temporary .mjs before importing (it has no relative imports).
 *
 * Usage: node scripts/test-providers.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'extension', 'src', 'shared', 'providers.js');

const copy = path.join(os.tmpdir(), `multichatai-providers-${process.pid}.mjs`);
fs.copyFileSync(SOURCE, copy);
let providers;
try {
  providers = await import(pathToFileURL(copy).href);
} finally {
  fs.rmSync(copy, { force: true });
}

const { threadUrlFor, listProviders } = providers;
if (typeof threadUrlFor !== 'function') {
  console.error('✗ providers.js did not export threadUrlFor()');
  process.exit(1);
}

const CHATGPT_THREAD = 'https://chatgpt.com/c/68f0c1d2-aaaa-bbbb-cccc-1234567890ab';

/** [description, providerId, url, expected] */
const cases = [
  ['chatgpt conversation link', 'chatgpt', CHATGPT_THREAD, CHATGPT_THREAD],
  [
    'chatgpt link with tracking query → canonical',
    'chatgpt',
    `${CHATGPT_THREAD}?model=auto&utm_source=x`,
    CHATGPT_THREAD,
  ],
  ['chatgpt link with a trailing slash → canonical', 'chatgpt', `${CHATGPT_THREAD}/`, CHATGPT_THREAD],
  [
    'chatgpt conversation inside a custom GPT (/g/…/c/…)',
    'chatgpt',
    'https://chatgpt.com/g/g-abc123-cat-helper/c/68f0c1d2-aaaa',
    'https://chatgpt.com/g/g-abc123-cat-helper/c/68f0c1d2-aaaa',
  ],
  ['chatgpt landing page is not a conversation', 'chatgpt', 'https://chatgpt.com/', ''],
  ['claude conversation link', 'claude', 'https://claude.ai/chat/1f2e3d4c-5566', 'https://claude.ai/chat/1f2e3d4c-5566'],
  ['claude “new chat” page is not a conversation', 'claude', 'https://claude.ai/new', ''],
  ['gemini conversation link', 'gemini', 'https://gemini.google.com/app/6a1b2c3d4', 'https://gemini.google.com/app/6a1b2c3d4'],
  ['gemini landing page is not a conversation', 'gemini', 'https://gemini.google.com/app', ''],
  ['deepseek conversation link', 'deepseek', 'https://chat.deepseek.com/a/chat/s/abc-123', 'https://chat.deepseek.com/a/chat/s/abc-123'],
  ['deepseek landing page is not a conversation', 'deepseek', 'https://chat.deepseek.com/', ''],
  ['grok conversation link', 'grok', 'https://grok.com/chat/0f9e8d7c', 'https://grok.com/chat/0f9e8d7c'],
  ['copilot conversation link', 'copilot', 'https://copilot.microsoft.com/chats/abc123', 'https://copilot.microsoft.com/chats/abc123'],
  ['perplexity thread link', 'perplexity', 'https://www.perplexity.ai/search/how-to-cook-rice-AbC123', 'https://www.perplexity.ai/search/how-to-cook-rice-AbC123'],
  ['qwen conversation link', 'qwen', 'https://chat.qwen.ai/c/abc-123', 'https://chat.qwen.ai/c/abc-123'],
  ['kimi conversation link', 'kimi', 'https://www.kimi.com/chat/123456', 'https://www.kimi.com/chat/123456'],
  ['another provider’s link is rejected', 'claude', CHATGPT_THREAD, ''],
  ['a non-http URL is rejected', 'chatgpt', 'javascript:alert(1)', ''],
  ['an empty URL is rejected', 'chatgpt', '', ''],
  ['an unknown provider is rejected', 'nope', CHATGPT_THREAD, ''],
];

let failures = 0;
for (const [name, providerId, url, expected] of cases) {
  const actual = threadUrlFor(providerId, url);
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${name} — ${actual ? actual : '(none)'}${
      ok ? '' : ` (expected ${expected || '(none)'})`
    }`,
  );
}

// Every browser-session provider needs a pattern, or history for it can only ever
// fall back to the text copy.
const webProviders = listProviders().filter((provider) => provider.web);
const missing = webProviders.filter((provider) => !(provider.web.thread instanceof RegExp));
if (missing.length) failures += 1;
console.log(
  `${missing.length ? '  ✗' : '  ✓'} every browser-session provider declares a conversation link pattern — ${
    webProviders.length
  } provider(s)${missing.length ? `, missing: ${missing.map((p) => p.id).join(', ')}` : ''}`,
);

const total = cases.length + 1;
console.log(`\n${total - failures}/${total} provider checks passed`);
if (failures) process.exit(1);
