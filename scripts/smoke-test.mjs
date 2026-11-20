#!/usr/bin/env node
/**
 * Headless smoke test — "does the extension boot and look like the spec?"
 *
 * Loads the unpacked extension into headless Edge, drives the real UI over CDP and
 * asserts: sidebar (chat list + model list + Settings in the sidebar), Settings
 * opening on Models in that sidebar, the five major providers listed first,
 * add/remove of a model, one equal-width column per model, and that adding a
 * model never opens a browser tab. Fails on any page exception or console error.
 *
 * Usage: node scripts/smoke-test.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks, launchExtensionBrowser, sleep, waitFor } from './lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

const tabCount = `(async () => (await chrome.tabs.query({})).length)()`;
const columnWidths = `JSON.stringify(Array.from(document.querySelectorAll('.column')).map(c => Math.round(c.getBoundingClientRect().width)))`;

async function main() {
  const checks = createChecks('checks');
  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9600 + Math.floor(Math.random() * 300),
  });
  console.log(`${browser.browser} · headless\n`);
  checks.record('service worker registered', Boolean(browser.workerUrl), browser.workerUrl || 'not found');

  let cdp;
  try {
    cdp = await browser.openApp();
    checks.record('app page booted', true);

    const boot = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        title: document.title,
        sidebar: !!document.querySelector('aside.sidebar'),
        history: !!document.getElementById('history-list'),
        settingsBtn: !!document.getElementById('settings-btn'),
        settingsInSidebar: !!document.querySelector('aside.sidebar #settings-body'),
        settingsHidden: document.getElementById('view-settings').hidden,
        composer: !!document.getElementById('prompt'),
        send: !!document.getElementById('send-btn'),
        theme: document.documentElement.dataset.theme,
        version: chrome.runtime.getManifest().version
      })`),
    );
    checks.record(
      'sidebar + history + composer present',
      boot.sidebar && boot.history && boot.composer && boot.send,
      `theme=${boot.theme} v${boot.version}`,
    );
    checks.record(
      'settings panel lives inside the sidebar',
      boot.settingsInSidebar,
      boot.settingsHidden ? 'collapsed' : 'shown open on first run (no models yet)',
    );

    const pong = await cdp.evaluate(
      `new Promise((resolve) => {
         const port = chrome.runtime.connect({ name: 'multichat-app' });
         const timer = setTimeout(() => resolve('timeout'), 4000);
         port.onMessage.addListener((message) => {
           if (message.type === 'pong') { clearTimeout(timer); resolve('pong:' + message.version); }
         });
         port.postMessage({ type: 'ping' });
       })`,
      true,
    );
    checks.record('background answers on the port', String(pong).startsWith('pong:'), String(pong));

    // Settings opens in the sidebar (no modal) and widens the sidebar column.
    const tabsBefore = await cdp.evaluate(tabCount, true);
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    const settings = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        open: !document.getElementById('view-settings').hidden,
        chatHidden: document.getElementById('view-chat').hidden,
        wide: document.getElementById('app-root').classList.contains('is-settings'),
        section: document.querySelector('#settings-nav button[aria-current="true"]')?.textContent,
        providers: document.querySelectorAll('#add-provider option').length,
        sidebarWidth: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)
      })`),
    );
    checks.record(
      'Settings opens in the sidebar on Models',
      settings.open && settings.chatHidden && settings.section === 'Models' && settings.wide,
      `${settings.providers} providers, sidebar ${settings.sidebarWidth}px`,
    );

    const majors = JSON.parse(
      await cdp.evaluate(
        `JSON.stringify(Array.from(document.querySelectorAll('#add-provider option')).slice(0, 5).map(o => o.textContent.split(' — ')[0]))`,
      ),
    );
    checks.record(
      'dropdown lists the five majors first',
      ['ChatGPT', 'Gemini', 'Claude', 'DeepSeek', 'Grok'].every((name, index) => majors[index] === name),
      majors.join(', '),
    );

    const defaultMode = await cdp.evaluate(`document.querySelector('#add-mode')?.value`);
    checks.record(
      'add-model defaults to the in-column embedded web chat',
      defaultMode === 'embed',
      `connection=${defaultMode}`,
    );

    // Pin the API mode for the rest of this offline test (the embedded mode is
    // covered by scripts/embed-test.mjs, which needs the real provider site).
    await cdp.evaluate(`(() => {
      const select = document.querySelector('#add-mode');
      select.value = 'api';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()`);
    await sleep(200);

    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(700);
    const added = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        cards: document.querySelectorAll('.model-card').length,
        name: document.querySelector('.model-card .model-name')?.textContent,
        mode: document.querySelector('.model-card .mode-badge')?.textContent,
        hasRemove: !!document.querySelector('.model-card [data-act="remove"]'),
        hasProbe: !!document.querySelector('.model-card [data-act="test"], .model-card [data-act="check"]'),
        sidebarRows: document.querySelectorAll('.sidebar-model').length
      })`),
    );
    checks.record(
      'model added with × remove button',
      added.cards === 1 && added.hasRemove && added.hasProbe && added.name === 'ChatGPT',
      `${added.name} · ${added.mode}`,
    );

    // The whole point of the new flow: adding a model must not open a tab.
    const tabsAfter = await cdp.evaluate(tabCount, true);
    checks.record(
      'adding a model opens no browser tab',
      tabsAfter === tabsBefore,
      `tabs ${tabsBefore} → ${tabsAfter}`,
    );
    checks.record(
      'model also listed in the sidebar',
      added.sidebarRows === 1,
      `${added.sidebarRows} sidebar row(s)`,
    );

    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(350);
    const board = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        chatVisible: !document.getElementById('view-chat').hidden,
        narrow: !document.getElementById('app-root').classList.contains('is-settings'),
        columns: document.querySelectorAll('.column').length,
        header: document.querySelector('.column .column-name')?.textContent,
        status: document.querySelector('.column .column-status')?.textContent?.trim(),
        emptyHidden: document.getElementById('empty-state').hidden,
        aboveComposer: (() => {
          const column = document.querySelector('.column');
          const composer = document.querySelector('.composer');
          return column && composer ? column.getBoundingClientRect().top < composer.getBoundingClientRect().top : false;
        })(),
        widths: ${columnWidths}
      })`),
    );
    checks.record(
      'first model lands as a column above the input box',
      board.chatVisible && board.narrow && board.columns === 1 && board.header === 'ChatGPT' && board.emptyHidden && board.aboveComposer,
      `status=${board.status}, widths=${board.widths}`,
    );

    await cdp.send('Page.reload');
    await sleep(1500);
    const afterReload = await waitFor(async () => cdp.evaluate(`document.querySelectorAll('.column').length`), 9000);
    checks.record('state persists across reload', afterReload === 1, `columns=${afterReload}`);

    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('.model-card [data-act="remove"]')?.click()`);
    await sleep(600);
    const removed = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        cards: document.querySelectorAll('.model-card').length,
        sidebarRows: document.querySelectorAll('.sidebar-model').length,
        columns: document.querySelectorAll('.column').length,
        emptyVisible: !document.getElementById('empty-state').hidden,
        headline: document.querySelector('#empty-state h2')?.textContent,
        promptDisabled: document.getElementById('prompt').disabled,
        sendDisabled: document.getElementById('send-btn').disabled
      })`),
    );
    checks.record(
      'model can be removed with ×',
      removed.cards === 0 && removed.sidebarRows === 0,
      `cards=${removed.cards}, sidebar=${removed.sidebarRows}`,
    );
    checks.record(
      'last model removed → “Please add a model” and a locked input',
      removed.columns === 0 &&
        removed.emptyVisible &&
        /please add a model/i.test(removed.headline || '') &&
        removed.promptDisabled &&
        removed.sendDisabled,
      `columns=${removed.columns}, headline="${removed.headline}"`,
    );

    const errors = cdp.pageErrors();
    checks.record('no console errors / exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    cdp?.close();
    await browser.close();
  }

  process.exit(checks.summary() ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n✗ smoke test crashed: ${error.message}`);
  process.exit(1);
});
