#!/usr/bin/env node
/**
 * Diagnose embedded provider panels.
 *
 * Adds an embedded model per provider through the real settings UI, then asks the
 * extension itself to inject a DOM probe into **every frame** of the app tab
 * (chrome.scripting, allFrames). Cross-origin frames are out-of-process, so this
 * is the only reliable way to see what the framed page actually looks like.
 *
 * Prints, per provider: column status, frame URL, composer/button candidates,
 * login affordances, and a sample of the page's visible text (which is where
 * providers like Grok surface "your network is blocking us").
 *
 * Usage: node scripts/diagnose-provider.mjs deepseek grok [chatgpt …]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtensionBrowser, sleep } from './lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const providers = process.argv.slice(2);
if (!providers.length) {
  console.error('usage: node scripts/diagnose-provider.mjs <providerId> [...]');
  process.exit(1);
}

const setInput = (selector, value, eventName = 'change') => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return 'missing';
  field.value = ${JSON.stringify(value)};
  field.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
  return field.value;
})()`;

const DOM_PROBE = `(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    aria: el.getAttribute('aria-label') || '',
    placeholder: el.getAttribute('placeholder') || '',
    cls: String(el.className || '').slice(0, 46),
    visible: visible(el)
  });
  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    textareas: Array.from(document.querySelectorAll('textarea')).slice(0, 5).map(describe),
    editables: Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 5).map(describe),
    buttons: Array.from(document.querySelectorAll('button'))
      .filter((el) => /send|submit|stop|发送|停止/i.test(el.getAttribute('aria-label') || el.textContent || ''))
      .slice(0, 6)
      .map((el) => ({ ...describe(el), text: (el.textContent || '').trim().slice(0, 16), disabled: el.disabled })),
    loginish: Array.from(document.querySelectorAll('header a, header button, nav a, nav button'))
      .filter((el) => /log ?in|sign ?in|登录/i.test((el.textContent || '').trim()))
      .slice(0, 4)
      .map((el) => (el.textContent || '').trim().slice(0, 16)),
    bodyChars: ((document.body && document.body.innerText) || '').length,
    bodySample: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 320)
  });
})()`;

/** Attach directly to the provider frame target (cross-origin frames are OOPIFs). */
async function inspectProviderFrame(base, frameUrl, { reload = false, parentCdp = null, columnKey = '' } = {}) {
  const deadline = Date.now() + 15000;
  let target = null;
  while (Date.now() < deadline && !target) {
    const list = await (await fetch(`${base}/json/list`)).json();
    target = list.find(
      (entry) =>
        (entry.type === 'iframe' || entry.type === 'page') &&
        entry.url.startsWith(frameUrl) &&
        entry.webSocketDebuggerUrl,
    );
    if (!target) await new Promise((done) => setTimeout(done, 500));
  }
  if (!target) return { error: `no CDP target for ${frameUrl}` };

  const { Cdp } = await import('./lib/harness.mjs');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // Let the page settle briefly; a cross-origin frame target cannot be
    // reloaded through Page.* (“top-level targets only”).
    await new Promise((done) => setTimeout(done, 2500));
    const raw = await Promise.race([
      cdp.evaluate(DOM_PROBE),
      new Promise((done) => setTimeout(() => done('{"error":"evaluate timed out"}'), 12000)),
    ]);
    const consoleErrors = cdp.events
      .filter((event) => event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')
      .map((event) => `${event.params.entry.source}: ${String(event.params.entry.text).slice(0, 220)}`)
      .slice(-10);
    const exceptions = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => String(event.params?.exceptionDetails?.exception?.description || '').slice(0, 220))
      .slice(-5);
    return { probe: JSON.parse(raw), consoleErrors, exceptions };
  } finally {
    cdp.close();
  }
}
const readColumns = `JSON.stringify(
  Array.from(document.querySelectorAll('.column')).map((col) => {
    const status = col.querySelector('.column-status');
    const iframe = col.querySelector('iframe');
    return {
      key: col.getAttribute('data-key'),
      name: (col.querySelector('.column-name') || {}).textContent || '',
      src: iframe ? iframe.src : '',
      status: status ? status.textContent.trim() : '',
      state: status ? status.dataset.state : '',
      notice: (col.querySelector('.column-embed-notice') || {}).textContent || ''
    };
  })
)`;

async function main() {
  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9930 + Math.floor(Math.random() * 60),
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
    for (const provider of providers) {
      await cdp.evaluate(setInput('#add-provider', provider));
      await sleep(250);
      await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
      await sleep(400);
    }
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(12000); // let every provider page load

    const columns = JSON.parse(await cdp.evaluate(readColumns));

    for (const provider of providers) {
      console.log(`\n=== ${provider} ===`);
      const column = columns.find((entry) => entry.name.toLowerCase().includes(provider.slice(0, 4)));
      console.log(`column: ${JSON.stringify(column)}`);
      if (!column || !column.src) continue;

      const detail = await inspectProviderFrame(browser.base, column.src, { reload: false });
      if (detail.error) {
        console.log(`inspect failed: ${detail.error}`);
        continue;
      }
      const info = detail.probe;
      console.log(`title="${info.title}" readyState=${info.readyState} bodyChars=${info.bodyChars}`);
      console.log(`textareas: ${JSON.stringify(info.textareas)}`);
      console.log(`editables: ${JSON.stringify(info.editables)}`);
      console.log(`buttons:   ${JSON.stringify(info.buttons)}`);
      console.log(`loginish:  ${JSON.stringify(info.loginish)}`);
      console.log(`text:      ${info.bodySample}`);
      if (detail.consoleErrors.length) console.log(`console:   ${detail.consoleErrors.join(' || ')}`);
      if (detail.exceptions.length) console.log(`exceptions:${detail.exceptions.join(' || ')}`);
    }
    const errors = cdp
      .pageErrors()
      .filter((line) => !/favicon|net::ERR_/i.test(line))
      .slice(0, 12);
    console.log('\n=== page errors (top frame only; iframe console lives in its own target) ===');
    console.log(errors.length ? errors.join('\n') : '(none)');
  } finally {
    cdp?.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`diagnose crashed: ${error.message}`);
  process.exit(1);
});
