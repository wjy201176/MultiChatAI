#!/usr/bin/env node
/**
 * Produce the documentation screenshots.
 *
 * Runs the extension against the mock provider in headless Edge, builds a
 * three-model conversation (plus a second conversation for the history list),
 * then captures:
 *   docs/screenshot-main.png      the three-column comparison window
 *   docs/screenshot-summary.png   the summary of that round
 *   docs/screenshot-settings.png  Settings → Models
 *   docs/screenshot-light.png     the same window in the light theme
 *
 * Usage: node scripts/screenshot.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtensionBrowser, sleep, waitFor } from './lib/harness.mjs';
import { startMockProvider } from './lib/mock-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const DOCS = path.join(ROOT, 'docs');

const setInput = (selector, value, eventName = 'change') => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return 'missing';
  field.value = ${JSON.stringify(value)};
  field.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
  return field.value;
})()`;

const typePrompt = (text) => `(() => {
  const prompt = document.getElementById('prompt');
  prompt.value = ${JSON.stringify(text)};
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  return prompt.value;
})()`;

async function addModel(cdp, modelName) {
  await cdp.evaluate(`document.getElementById('settings-btn').click()`);
  await sleep(250);
  await cdp.evaluate(setInput('#add-provider', 'ollama'));
  await sleep(200);
  await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
  await sleep(500);
  const cards = await cdp.evaluate(`document.querySelectorAll('.model-card').length`);
  await cdp.evaluate(setInput(`.model-card:nth-child(${cards}) input[data-act="model-name"]`, modelName));
  await sleep(250);
  await cdp.evaluate(`document.getElementById('settings-back').click()`);
  await sleep(250);
}

async function ask(cdp, text) {
  await cdp.evaluate(typePrompt(text));
  await cdp.evaluate(`document.getElementById('send-btn').click()`);
  await waitFor(
    async () =>
      cdp.evaluate(
        `document.getElementById('stop-btn').hidden &&
         Array.from(document.querySelectorAll('.column-status')).every(s => s.dataset.state === 'done')`,
      ),
    40000,
    250,
  );
  await sleep(300);
}

async function capture(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

async function main() {
  const mock = await startMockProvider();
  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9800 + Math.floor(Math.random() * 90),
  });

  let cdp;
  try {
    cdp = await browser.openApp();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await addModel(cdp, 'llama3.2');
    await addModel(cdp, 'qwen2.5');
    await addModel(cdp, 'mistral');

    await ask(cdp, 'Compare RAG and fine-tuning for a 50-person support team. Three bullets each.');

    // A second conversation, so the sidebar shows a real history list.
    await cdp.evaluate(`document.getElementById('new-chat').click()`);
    await sleep(400);
    await ask(cdp, 'Draft a polite follow-up email to a customer who reported a shipping delay.');

    // Back to the three-model comparison for the hero shot.
    await cdp.evaluate(`document.querySelectorAll('.history-open')[1]?.click()`);
    await sleep(700);
    await capture(cdp, path.join(DOCS, 'screenshot-main.png'));

    // The same round, summarised by a model: bullets, the table, the chat links.
    await cdp.evaluate(`document.getElementById('summarize-btn').click()`);
    await waitFor(
      async () =>
        cdp.evaluate(
          `!document.getElementById('summary-panel').hidden &&
           document.getElementById('summary-stop').hidden &&
           document.getElementById('summary-body').querySelector('.answer') !== null`,
        ),
      40000,
      250,
    );
    await sleep(400);
    await capture(cdp, path.join(DOCS, 'screenshot-summary.png'));
    await cdp.evaluate(`document.getElementById('summary-close').click()`);
    await sleep(300);

    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(500);
    await capture(cdp, path.join(DOCS, 'screenshot-settings.png'));
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    // Light theme.
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('#settings-nav [data-section="general"]').click()`);
    await sleep(300);
    await cdp.evaluate(setInput('#theme-select', 'light'));
    await sleep(400);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(500);
    await capture(cdp, path.join(DOCS, 'screenshot-light.png'));

    // 4) Empty state: back to the dark theme, remove every model, capture the
    //    "Please add a model" panel with a locked composer.
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('#settings-nav [data-section="general"]').click()`);
    await sleep(250);
    await cdp.evaluate(setInput('#theme-select', 'dark'));
    await sleep(300);
    await cdp.evaluate(`document.querySelector('#settings-nav [data-section="models"]').click()`);
    await sleep(300);
    for (let index = 0; index < 3; index += 1) {
      await cdp.evaluate(`document.querySelector('.model-card [data-act="remove"]')?.click()`);
      await sleep(350);
    }
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(500);
    await capture(cdp, path.join(DOCS, 'screenshot-empty.png'));

    // 5) Embedded web chat next to a normal column.
    //    Ollama answers from the mock; ChatGPT's own UI is embedded in its column.
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(setInput('#add-provider', 'ollama'));
    await sleep(250);
    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(400);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    await ask(cdp, 'Left column: an API answer. Right column: the real web chat, embedded.');

    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(setInput('#add-provider', 'chatgpt'));
    await sleep(250);
    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(400);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(5000); // let the embedded provider page paint
    await capture(cdp, path.join(DOCS, 'screenshot-embed.png'));

    // 6) Opening an old topic: embedded columns show their saved transcript.
    await cdp.evaluate(`(async () => {
      const stored = await chrome.storage.local.get(['settings', 'conversationIndex']);
      const models = (stored.settings.models || []);
      const embed = models.find((entry) => entry.mode === 'embed');
      const api = models.find((entry) => entry.mode === 'api');
      if (!embed || !api) return;
      const now = Date.now();
      const conv = {
        id: 'c_history',
        title: 'Compare RAG and fine-tuning for a 50-person…',
        createdAt: now - 3600000,
        updatedAt: now - 300000,
        turns: [{
          id: 't_history',
          prompt: 'Compare RAG and fine-tuning for a 50-person support team. Three bullets each.',
          attachments: [],
          createdAt: now - 3600000,
          answers: {
            [api.id]: {
              providerId: api.providerId, label: api.label, mode: 'api', modelName: api.modelName,
              text: '**llama3.2** — RAG keeps facts in an index you can update daily; fine-tuning bakes behaviour into the weights, so a corrected policy means a new training run.',
              status: 'done', startedAt: now - 3600000, endedAt: now - 3599000, ms: 1000
            },
            [embed.id]: {
              providerId: embed.providerId, label: embed.label, mode: 'embed',
              text: 'ChatGPT: use retrieval for frequently changing support content and a small fine-tune only for tone. Keep the two separate so you can ship a policy change without retraining.',
              status: 'done', startedAt: now - 3600000, endedAt: now - 3599000, ms: 1000
            }
          }
        }]
      };
      const index = (stored.conversationIndex || []).filter((row) => row.id !== conv.id);
      index.unshift({ id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, turnCount: 1 });
      await chrome.storage.local.set({
        ['conv:' + conv.id]: conv,
        conversationIndex: index,
        activeConversationId: conv.id
      });
    })()`, true);
    await cdp.send('Page.reload');
    await sleep(2500);
    await capture(cdp, path.join(DOCS, 'screenshot-history.png'));
  } finally {
    cdp?.close();
    await browser.close();
    await mock.close();
  }
}

main().catch((error) => {
  console.error(`✗ screenshot run failed: ${error.message}`);
  process.exit(1);
});
