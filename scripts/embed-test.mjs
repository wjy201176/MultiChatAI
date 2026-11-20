#!/usr/bin/env node
/**
 * Embed test (needs internet — unlike the offline e2e suite).
 *
 * Proves the core promise: a provider's own **free web chat** is rendered inside
 * a column of the extension window, with no API key and no new tab.
 *
 * Checks
 *   1. the column contains an <iframe> pointing at the provider
 *   2. the framing headers are stripped by scoped declarativeNetRequest rules
 *      (installed for this extension's origin only)
 *   3. the content-script bridge inside that frame registers with the worker,
 *      so the column header moves past “Loading the chat…”
 *   4. no browser tab was opened by any of it
 *
 * Usage: node scripts/embed-test.mjs [https://chatgpt.com/]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks, launchExtensionBrowser, sleep, waitFor } from './lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const PROVIDER = 'chatgpt';

/** A URL shaped like the provider's own per-conversation link. */
const THREAD_URL = 'https://chatgpt.com/c/68f0c1d2-aaaa-bbbb-cccc-1234567890ab';

/**
 * What the bridge captures at settle time: the answer's rendered markup, including
 * a table and a chart image. The <script> is deliberately hostile — it must never
 * reach the extension page.
 */
const RICH_HTML =
  '<div class="md">' +
  '<table><thead><tr><th>key</th><th>value</th></tr></thead>' +
  '<tbody><tr><td>alpha</td><td>1</td></tr></tbody></table>' +
  '<img alt="chart" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">' +
  '<p onclick="void 0">rich paragraph</p>' +
  '<script>window.parent.__pwned = 1</' + 'script>' +
  '</div>';

const setInput = (selector, value, eventName = 'change') => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return 'missing';
  field.value = ${JSON.stringify(value)};
  field.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }));
  return field.value;
})()`;

async function main() {
  const checks = createChecks('embed checks');
  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9950 + Math.floor(Math.random() * 40),
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

    const tabsBefore = await cdp.evaluate(`(async () => (await chrome.tabs.query({})).length)()`, true);

    // Add ChatGPT with the default (embedded) mode.
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(setInput('#add-provider', PROVIDER));
    await sleep(250);
    const mode = await cdp.evaluate(`document.querySelector('#add-mode')?.value`);
    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(800);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(600);

    checks.record('new model defaults to the embedded web chat', mode === 'embed', `mode=${mode}`);

    const frame = await waitFor(async () => {
      const info = JSON.parse(
        await cdp.evaluate(`(() => {
          const iframe = document.querySelector('.column.is-embed iframe');
          return JSON.stringify({
            embedded: !!document.querySelector('.column.is-embed'),
            src: iframe ? iframe.src : '',
            columns: document.querySelectorAll('.column').length
          });
        })()`),
      );
      return info.src.startsWith('https://chatgpt.com') ? info : null;
    }, 15000, 300);

    checks.record(
      'column renders the provider page in an iframe',
      Boolean(frame) && frame.columns === 1,
      frame ? frame.src : 'no iframe',
    );

    // Scoped DNR rules: present, scoped to this extension, sub_frame only.
    const rules = JSON.parse(
      await cdp.evaluate(`(async () => {
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        return JSON.stringify({
          selfId: chrome.runtime.id,
          count: rules.length,
          scoped: rules.every((rule) => (rule.condition?.initiatorDomains || []).includes(chrome.runtime.id)),
          subFrameOnly: rules.every((rule) => (rule.condition?.resourceTypes || []).includes('sub_frame')),
          strips: rules.every((rule) =>
            (rule.action?.responseHeaders || []).some((header) => header.header === 'x-frame-options')
          )
        });
      })()`, true),
    );
    checks.record(
      'framing headers stripped by scoped rules',
      rules.count > 0 && rules.scoped && rules.subFrameOnly && rules.strips,
      `${rules.count} rule(s), scoped=${rules.scoped}, sub_frame=${rules.subFrameOnly}`,
    );

    // The bridge inside the frame must announce itself: then the pill leaves
    // "Loading the chat…" and says either Signed in or Sign in inside this panel.
    const pill = await waitFor(async () => {
      const info = JSON.parse(
        await cdp.evaluate(`(() => {
          const el = document.querySelector('.column.is-embed .column-status');
          return JSON.stringify({ text: el ? el.textContent.trim() : '', state: el ? el.dataset.state : '' });
        })()`),
      );
      return info.text && !/loading/i.test(info.text) ? info : null;
    }, 60000, 500);

    checks.record(
      'the bridge inside the framed page registered',
      Boolean(pill),
      pill ? `status="${pill.text}" (${pill.state})` : 'frame never reported in',
    );

    /*
     * The panel must also *push* its readiness to the app page (postMessage), not
     * only answer the worker's probes: that push is what settles a column when the
     * worker was restarted mid-run. `__multichaiPanelStates()` is the app's debug
     * view of what each panel last reported.
     */
    const pushed = await waitFor(async () => {
      const states = JSON.parse(
        await cdp.evaluate(`JSON.stringify(window.__multichaiPanelStates?.() || {})`),
      );
      const entry = Object.values(states)[0];
      return entry && typeof entry.ready === 'boolean' ? entry : null;
    }, 30000, 500);
    checks.record(
      'the panel pushes its own readiness to the app',
      Boolean(pushed) && pushed.hasComposer === true && pushed.ready === true,
      pushed ? `ready=${pushed.ready}, busy=${pushed.busy}, composer=${pushed.hasComposer}` : 'no push',
    );

    /*
     * The capture side of the history feature: when a panel reports its own
     * conversation URL, the app must keep it as that model's chat link (that is
     * what later reopens the real thread instead of a text copy). A synthetic
     * report with `source` set to the panel's window exercises the same code path.
     */
    const captured = JSON.parse(
      await cdp.evaluate(`(() => {
         const frame = document.querySelector('.column.is-embed iframe');
         if (!frame) return JSON.stringify({ error: 'no iframe' });
         window.dispatchEvent(new MessageEvent('message', {
           data: {
             type: 'MULTICHAI_STATE', hasComposer: true, busy: false, ready: true,
             signedIn: true, url: ${JSON.stringify(THREAD_URL)}
           },
           source: frame.contentWindow
         }));
         const states = window.__multichaiPanelStates?.() || {};
         const entry = Object.values(states)[0] || {};
         return JSON.stringify({ url: entry.url || '', threadUrl: entry.threadUrl || '' });
       })()`),
    );
    checks.record(
      'the app recognises the panel’s own conversation link',
      captured.threadUrl === THREAD_URL,
      `threadUrl="${captured.threadUrl}"`,
    );

    /*
     * “New chat” must start a fresh conversation inside each panel *without* a
     * reload, which means pressing the site's own control. Whether the bridge can
     * find that control on the real page is the thing that decides if the feature
     * works, so it is asserted here rather than assumed.
     */
    const newChatCapable = await waitFor(async () => {
      const states = JSON.parse(
        await cdp.evaluate(`JSON.stringify(window.__multichaiPanelStates?.() || {})`),
      );
      const entry = Object.values(states)[0];
      return entry && entry.canStartNewChat === true ? entry : null;
    }, 20000, 500);
    checks.record(
      'the bridge finds the site’s own New chat control (used in tab mode)',
      Boolean(newChatCapable),
      newChatCapable ? 'found a New chat control' : 'no New chat control found on this provider page',
    );

    const tabsAfter = await cdp.evaluate(`(async () => (await chrome.tabs.query({})).length)()`, true);
    checks.record('nothing opened a tab', tabsAfter === tabsBefore, `tabs ${tabsBefore} → ${tabsAfter}`);

    /*
     * Opening an old topic must show what was said, not a blank provider page.
     * Seed a conversation whose only model is this embedded one, reload, and the
     * column should show the saved transcript with the provider page untouched.
     */
    const seeded = JSON.parse(
      await cdp.evaluate(`(async () => {
        const stored = await chrome.storage.local.get('settings');
        const model = (stored.settings.models || []).find((entry) => entry.mode === 'embed');
        if (!model) return JSON.stringify({ error: 'no embed model' });
        const now = Date.now();
        const conv = {
          id: 'c_seed',
          title: 'An older topic',
          createdAt: now - 60000,
          updatedAt: now - 60000,
          turns: [{
            id: 't_seed',
            prompt: 'an old question about queues',
            attachments: [],
            createdAt: now - 60000,
            answers: {
              [model.id]: {
                providerId: model.providerId, label: model.label, mode: 'embed',
                text: '**seeded answer** about queues',
                status: 'done', startedAt: now - 60000, endedAt: now - 59000, ms: 1000
              }
            }
          }]
        };
        // The same conversation, but this time the model reported its own chat
        // link: opening it must load the provider's real thread, not a text copy.
        const linked = {
          id: 'c_link',
          title: 'A linked topic',
          createdAt: now - 120000,
          updatedAt: now - 119000,
          turns: [{
            id: 't_link',
            prompt: 'a question that produced a chart',
            attachments: [],
            createdAt: now - 120000,
            answers: {
              [model.id]: {
                providerId: model.providerId, label: model.label, mode: 'embed',
                text: 'the chart was here',
                threadUrl: ${JSON.stringify(THREAD_URL)},
                status: 'done', startedAt: now - 120000, endedAt: now - 119000, ms: 1000
              }
            }
          }]
        };
        // A conversation recorded with the model's rendered HTML: history must
        // replay that, not a flattened text copy.
        const rich = {
          id: 'c_rich',
          title: 'A rich topic',
          createdAt: now - 180000,
          updatedAt: now - 179000,
          turns: [{
            id: 't_rich',
            prompt: 'a question with a table and a chart',
            attachments: [],
            createdAt: now - 180000,
            answers: {
              [model.id]: {
                providerId: model.providerId, label: model.label, mode: 'embed',
                text: 'the table was here',
                html: ${JSON.stringify(RICH_HTML)},
                status: 'done', startedAt: now - 180000, endedAt: now - 179000, ms: 1000
              }
            }
          }]
        };
        await chrome.storage.local.set({
          ['conv:c_seed']: conv,
          ['conv:c_link']: linked,
          ['conv:c_rich']: rich,
          conversationIndex: [
            { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt, turnCount: 1 },
            { id: linked.id, title: linked.title, createdAt: linked.createdAt, updatedAt: linked.updatedAt, turnCount: 1 },
            { id: rich.id, title: rich.title, createdAt: rich.createdAt, updatedAt: rich.updatedAt, turnCount: 1 }
          ],
          activeConversationId: conv.id
        });
        return JSON.stringify({ modelId: model.id, threadUrl: ${JSON.stringify(THREAD_URL)} });
      })()`, true),
    );

    if (seeded.error) {
      checks.record('opening an old topic shows its saved transcript', false, seeded.error);
      checks.record('the provider page is not reloaded for history', false, 'skipped');
    } else {
      /*
       * Switch to the seeded conversation *without* reloading the app: that is the
       * path a history click actually takes, and it is where a re-created column
       * would navigate the provider page. Stamping the iframe first makes a reload
       * visible: a recreated <iframe> loses the marker (and its page).
       */
      await cdp.evaluate(`(() => {
         const frame = document.querySelector('.column.is-embed iframe');
         if (frame) frame.dataset.probe = 'live-before-history';
         return true;
       })()`);
      const beforeHistorySrc = await cdp.evaluate(
        `document.querySelector('.column.is-embed iframe')?.getAttribute('src') || ''`,
      );
      await waitFor(
        async () =>
          cdp.evaluate(
            `document.querySelector('.history-item[data-id="c_seed"] .history-open') ? 'ready' : ''`,
          ),
        15000,
        300,
      );
      await cdp.evaluate(
        `document.querySelector('.history-item[data-id="c_seed"] .history-open')?.click()`,
      );
      await sleep(900);
      const restored = JSON.parse(
        await cdp.evaluate(`(() => {
          const column = document.querySelector('.column.is-embed');
          const snapshot = column ? column.querySelector('.column-snapshot') : null;
          const iframe = column ? column.querySelector('.column-embed') : null;
          return JSON.stringify({
            title: document.getElementById('conversation-title')?.textContent,
            snapshotVisible: Boolean(snapshot && !snapshot.hidden),
            snapshotText: snapshot ? snapshot.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : '',
            sameFrame: Boolean(iframe && iframe.dataset.probe === 'live-before-history'),
            iframeSrc: iframe ? iframe.getAttribute('src') || '' : 'no iframe',
            hasOpenThread: Boolean(column && column.querySelector('[data-act="open-thread"]')),
            barButtons: column
              ? Array.from(column.querySelectorAll('.snapshot-bar [data-act]')).map((b) => b.dataset.act).join(',')
              : ''
          });
        })()`),
      );
      checks.record(
        'opening an old topic shows its saved answer',
        restored.snapshotVisible &&
          /seeded answer/.test(restored.snapshotText) &&
          /an old question/.test(restored.snapshotText),
        `title="${restored.title}", text="${restored.snapshotText}"`,
      );
      checks.record(
        'opening history does not reload the provider page',
        restored.sameFrame && restored.iframeSrc === beforeHistorySrc && beforeHistorySrc !== '',
        `sameFrame=${restored.sameFrame}, src="${restored.iframeSrc}"`,
      );
      checks.record(
        'a turn without a recorded link offers no "Open in …" button',
        restored.hasOpenThread === false,
        `buttons=${restored.barButtons}`,
      );

      await cdp.evaluate(`document.querySelector('.column.is-embed [data-act="open-live"]').click()`);
      await sleep(2000);
      const live = JSON.parse(
        await cdp.evaluate(`(() => {
          const column = document.querySelector('.column.is-embed');
          const snapshot = column ? column.querySelector('.column-snapshot') : null;
          const iframe = column ? column.querySelector('.column-embed') : null;
          return JSON.stringify({
            src: iframe ? iframe.getAttribute('src') || '' : 'no iframe',
            snapshotHidden: snapshot ? snapshot.hidden : null,
            status: column && column.querySelector('.column-status') ? column.querySelector('.column-status').textContent : ''
          });
        })()`),
      );
      checks.record(
        '“Show live panel” brings the provider page back without reloading it',
        String(live.src).startsWith('https://chatgpt.com') && live.src === beforeHistorySrc,
        JSON.stringify(live),
      );

      /*
       * A conversation whose model reported its own chat link. The panel here is
       * signed out, and a sign-in cannot complete in a frame — so the saved copy is
       * shown instead of bouncing to a login wall (that bounce is what “history does
       * nothing” looked like). A synthetic signed-in report exercises the other
       * branch: with a session, the model's own page is loaded.
       */
      const pushState = (signedIn) => `(() => {
         const frame = document.querySelector('.column.is-embed iframe');
         if (!frame) return 'no iframe';
         window.dispatchEvent(new MessageEvent('message', {
           data: {
             type: 'MULTICHAI_STATE', hasComposer: true, busy: false, ready: true,
             signedIn: ${'${signedIn}'}, url: ${JSON.stringify(THREAD_URL)}
           },
           source: frame.contentWindow
         }));
         return 'ok';
       })()`;

      await waitFor(
        async () =>
          cdp.evaluate(
            `document.querySelector('.history-item[data-id="c_link"] .history-open') ? 'ready' : ''`,
          ),
        15000,
        300,
      );
      await cdp.evaluate(pushState(true).replace('${signedIn}', 'true'));
      await cdp.evaluate(
        `document.querySelector('.history-item[data-id="c_link"] .history-open')?.click()`,
      );
      await sleep(1200);
      const linkedView = JSON.parse(
        await cdp.evaluate(`(() => {
           const column = document.querySelector('.column.is-embed');
           const snapshot = column ? column.querySelector('.column-snapshot') : null;
           const frame = column ? column.querySelector('.column-embed') : null;
           return JSON.stringify({
             title: document.getElementById('conversation-title')?.textContent,
             src: frame ? frame.getAttribute('src') || '' : 'no iframe',
             snapshotHidden: snapshot ? snapshot.hidden : null
           });
         })()`),
      );
      checks.record(
        'signed in, opening a conversation with a link loads the model’s own page',
        linkedView.title === 'A linked topic' &&
          linkedView.src === seeded.threadUrl &&
          linkedView.snapshotHidden === true,
        `src="${linkedView.src}"`,
      );

      // Signed out: the same click shows the saved copy and navigates nothing.
      await cdp.evaluate(pushState(true).replace('${signedIn}', 'false'));
      await cdp.evaluate(
        `document.querySelector('.history-item[data-id="c_seed"] .history-open')?.click()`,
      );
      await sleep(1200);
      await cdp.evaluate(
        `document.querySelector('.history-item[data-id="c_link"] .history-open')?.click()`,
      );
      await sleep(1200);
      const signedOutView = JSON.parse(
        await cdp.evaluate(`(() => {
           const column = document.querySelector('.column.is-embed');
           const snapshot = column ? column.querySelector('.column-snapshot') : null;
           const frame = column ? column.querySelector('.column-embed') : null;
           return JSON.stringify({
             src: frame ? frame.getAttribute('src') || '' : 'no iframe',
             snapshotVisible: Boolean(snapshot && !snapshot.hidden)
           });
         })()`),
      );
      checks.record(
        'signed out, that same conversation shows the saved copy instead of a login wall',
        signedOutView.snapshotVisible === true && signedOutView.src === seeded.threadUrl,
        `visible=${signedOutView.snapshotVisible}, src="${signedOutView.src}"`,
      );
      /*
       * The point of the whole capture: a conversation stored with the answer's
       * rendered HTML must show that rendering (table, chart image) instead of a
       * text copy — and the stored markup must stay inside a sandbox.
       */
      await waitFor(
        async () =>
          cdp.evaluate(
            `document.querySelector('.history-item[data-id="c_rich"] .history-open') ? 'ready' : ''`,
          ),
        15000,
        300,
      );
      await cdp.evaluate(
        `document.querySelector('.history-item[data-id="c_rich"] .history-open')?.click()`,
      );
      const richView = await waitFor(async () => {
        const state = JSON.parse(
          await cdp.evaluate(`(() => {
             const column = document.querySelector('.column.is-embed');
             const frame = column ? column.querySelector('iframe.snapshot-rich') : null;
             return JSON.stringify({
               title: document.getElementById('conversation-title')?.textContent,
               hasFrame: Boolean(frame),
               sandbox: frame ? frame.getAttribute('sandbox') || '' : '',
               height: frame ? frame.style.height || '' : '',
               srcdoc: frame ? frame.srcdoc || '' : '',
               textBlock: Boolean(column && column.querySelector('.snapshot-a')),
               pwned: Boolean(window.__pwned)
             });
           })()`),
        );
        return state.hasFrame && /\d+px/.test(state.height) ? state : null;
      }, 15000, 300);
      checks.record(
        'a conversation with captured HTML replays the rendered answer',
        Boolean(richView) && richView.srcdoc.includes('<table') && richView.textBlock === false,
        richView
          ? `title="${richView.title}", table=${richView.srcdoc.includes('<table')}`
          : 'no rich frame',
      );
      checks.record(
        'the saved answer is sandboxed and cannot script the extension page',
        Boolean(richView) &&
          !/allow-scripts/.test(richView.sandbox) &&
          /allow-same-origin/.test(richView.sandbox) &&
          richView.pwned === false,
        richView ? `sandbox="${richView.sandbox}", pwned=${richView.pwned}` : 'no frame',
      );
      checks.record(
        'the saved answer frame reports its own height',
        Boolean(richView) && /\d+px/.test(richView.height),
        richView ? `height="${richView.height}"` : 'no height',
      );

      /*
       * “New chat” must only empty this window. Rebuilding the board would
       * recreate the <iframe>, i.e. reload the provider page — which is exactly
       * the cookie banner the user saw on every new topic.
       */
      const beforeNewChat = JSON.parse(
        await cdp.evaluate(`(() => {
           const frame = document.querySelector('.column.is-embed iframe');
           if (frame) frame.dataset.probe = 'keep-me';
           return JSON.stringify({
             src: frame ? frame.getAttribute('src') || '' : '',
             historyRows: document.querySelectorAll('.history-item').length
           });
         })()`),
      );
      await cdp.evaluate(`document.getElementById('new-chat').click()`);
      await sleep(1200);
      const afterNewChat = JSON.parse(
        await cdp.evaluate(`(() => {
           const column = document.querySelector('.column.is-embed');
           const frame = column ? column.querySelector('iframe') : null;
           const snapshot = column ? column.querySelector('.column-snapshot') : null;
           return JSON.stringify({
             sameFrame: Boolean(frame && frame.dataset.probe === 'keep-me'),
             src: frame ? frame.getAttribute('src') || '' : 'no iframe',
             snapshotHidden: snapshot ? snapshot.hidden : null,
             title: document.getElementById('conversation-title')?.textContent,
             historyRows: document.querySelectorAll('.history-item').length
           });
         })()`),
      );
      checks.record(
        'New chat reloads the panel at the provider home URL (same element, fresh document)',
        afterNewChat.sameFrame && afterNewChat.src === 'https://chatgpt.com/',
        `sameFrame=${afterNewChat.sameFrame}, src="${afterNewChat.src}"`,
      );
      checks.record(
        'New chat empties this window only (history kept)',
        afterNewChat.title === 'New chat' &&
          afterNewChat.snapshotHidden === true &&
          afterNewChat.historyRows === beforeNewChat.historyRows,
        `title="${afterNewChat.title}", rows=${afterNewChat.historyRows}/${beforeNewChat.historyRows}`,
      );

      /*
       * “Full” widens one column to the whole board. For an embedded model that must be
       * a pure layout change: the same <iframe> element, the same document, no reload.
       */
      const beforeFocus = JSON.parse(
        await cdp.evaluate(`(() => {
           const frame = document.querySelector('.column.is-embed iframe');
           if (frame) frame.dataset.probe = 'focus-keeps-me';
           return JSON.stringify({ src: frame ? frame.getAttribute('src') || '' : 'no iframe' });
         })()`),
      );
      await cdp.evaluate(`document.querySelector('.column.is-embed [data-act="focus"]').click()`);
      await sleep(600);
      const focusedPanel = JSON.parse(
        await cdp.evaluate(`(() => {
           const board = document.querySelector('.columns');
           const column = document.querySelector('.column.is-embed');
           const frame = column ? column.querySelector('iframe') : null;
           return JSON.stringify({
             focused: board.classList.contains('is-focus'),
             dataFocus: column ? column.dataset.focus === '1' : false,
             label: column && column.querySelector('[data-act="focus"]')
               ? column.querySelector('[data-act="focus"]').textContent.trim() : '',
             sameFrame: Boolean(frame && frame.dataset.probe === 'focus-keeps-me'),
             src: frame ? frame.getAttribute('src') || '' : 'no iframe'
           });
         })()`),
      );
      checks.record(
        '“Full” widens the panel without reloading it',
        focusedPanel.focused &&
          focusedPanel.dataFocus &&
          focusedPanel.label === 'Return' &&
          focusedPanel.sameFrame &&
          focusedPanel.src === beforeFocus.src,
        `focused=${focusedPanel.focused}, label="${focusedPanel.label}", sameFrame=${focusedPanel.sameFrame}`,
      );

      await cdp.evaluate(`document.querySelector('.column.is-embed [data-act="focus"]').click()`);
      await sleep(400);
      const unfocusedPanel = JSON.parse(
        await cdp.evaluate(`(() => {
           const board = document.querySelector('.columns');
           const column = document.querySelector('.column.is-embed');
           return JSON.stringify({
             focused: board.classList.contains('is-focus'),
             label: column && column.querySelector('[data-act="focus"]')
               ? column.querySelector('[data-act="focus"]').textContent.trim() : ''
           });
         })()`),
      );
      checks.record(
        '“Return” goes back to the multi-model view',
        unfocusedPanel.focused === false && unfocusedPanel.label === 'Full',
        `focused=${unfocusedPanel.focused}, label="${unfocusedPanel.label}"`,
      );
    }

    /* No captured answer in this window → the summary must stay off, not open empty. */
    const summarizeIdle = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        label: document.getElementById('summarize-btn').textContent.trim(),
        disabled: document.getElementById('summarize-btn').disabled,
        title: document.getElementById('summarize-btn').title,
        panelHidden: document.getElementById('summary-panel').hidden
      })`),
    );
    checks.record(
      'Summarize stays off until a model has answered',
      summarizeIdle.label === 'Summarize' &&
        summarizeIdle.disabled === true &&
        summarizeIdle.panelHidden === true,
      summarizeIdle.title,
    );

    const errors = cdp.pageErrors().filter(
      (line) => !/chatgpt\.com|openai\.com/.test(line) && !/Blocked script execution in .about:srcdoc/.test(line),
    );
    checks.record('no unexpected console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    cdp?.close();
    await browser.close();
  }

  process.exit(checks.summary() ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n✗ embed test crashed: ${error.message}`);
  process.exit(1);
});
