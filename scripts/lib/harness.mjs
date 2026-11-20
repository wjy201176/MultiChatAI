/**
 * Test harness shared by scripts/smoke-test.mjs and scripts/e2e-test.mjs.
 *
 * Launches Microsoft Edge in headless mode with the unpacked extension loaded,
 * discovers the extension id from the DevTools target list and hands back a CDP
 * client bound to the extension page.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* keep polling */
    }
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Neither Microsoft Edge nor Google Chrome was found.');
}

export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)));
      socket.addEventListener('error', () => reject(new Error(`Could not connect to ${url}`)));
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'evaluation failed';
      throw new Error(message);
    }
    return result.result?.value;
  }

  /** Page errors worth failing on: exceptions, error logs, console.error. */
  pageErrors() {
    const out = [];
    for (const event of this.events) {
      if (event.method === 'Runtime.exceptionThrown') {
        out.push(
          event.params?.exceptionDetails?.exception?.description ||
            event.params?.exceptionDetails?.text ||
            'uncaught exception',
        );
      } else if (event.method === 'Log.entryAdded') {
        if (event.params?.entry?.level === 'error') out.push(event.params.entry.text);
      } else if (event.method === 'Runtime.consoleAPICalled') {
        if (event.params?.type === 'error') {
          out.push((event.params.args || []).map((arg) => arg.value ?? arg.description).join(' '));
        }
      }
    }
    return out;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Start headless Edge with the extension loaded.
 * @param {{extensionDir: string, port?: number}} options
 */
export async function launchExtensionBrowser({ extensionDir, port = 9500 }) {
  const browserPath = findBrowser();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multichatai-profile-'));
  const child = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-component-update',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  const base = `http://127.0.0.1:${port}`;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await sleep(500);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* profile still locked — the OS temp dir will clean it up */
    }
  };

  try {
    const version = await waitFor(async () => {
      const response = await fetch(`${base}/json/version`);
      return response.ok ? response.json() : null;
    }, 25000);
    if (!version) throw new Error('The browser never exposed its DevTools endpoint.');

    const registration = await waitFor(async () => {
      const list = await (await fetch(`${base}/json/list`)).json();
      const app = list.find((target) => target.type === 'page' && target.url.includes('/src/app/app.html'));
      const worker = list.find(
        (target) =>
          target.type === 'service_worker' && target.url.includes('/src/background/service-worker.js'),
      );
      return app || worker ? { app, worker } : null;
    }, 25000);
    if (!registration) throw new Error('The extension never registered in the browser.');

    const extensionId = new URL((registration.app || registration.worker).url).host;
    const appUrl = `chrome-extension://${extensionId}/src/app/app.html`;

    return {
      browser: version.Browser,
      base,
      extensionId,
      appUrl,
      workerUrl: registration.worker ? registration.worker.url : null,

      /** Attach to the app page (opening it if the install hook already did not). */
      async openApp({ timeoutMs = 15000 } = {}) {
        const list = await (await fetch(`${base}/json/list`)).json();
        let target = list.find((entry) => entry.type === 'page' && entry.url === appUrl);
        if (!target) {
          target = await fetch(`${base}/json/new?${encodeURIComponent(appUrl)}`, {
            method: 'PUT',
          }).then((response) => response.json());
        }
        const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Page.enable');
        const ready = await waitFor(
          async () =>
            (await cdp.evaluate(
              'document.readyState === "complete" && !!document.getElementById("columns")',
            )) === true,
          timeoutMs,
        );
        if (!ready) throw new Error('The extension page did not finish booting.');
        return cdp;
      },

      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Tiny assertion collector so scripts can keep running and report at the end. */
export function createChecks(label = 'checks') {
  const results = [];
  return {
    label,
    record(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail });
      console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    },
    results,
    summary() {
      const failed = results.filter((entry) => !entry.ok);
      console.log(`\n${results.length - failed.length}/${results.length} ${label} passed`);
      if (failed.length) {
        console.error('\n✗ failed:');
        for (const entry of failed) {
          console.error(`  - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`);
        }
        return false;
      }
      console.log('✓ all good');
      return true;
    },
  };
}
