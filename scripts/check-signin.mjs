#!/usr/bin/env node
/**
 * What does a provider's page show as a sign-in affordance?
 *
 * The bridge decides “signed in” from what it can see (see `looksSignedOut` in
 * bridge.js). When a column claims “Signed in” while the site clearly is not, this
 * prints the visible controls that look like a login, so a selector can be fixed.
 *
 * Gemini is the case that made this necessary: its signed-out “Sign in” is a plain
 * Material <button class="mdc-button"> outside <header>/<nav>, invisible to the
 * generic scan → the column said “Signed in” and its “Sign in” button returned 403
 * (Google refuses framed OAuth).
 *
 * Usage: node scripts/check-signin.mjs [https://gemini.google.com/app]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, launchExtensionBrowser, sleep } from './lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const URL_TO_OPEN = process.argv[2] || 'https://gemini.google.com/app';

const DUMP = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const rows = [];
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="link"]')) {
    if (!visible(el)) continue;
    const href = el.getAttribute('href') || '';
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24);
    const aria = el.getAttribute('aria-label') || '';
    if (/sign ?in|log ?in|accounts\\.google/i.test(href + ' ' + text + ' ' + aria)) {
      rows.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        href: href.slice(0, 90),
        text,
        aria,
        inHeaderOrNav: Boolean(el.closest('header, nav')),
      });
    }
    if (rows.length >= 10) break;
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    bodyText: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 160),
    rows,
  });
})()`;

async function main() {
  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9750 + Math.floor(Math.random() * 60),
  });
  try {
    const target = await fetch(`${browser.base}/json/new?${encodeURIComponent(URL_TO_OPEN)}`, {
      method: 'PUT',
    }).then((response) => response.json());
    const page = await Cdp.connect(target.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await sleep(7000);

    const dump = JSON.parse(await page.evaluate(DUMP));
    console.log(`${dump.url}\n${dump.title}\n`);
    if (!dump.rows.length) {
      console.log('no sign-in affordance found — this page would report “Signed in”');
    }
    for (const row of dump.rows) {
      console.log(
        `  <${row.tag}> "${row.text}"${row.aria ? ` aria="${row.aria}"` : ''}` +
          `${row.href ? ` href="${row.href}"` : ''} class="${row.cls}"` +
          `${row.inHeaderOrNav ? ' (inside header/nav)' : ' (outside header/nav)'}`,
      );
    }
    page.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`check-signin crashed: ${error.message}`);
  process.exit(1);
});
