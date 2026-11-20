#!/usr/bin/env node
/**
 * Probe: can an extension page frame a site that sends X-Frame-Options /
 * frame-ancestors, by stripping those headers with declarativeNetRequest — and
 * can that be scoped to our own extension origin (so websites stay protected)?
 *
 * Scenarios
 *   1. control            — no header modification (expect blocked)
 *   2. static rules       — manifest rule_resources, unscoped (expect framed)
 *   3. dynamic + initiatorDomains [chrome.runtime.id]  (expect framed, scoped)
 *
 * Targets: a local server that sends `X-Frame-Options: DENY` +
 * `frame-ancestors 'none'`, and the real provider URL from the arguments.
 *
 * Detection is by side effect: the content script inside the framed document
 * writes to chrome.storage.local, which the extension page reads back.
 *
 * Usage: node scripts/probe-embed.mjs [https://chatgpt.com/]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Cdp, sleep, waitFor } from './lib/harness.mjs';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => fs.existsSync(candidate));

const remoteTarget = process.argv[2] || 'https://chatgpt.com/';

const STRIP_HEADERS = [
  { header: 'x-frame-options', operation: 'remove' },
  { header: 'content-security-policy', operation: 'remove' },
  { header: 'content-security-policy-report-only', operation: 'remove' },
];

/** Headers to remove, as a literal used inside the generated service worker. */
const STRIP_HEADERS_LITERAL = JSON.stringify(STRIP_HEADERS);

function startLocalTarget() {
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'cache-control': 'no-store',
    });
    response.end(
      '<!doctype html><meta charset="utf-8"><title>local provider</title><h1>local provider</h1>',
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function hostPattern(target) {
  const url = new URL(target);
  return `${url.protocol}//${url.host}/*`;
}

function urlFilter(target) {
  const url = new URL(target);
  return `|${url.protocol}//${url.host}`;
}

/** @param {'control'|'static'|'dynamic'} mode */
function buildExtension({ targets, markerKey, mode }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-probe-'));
  const patterns = targets.map(hostPattern);

  const staticRules =
    mode === 'static'
      ? targets.map((target, index) => ({
          id: index + 1,
          priority: 1,
          action: { type: 'modifyHeaders', responseHeaders: STRIP_HEADERS },
          condition: { urlFilter: urlFilter(target), resourceTypes: ['sub_frame'] },
        }))
      : [];

  const swSource =
    mode === 'dynamic'
      ? `const TARGETS = ${JSON.stringify(targets.map(urlFilter))};
const HEADERS = ${STRIP_HEADERS_LITERAL};
async function install() {
  const rules = TARGETS.map((filter, index) => ({
    id: index + 1,
    priority: 1,
    action: { type: 'modifyHeaders', responseHeaders: HEADERS },
    condition: {
      urlFilter: filter,
      resourceTypes: ['sub_frame'],
      initiatorDomains: [chrome.runtime.id],
    },
  }));
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: rules,
  });
  console.log('MCA_SCOPED_RULES ' + chrome.runtime.id);
}
chrome.runtime.onInstalled.addListener(install);
chrome.runtime.onStartup.addListener(install);
install();
`
      : '/* probe */\n';

  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: `MCA Probe ${mode}`,
        version: '0.1',
        host_permissions: patterns,
        permissions: ['declarativeNetRequest', 'storage'],
        declarative_net_request: {
          rule_resources: staticRules.length
            ? [{ id: 'rules', enabled: true, path: 'rules.json' }]
            : [],
        },
        background: { service_worker: 'sw.js', type: 'module' },
        content_scripts: [
          { matches: patterns, js: ['frame.js'], all_frames: true, run_at: 'document_idle' },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(staticRules, null, 2));
  fs.writeFileSync(path.join(dir, 'sw.js'), swSource);
  fs.writeFileSync(
    path.join(dir, 'frame.js'),
    `try { chrome.storage.local.set({ ${JSON.stringify(markerKey)}: location.href }); } catch (error) {}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'page.html'),
    `<!doctype html><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100vh;border:0}</style>
<iframe id="f" src="about:blank"></iframe>`,
  );
  return dir;
}

async function runScenario({ targets, mode, label }) {
  const markerKey = `probe_${Math.random().toString(36).slice(2)}`;
  const dir = buildExtension({ targets, markerKey, mode });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mca-probe-profile-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--load-extension=${dir}`,
      `--disable-extensions-except=${dir}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  const base = `http://127.0.0.1:${port}`;
  let cdp;
  try {
    const ready = await waitFor(async () => {
      const response = await fetch(`${base}/json/version`);
      return response.ok ? response.json() : null;
    }, 25000);
    if (!ready) throw new Error('no devtools endpoint');

    const worker = await waitFor(async () => {
      const list = await (await fetch(`${base}/json/list`)).json();
      return (
        list.find((entry) => entry.type === 'service_worker' && entry.url.includes('/sw.js')) || null
      );
    }, 20000);
    if (!worker) throw new Error('probe extension did not register');

    const extensionId = new URL(worker.url).host;
    const pageUrl = `chrome-extension://${extensionId}/page.html`;
    await fetch(`${base}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' });

    const pageTarget = await waitFor(async () => {
      const list = await (await fetch(`${base}/json/list`)).json();
      return list.find((entry) => entry.type === 'page' && entry.url === pageUrl) || null;
    }, 20000);
    if (!pageTarget) throw new Error('extension page did not open');

    cdp = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(1500); // let dynamic rules install

    console.log(`${label}`);
    for (const target of targets) {
      await cdp.evaluate(
        `(() => { const f = document.getElementById('f'); f.src = ${JSON.stringify(target)}; return f.src; })()`,
      );
      await sleep(6000);
      const marker = await cdp.evaluate(
        `(async () => (await chrome.storage.local.get(${JSON.stringify(markerKey)}))[${JSON.stringify(
          markerKey,
        )}] || '')()`,
        true,
      );
      const framed = Boolean(marker) && String(marker).startsWith(target.replace(/\/$/, ''));
      console.log(`   ${target} → framed=${framed} ${framed ? '' : `(marker: ${marker || 'none'})`}`);
      cdp.events.length = 0;
    }
    console.log('');
  } finally {
    cdp?.close();
    try {
      child.kill();
    } catch {}
    await sleep(400);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const local = await startLocalTarget();
  const targets = [local.url, remoteTarget];
  console.log(`targets: ${targets.join('  ')}\n`);

  try {
    await runScenario({ targets, mode: 'control', label: '1) control (no header stripping)' });
    await runScenario({ targets, mode: 'static', label: '2) static DNR rules (unscoped)' });
    await runScenario({ targets, mode: 'dynamic', label: '3) dynamic rules scoped to our origin' });
  } finally {
    await local.close();
  }
}

main().catch((error) => {
  console.error(`probe crashed: ${error.message}`);
  process.exit(1);
});
