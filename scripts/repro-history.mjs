#!/usr/bin/env node
/**
 * Reproduce: click an older history entry and check what the window shows.
 *
 * Builds two conversations against the mock provider, clicks the older one, and
 * prints the title / meta / rendered answers / stored active id — then sends a
 * follow-up to see whether it appends to that conversation or starts a new one.
 *
 * Usage: node scripts/repro-history.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtensionBrowser, sleep, waitFor } from './lib/harness.mjs';
import { startMockProvider } from './lib/mock-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

const typePrompt = (text) => `(() => {
  const prompt = document.getElementById('prompt');
  prompt.value = ${JSON.stringify(text)};
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  return prompt.value;
})()`;

const snapshot = `(async () => {
  const stored = await chrome.storage.local.get(['activeConversationId', 'conversationIndex']);
  const rows = Array.from(document.querySelectorAll('.history-item')).map((item) => ({
    id: item.getAttribute('data-id'),
    title: item.querySelector('.history-title')?.textContent,
    active: item.classList.contains('is-active'),
  }));
  return JSON.stringify({
    title: document.getElementById('conversation-title')?.textContent,
    meta: document.getElementById('conversation-meta')?.textContent,
    answers: Array.from(document.querySelectorAll('.column .answer')).map((el) => (el.innerText || '').slice(0, 60)),
    statuses: Array.from(document.querySelectorAll('.column .column-status')).map((el) => el.textContent.trim()),
    picker: document.querySelectorAll('#turn-picker option').length,
    storedActiveId: stored.activeConversationId,
    rows,
    indexTurns: (stored.conversationIndex || []).map((row) => ({ id: row.id, title: row.title, turns: row.turnCount })),
  });
})()`;

async function send(cdp, text) {
  await cdp.evaluate(typePrompt(text));
  await cdp.evaluate(`document.getElementById('send-btn').click()`);
  await waitFor(
    async () =>
      cdp.evaluate(
        `document.getElementById('stop-btn').hidden &&
         Array.from(document.querySelectorAll('.column-status')).every((el) => el.dataset.state === 'done')`,
      ),
    25000,
    250,
  );
  await sleep(400);
}

async function main() {
  const mock = await startMockProvider();
  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9980 + Math.floor(Math.random() * 15),
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

    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(`(() => {
      const provider = document.querySelector('#add-provider');
      provider.value = 'ollama';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      const mode = document.querySelector('#add-mode');
      mode.value = 'api';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
      return provider.value;
    })()`);
    await sleep(250);
    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(500);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    console.log('--- conversation 1 -------------------------------');
    await send(cdp, 'first topic question');
    console.log(await cdp.evaluate(snapshot, true));

    await cdp.evaluate(`document.getElementById('new-chat').click()`);
    await sleep(500);
    console.log('\n--- after New chat -------------------------------');
    console.log(await cdp.evaluate(snapshot, true));

    console.log('\n--- conversation 2 -------------------------------');
    await send(cdp, 'second topic question');
    console.log(await cdp.evaluate(snapshot, true));

    const olderId = JSON.parse(await cdp.evaluate(snapshot, true)).rows.slice(-1)[0].id;
    console.log(`\n--- clicking the older entry (${olderId}) --------`);
    await cdp.evaluate(`document.querySelector('.history-item[data-id="${olderId}"] .history-open').click()`);
    await sleep(900);
    const afterOpen = await cdp.evaluate(snapshot, true);
    console.log(afterOpen);

    console.log('\n--- follow-up question on the restored topic -----');
    await send(cdp, 'follow up on the first topic');
    console.log(await cdp.evaluate(snapshot, true));

    const errors = cdp.pageErrors().slice(0, 5);
    console.log(`\npage errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  } finally {
    cdp?.close();
    await browser.close();
    await mock.close();
  }
}

main().catch((error) => {
  console.error(`repro crashed: ${error.message}`);
  process.exit(1);
});
