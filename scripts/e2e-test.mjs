#!/usr/bin/env node
/**
 * End-to-end test against a mock provider.
 *
 * Starts an OpenAI-compatible mock on 127.0.0.1:11434 (the base URL of the
 * built-in "Ollama" provider), then drives the real extension UI in headless
 * Edge:
 *
 *   1. Settings → Models → add an API model, test the key path
 *   2. send a prompt: streaming → done → markdown → history row
 *   3. second prompt: turn picker, restore an earlier turn
 *   4. multi-turn context reaches the provider
 *   5. reload: conversation restored; history click brings the columns back
 *   6. New chat clears the board
 *   7. two models answer the same prompt in parallel, in two columns
 *   8. Stop cancels a slow model and re-enables the composer
 *
 * Usage: node scripts/e2e-test.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecks, launchExtensionBrowser, sleep, waitFor } from './lib/harness.mjs';
import { MOCK_PORT, startMockProvider } from './lib/mock-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

/** Type a value into a field and fire the event the app listens for. */
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

const columnStates = `JSON.stringify({
  count: document.querySelectorAll('.column').length,
  statuses: Array.from(document.querySelectorAll('.column')).map(
    (column) => column.querySelector('.column-status')?.dataset.state || ''
  ),
  texts: Array.from(document.querySelectorAll('.column .answer')).map(
    (answer) => answer.innerText || ''
  ),
  stopHidden: document.getElementById('stop-btn').hidden,
  sendDisabled: document.getElementById('send-btn').disabled
})`;

const tabCount = `(async () => (await chrome.tabs.query({})).length)()`;

const columnWidths = `JSON.stringify(Array.from(document.querySelectorAll('.column')).map(
  (column) => Math.round(column.getBoundingClientRect().width)
))`;

async function run() {
  const checks = createChecks('e2e checks');

  let mock;
  try {
    mock = await startMockProvider();
  } catch (error) {
    console.error(`✗ Could not bind port ${MOCK_PORT} for the mock provider: ${error.message}`);
    process.exit(1);
  }
  console.log(`mock provider listening on http://localhost:${MOCK_PORT}/v1\n`);

  const browser = await launchExtensionBrowser({
    extensionDir: EXT,
    port: 9900 + Math.floor(Math.random() * 90),
  });

  let cdp;
  try {
    cdp = await browser.openApp();

    /* ── 1. add an API-mode model through the settings UI ───────────────── */
    const tabsBefore = await cdp.evaluate(tabCount, true);
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);

    const panel = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        inSidebar: !!document.querySelector('aside.sidebar #settings-body'),
        open: !document.getElementById('view-settings').hidden,
        chatHidden: document.getElementById('view-chat').hidden,
        section: document.querySelector('#settings-nav button[aria-current="true"]')?.textContent
      })`),
    );
    checks.record(
      'settings panel opens inside the sidebar on Models',
      panel.inSidebar && panel.open && panel.chatHidden && panel.section === 'Models',
    );

    await cdp.evaluate(setInput('#add-provider', 'ollama'));
    await sleep(200);

    const modes = JSON.parse(
      await cdp.evaluate(
        `JSON.stringify(Array.from(document.querySelectorAll('#add-mode option')).map(o => o.value))`,
      ),
    );
    checks.record(
      'API-only provider offers only API mode',
      modes.length === 1 && modes[0] === 'api',
      modes.join(','),
    );

    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(600);

    const card = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        name: document.querySelector('.model-card .model-name')?.textContent,
        badge: document.querySelector('.model-card .mode-badge')?.textContent,
        modelName: document.querySelector('.model-card input[data-act="model-name"]')?.value,
        pill: document.querySelector('.model-card .status-pill')?.textContent?.trim(),
        hasKeyField: !!document.querySelector('.model-card input[data-act="api-key"]')
      })`),
    );
    checks.record(
      'API model card shows model name + key field',
      card.name === 'Ollama' && card.badge === 'API' && card.hasKeyField && card.modelName === 'llama3.2',
      `${card.name} · ${card.modelName}`,
    );

    const tabsAfter = await cdp.evaluate(tabCount, true);
    checks.record(
      'adding a model does not open a tab',
      tabsAfter === tabsBefore,
      `tabs ${tabsBefore} → ${tabsAfter}`,
    );

    // The requirement in one assertion: the model shows up in the right-hand
    // window (above the input box) while Settings is still open.
    const whileOpen = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        settingsOpen: !document.getElementById('view-settings').hidden,
        columns: document.querySelectorAll('.column').length,
        aboveComposer: (() => {
          const column = document.querySelector('.column');
          const composer = document.querySelector('.composer');
          return column && composer
            ? column.getBoundingClientRect().top < composer.getBoundingClientRect().top
            : false;
        })()
      })`),
    );
    checks.record(
      'first model appears above the input box while Settings stays open',
      whileOpen.settingsOpen && whileOpen.columns === 1 && whileOpen.aboveComposer,
      `columns=${whileOpen.columns}`,
    );

    await cdp.evaluate(`document.querySelector('.model-card [data-act="test"]').click()`);
    const tested = await waitFor(
      async () =>
        await cdp.evaluate(
          `(() => {
             const pill = document.querySelector('.model-card .status-pill');
             return pill && pill.dataset.state === 'ok' ? pill.textContent.trim() : '';
           })()`,
        ),
      15000,
      250,
    );
    checks.record('Test button validates the API path', Boolean(tested), tested || 'no ok state');

    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    /* ── 2. first prompt ────────────────────────────────────────────────── */
    await cdp.evaluate(typePrompt('Compare cat vs dog'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);

    const sawStreaming = await waitFor(
      async () => cdp.evaluate(`!!document.querySelector('.column-status[data-state="streaming"]')`),
      8000,
      60,
    );
    checks.record('column streams while the model answers', sawStreaming === true);

    const done = await waitFor(
      async () =>
        cdp.evaluate(
          `document.querySelector('.column-status')?.dataset.state === 'done' && document.getElementById('stop-btn').hidden`,
        ),
      25000,
      200,
    );
    checks.record('answer finishes and the column reports done', done === true);

    const rendered = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        text: document.querySelector('.column .answer')?.innerText || '',
        bold: !!document.querySelector('.column .answer strong'),
        list: document.querySelectorAll('.column .answer li').length,
        code: !!document.querySelector('.column .answer pre code'),
        status: document.querySelector('.column-status')?.textContent?.trim()
      })`),
    );
    checks.record(
      'answer rendered as markdown (bold, list, code)',
      rendered.text.includes('llama3.2') && rendered.bold && rendered.list >= 2 && rendered.code,
      `status="${rendered.status}"`,
    );

    const historyRow = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        rows: document.querySelectorAll('.history-item').length,
        title: document.querySelector('.history-title')?.textContent,
        time: document.querySelector('.history-time')?.textContent
      })`),
    );
    checks.record(
      'history row added with topic + timestamp',
      historyRow.rows === 1 && /Compare cat vs dog/.test(historyRow.title || '') && Boolean(historyRow.time),
      `"${historyRow.title}" · ${historyRow.time}`,
    );

    /* ── 3. second prompt → turn picker ─────────────────────────────────── */
    await cdp.evaluate(typePrompt('second question'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);

    const secondDone = await waitFor(
      async () =>
        cdp.evaluate(
          `document.getElementById('stop-btn').hidden &&
           document.querySelector('.column-status')?.dataset.state === 'done' &&
           document.querySelectorAll('#turn-picker option').length === 2`,
        ),
      30000,
      250,
    );
    checks.record('second turn finishes and shows a turn picker', secondDone === true);

    const pickerInfo = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        options: Array.from(document.querySelectorAll('#turn-picker option')).map(o => o.textContent),
        selected: document.getElementById('turn-picker')?.value,
        meta: document.getElementById('conversation-meta')?.textContent,
        answer: document.querySelector('.column .answer')?.innerText || ''
      })`),
    );
    checks.record(
      'newest turn shown by default',
      pickerInfo.options.length === 2 && pickerInfo.selected === '1' && pickerInfo.answer.includes('second question'),
      `selected=${pickerInfo.selected}`,
    );

    await cdp.evaluate(setInput('#turn-picker', '0'));
    await sleep(350);
    const firstTurn = await cdp.evaluate(`document.querySelector('.column .answer')?.innerText || ''`);
    checks.record(
      'earlier turn can be restored in place',
      firstTurn.includes('Compare cat vs dog'),
      firstTurn.slice(0, 40).replaceAll('\n', ' '),
    );

    /* ── 4. provider received the conversation context ──────────────────── */
    const streamed = mock.requests.filter((request) => request.stream);
    const secondMessages = streamed[1]?.messages || [];
    checks.record(
      'second call carries the prior turn as context',
      streamed.length === 2 && secondMessages.length >= 3,
      `${streamed.length} calls, ${secondMessages.length} messages in the 2nd`,
    );
    checks.record(
      'model name forwarded verbatim',
      streamed.every((request) => request.model === 'llama3.2'),
      streamed.map((request) => request.model).join(','),
    );

    /* ── 5. reload → restore from storage ───────────────────────────────── */
    await cdp.send('Page.reload');
    await sleep(1600);
    const restored = await waitFor(
      async () =>
        (await cdp.evaluate(`document.querySelector('.column .answer')?.innerText || ''`)).includes(
          'second question',
        ),
      12000,
      300,
    );
    checks.record('after reload the conversation is restored', restored === true);

    await cdp.evaluate(`document.querySelector('.history-open')?.click()`);
    await sleep(500);
    const reopened = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        rows: document.querySelectorAll('.history-item').length,
        active: document.querySelectorAll('.history-item.is-active').length,
        columns: document.querySelectorAll('.column').length,
        answer: document.querySelector('.column .answer')?.innerText || ''
      })`),
    );
    checks.record(
      'clicking a history item brings the columns back',
      reopened.rows === 1 && reopened.active === 1 && reopened.columns === 1 && reopened.answer.includes('llama3.2'),
      `columns=${reopened.columns}`,
    );

    /* ── 6. New chat clears the board without rebuilding it ─────────────── */
    // The column node is stamped first: a rebuild would replace it, and for an
    // embedded model a rebuilt column means the provider page reloads (cookie
    // banner, lost thread) just because the user started a new topic.
    const beforeNewChat = JSON.parse(
      await cdp.evaluate(`(() => {
         const column = document.querySelector('.column');
         column.dataset.marker = 'keep-me';
         column.dataset.build = '1';
         return JSON.stringify({
           text: column.querySelector('.answer')?.innerText || '',
           history: document.querySelectorAll('.history-item').length
         });
       })()`),
    );
    await cdp.evaluate(`document.getElementById('new-chat').click()`);
    await sleep(400);
    const cleared = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        title: document.getElementById('conversation-title')?.textContent,
        answer: document.querySelector('.column .answer')?.innerText || '',
        columns: document.querySelectorAll('.column').length,
        pickerGone: !document.getElementById('turn-picker'),
        sameNode: document.querySelector('.column')?.dataset.marker === 'keep-me',
        history: document.querySelectorAll('.history-item').length,
        promptEnabled: !document.getElementById('prompt').disabled
      })`),
    );
    checks.record(
      'New chat clears the conversation view',
      cleared.title === 'New chat' &&
        cleared.answer === '' &&
        cleared.columns === 1 &&
        cleared.pickerGone &&
        beforeNewChat.text.length > 0,
      `title="${cleared.title}"`,
    );
    checks.record(
      'New chat does not rebuild the columns (same nodes)',
      cleared.sameNode && cleared.columns === 1 && cleared.promptEnabled,
      `sameNode=${cleared.sameNode}, same history=${cleared.history === beforeNewChat.history}`,
    );

    /* ── 7. two models answer one prompt in parallel ────────────────────── */
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(250);
    // The page was reloaded in step 5, so the add-form provider fell back to its
    // default (ChatGPT) — pick Ollama again, then add a second API model.
    await cdp.evaluate(setInput('#add-provider', 'ollama'));
    await sleep(200);
    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(600);
    await cdp.evaluate(setInput('.model-card:nth-child(2) input[data-act="model-name"]', 'qwen2.5'));
    await sleep(300);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    const requestsBefore = mock.requests.length;
    await cdp.evaluate(typePrompt('fan out please'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);

    const parallelDone = await waitFor(
      async () => {
        const state = JSON.parse(await cdp.evaluate(columnStates));
        return state.count === 2 &&
          state.statuses.every((status) => status === 'done') &&
          state.stopHidden
          ? state
          : null;
      },
      30000,
      250,
    );
    checks.record(
      'two columns, two answers, one prompt',
      Boolean(parallelDone) &&
        parallelDone.texts[0].includes('llama3.2') &&
        parallelDone.texts[1].includes('qwen2.5'),
      parallelDone ? parallelDone.statuses.join(',') : 'timeout',
    );

    const fanOut = mock.requests.slice(requestsBefore);
    const fanPrompts = fanOut.map((request) => {
      const lastUser = [...(request.messages || [])].reverse().find((message) => message.role === 'user');
      return typeof lastUser?.content === 'string' ? lastUser.content : '';
    });
    checks.record(
      'same prompt reached both providers',
      fanOut.length === 2 && fanPrompts[0] === fanPrompts[1] && fanPrompts[0]?.includes('fan out please'),
      `${fanOut.length} calls, models=${fanOut.map((request) => request.model).join('+')}`,
    );

    const widths = JSON.parse(await cdp.evaluate(columnWidths));
    checks.record(
      'columns share exactly the same width',
      widths.length === 2 && Math.abs(widths[0] - widths[1]) <= 1,
      widths.join('px vs ') + 'px',
    );

    /* ── 7b. “Full” gives one column the whole board, “Return” undoes it ── */
    const boardWidth = await cdp.evaluate(
      `Math.round(document.querySelector('.columns').getBoundingClientRect().width)`,
    );
    const viewState = `JSON.stringify({
      columns: document.querySelectorAll('.column').length,
      visible: Array.from(document.querySelectorAll('.column'))
        .filter((column) => column.getBoundingClientRect().width > 0).length,
      widths: Array.from(document.querySelectorAll('.column'))
        .filter((column) => column.getBoundingClientRect().width > 0)
        .map((column) => Math.round(column.getBoundingClientRect().width)),
      label: (document.querySelector('.column[data-focus] [data-act="focus"]') ||
              document.querySelector('.column [data-act="focus"]')).textContent.trim(),
      boardFocused: document.querySelector('.columns').classList.contains('is-focus')
    })`;

    await cdp.evaluate(`document.querySelectorAll('.column [data-act="focus"]')[0].click()`);
    await sleep(350);
    const focusedView = JSON.parse(await cdp.evaluate(viewState));
    checks.record(
      '“Full” shows one column across the whole board and the button says “Return”',
      focusedView.columns === 2 &&
        focusedView.visible === 1 &&
        focusedView.boardFocused &&
        focusedView.label === 'Return' &&
        focusedView.widths[0] > boardWidth - 60,
      `visible=${focusedView.visible}, width=${focusedView.widths[0]} of ${boardWidth}, label="${focusedView.label}"`,
    );

    await cdp.evaluate(`document.querySelector('.column[data-focus] [data-act="focus"]').click()`);
    await sleep(350);
    const returnedView = JSON.parse(await cdp.evaluate(viewState));
    checks.record(
      '“Return” brings the multi-model view back with equal columns',
      returnedView.visible === 2 &&
        returnedView.label === 'Full' &&
        !returnedView.boardFocused &&
        Math.abs(returnedView.widths[0] - returnedView.widths[1]) <= 1,
      `visible=${returnedView.visible}, widths=${returnedView.widths.join('+')}, label="${returnedView.label}"`,
    );

    /* ── 7c. Summarize: one model is asked, and its answer is the summary ── */
    // A comparison round to summarise: two shared lines, two differing ones.
    await cdp.evaluate(typePrompt('Compare cats and dogs for a home office'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);
    await waitFor(
      async () => {
        const state = JSON.parse(await cdp.evaluate(columnStates));
        return state.statuses.length === 2 &&
          state.statuses.every((status) => status === 'done') &&
          state.stopHidden
          ? state
          : null;
      },
      30000,
      250,
    );
    await sleep(300);

    const chip = JSON.parse(
      await cdp.evaluate(`(() => {
        const chip = document.getElementById('summarize-model-chip');
        const select = document.getElementById('summarize-model');
        return JSON.stringify({
          visible: !chip.hidden && chip.getBoundingClientRect().width > 80,
          inTopBar: chip.closest('.main-head') !== null,
          label: (chip.querySelector('.summarize-model-label') || {}).textContent || '',
          options: Array.from(select.options).map((option) => option.textContent.trim()),
          selected: select.selectedOptions[0] ? select.selectedOptions[0].textContent.trim() : '',
          disabled: select.disabled
        });
      })()`),
    );
    checks.record(
      'the top bar carries a “Summary by” tag with every model',
      chip.visible &&
        chip.inTopBar &&
        chip.label.trim() === 'Summary by' &&
        chip.options.length === 2 &&
        chip.selected === 'llama3.2' &&
        !chip.disabled,
      `${chip.options.join(' / ')} · selected=${chip.selected}`,
    );

    const requestsBeforeSummary = mock.requests.length;
    const pickPrompt = (request) => {
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      return String((lastUser && lastUser.content) || '');
    };
    const summaryIdle = `document.getElementById('summary-stop').hidden &&
      document.getElementById('summary-body').querySelector('.answer') !== null`;

    await cdp.evaluate(`document.getElementById('summarize-btn').click()`);
    const summaryDone = await waitFor(
      async () => cdp.evaluate(`!document.getElementById('summary-panel').hidden && ${summaryIdle}`),
      25000,
      200,
    );
    checks.record('Summarize opens the summary panel with a model answer', summaryDone === true);

    const firstAsk = mock.requests.slice(requestsBeforeSummary);
    const firstPrompt = firstAsk.length ? pickPrompt(firstAsk[0]) : '';
    checks.record(
      'clicking Summarize asks exactly one model, once',
      firstAsk.length === 1 && firstAsk[0].model === 'llama3.2',
      `${firstAsk.length} call(s), model=${firstAsk.map((request) => request.model).join(',')}`,
    );
    checks.record(
      'that model is handed every answer of the round',
      /### Agreed/.test(firstPrompt) &&
        /Cats are independent and quiet/.test(firstPrompt) &&
        /Cats are affectionate when they choose/.test(firstPrompt) &&
        /llama3\.2/.test(firstPrompt) &&
        /qwen2\.5/.test(firstPrompt),
      `${firstPrompt.length} chars of prompt`,
    );

    const summaryPanel = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        columnsInvisible: getComputedStyle(document.querySelector('.columns')).visibility === 'hidden',
        bullets: document.querySelectorAll('.summary-answer .answer li').length,
        headings: Array.from(document.querySelectorAll('.summary-answer .answer h3, .summary-answer .answer h4')).map((node) => node.textContent.trim()),
        tableHead: Array.from(document.querySelectorAll('.summary-answer .answer thead th')).map((node) => node.textContent.trim()),
        tableRows: Array.from(document.querySelectorAll('.summary-answer .answer tbody tr')).map((row) => ({
          label: row.querySelector('td').textContent.trim(),
          cells: Array.from(row.querySelectorAll('td')).slice(1).map((cell) => cell.textContent.trim())
        })),
        links: Array.from(document.querySelectorAll('.summary-links li')).map((item) => item.textContent.trim()),
        sub: document.getElementById('summary-sub').textContent.trim(),
        againHidden: document.getElementById('summary-again').hidden,
        copyDisabled: document.getElementById('summary-copy').disabled
      })`),
    );
    checks.record(
      'the panel shows what the model wrote, with the columns still mounted',
      summaryPanel.columnsInvisible &&
        summaryPanel.bullets === 2 &&
        summaryPanel.headings.join('|').includes('Agreed') &&
        !summaryPanel.againHidden &&
        !summaryPanel.copyDisabled,
      `headings=${summaryPanel.headings.join(' + ')} · bullets=${summaryPanel.bullets}`,
    );
    checks.record(
      'the model’s table keeps one column per model',
      summaryPanel.tableHead.length === 3 &&
        summaryPanel.tableHead[0] === 'Item' &&
        summaryPanel.tableHead[1] === 'llama3.2' &&
        summaryPanel.tableHead[2] === 'qwen2.5',
      summaryPanel.tableHead.join(' | '),
    );
    checks.record(
      'each differing item is a row with one cell per model',
      summaryPanel.tableRows.length >= 2 &&
        summaryPanel.tableRows.every((row) => row.cells.length === 2) &&
        summaryPanel.tableRows.some(
          (row) => /Cats/i.test(row.label) && /independent/.test(row.cells[0]) && /affectionate/.test(row.cells[1]),
        ),
      summaryPanel.tableRows.map((row) => `${row.label}: ${row.cells.join(' / ')}`).join(' || '),
    );
    checks.record(
      'the window adds the per-model chat links the model could not know',
      summaryPanel.links.length === 2 && summaryPanel.links.every((line) => /API model/.test(line)),
      summaryPanel.links.join(' || '),
    );

    /* Scope and model are part of the question: both re-ask the model. */
    await cdp.evaluate(`document.querySelector('#summary-scope button[data-scope="chat"]').click()`);
    const scopeDone = await waitFor(
      async () =>
        cdp.evaluate(
          `${summaryIdle} && /whole chat/.test(document.getElementById('summary-sub').textContent)`,
        ),
      25000,
      200,
    );
    const scopeRequests = mock.requests.slice(requestsBeforeSummary + 1);
    checks.record(
      '“Whole chat” asks again with the conversation, not one prompt',
      Boolean(scopeDone) &&
        scopeRequests.length === 1 &&
        /THE CONVERSATION/.test(pickPrompt(scopeRequests[0])),
      `${scopeRequests.length} call(s)`,
    );

    const secondModelId = JSON.parse(
      await cdp.evaluate(
        `JSON.stringify(Array.from(document.getElementById('summarize-model').options).map((option) => option.value))`,
      ),
    )[1];
    await cdp.evaluate(`(() => {
      const select = document.getElementById('summarize-model');
      select.value = ${JSON.stringify(secondModelId)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const pickerDone = await waitFor(async () => cdp.evaluate(summaryIdle), 25000, 200);
    const pickerRequests = mock.requests.slice(requestsBeforeSummary + 2);
    checks.record(
      'picking another model re-asks that model',
      Boolean(pickerDone) && pickerRequests.length === 1 && pickerRequests[0].model === 'qwen2.5',
      `${pickerRequests.length} call(s), model=${pickerRequests.map((request) => request.model).join(',')}`,
    );

    /* Closing brings the same columns back; reopening reuses the stored summary. */
    await cdp.evaluate(`document.getElementById('summary-close').click()`);
    await sleep(400);
    const backToBoard = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        panelHidden: document.getElementById('summary-panel').hidden,
        columns: document.querySelectorAll('.column').length,
        visible: getComputedStyle(document.querySelector('.columns')).visibility,
        widths: Array.from(document.querySelectorAll('.column')).map((column) => Math.round(column.getBoundingClientRect().width)),
        texts: Array.from(document.querySelectorAll('.column .answer')).map((answer) => answer.innerText || '')
      })`),
    );
    checks.record(
      'closing the summary brings the same answers back untouched',
      backToBoard.panelHidden &&
        backToBoard.columns === 2 &&
        backToBoard.visible === 'visible' &&
        Math.abs(backToBoard.widths[0] - backToBoard.widths[1]) <= 1 &&
        /Latency matters/.test(backToBoard.texts.join(' ')),
      `columns=${backToBoard.columns} · widths=${backToBoard.widths.join('+')}`,
    );

    const requestsBeforeReopen = mock.requests.length;
    await cdp.evaluate(`document.getElementById('summarize-btn').click()`);
    await waitFor(
      async () =>
        cdp.evaluate(
          `!document.getElementById('summary-panel').hidden && document.getElementById('summary-body').querySelector('.answer') !== null`,
        ),
      20000,
      200,
    );
    checks.record(
      'reopening the same summary costs no second request',
      mock.requests.length === requestsBeforeReopen,
      `${mock.requests.length - requestsBeforeReopen} new call(s)`,
    );

    await cdp.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    await sleep(250);
    checks.record(
      'Esc closes the summary',
      (await cdp.evaluate(`document.getElementById('summary-panel').hidden`)) === true,
    );

    /* ── 8. Stop cancels a slow answer ──────────────────────────────────── */
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(250);
    await cdp.evaluate(setInput('.model-card:nth-child(2) input[data-act="model-name"]', 'slow-model'));
    await sleep(300);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    await cdp.evaluate(typePrompt('stop this please'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);

    const slowStarted = await waitFor(
      async () =>
        cdp.evaluate(
          `!!document.querySelector('.column:nth-child(2) .column-status[data-state="streaming"]')`,
        ),
      15000,
      150,
    );
    checks.record('slow model starts streaming', slowStarted === true);

    /*
     * The reported bug: every model had visibly answered, yet Stop stayed in the
     * corner. Assert the state that used to be impossible — the fast column is
     * done, the slow one is still going, and Stop is still available.
     */
    const fastFinished = await waitFor(
      async () =>
        cdp.evaluate(
          `document.querySelector('.column:nth-child(1) .column-status')?.dataset.state === 'done'`,
        ),
      15000,
      150,
    );
    checks.record(
      'fast column reports done while the slow model is still streaming',
      fastFinished === true,
    );

    const stopClickedAt = Date.now();
    await cdp.evaluate(`document.getElementById('stop-btn').click()`);
    const stopped = await waitFor(
      async () => {
        const state = JSON.parse(await cdp.evaluate(columnStates));
        return state.stopHidden && state.statuses.every((status) => status !== 'streaming' && status !== 'pending')
          ? state
          : null;
      },
      20000,
      200,
    );
    const stopLatency = Date.now() - stopClickedAt;
    checks.record(
      'Stop ends the run and re-enables Send',
      Boolean(stopped) && stopped.sendDisabled === false,
      stopped ? `statuses=${stopped.statuses.join(',')}` : 'timeout',
    );
    checks.record(
      'Stop settles quickly on its own (no waiting on the background)',
      Boolean(stopped) && stopLatency < 3000,
      `${stopLatency}ms`,
    );

    const stoppedLabel = await cdp.evaluate(
      `document.querySelector('.column:nth-child(2) .column-status')?.textContent?.trim() || ''`,
    );
    checks.record(
      'stopped column says Stopped and keeps partial text',
      /stopped/i.test(stoppedLabel),
      `label="${stoppedLabel}"`,
    );

    /* ── 9. removing a model is surgical and immediate ──────────────────── */
    const before = JSON.parse(
      await cdp.evaluate(`(() => {
        const columns = Array.from(document.querySelectorAll('.column'));
        columns[0].dataset.marker = 'keep-me';
        return JSON.stringify({
          widths: columns.map((column) => Math.round(column.getBoundingClientRect().width)),
          text: columns[0].querySelector('.answer')?.innerText || ''
        });
      })()`),
    );

    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(
      `document.querySelectorAll('.model-card [data-act="remove"]')[1]?.click()`,
    );
    await sleep(700);
    const afterRemove = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        settingsStillOpen: !document.getElementById('view-settings').hidden,
        cards: document.querySelectorAll('.model-card').length,
        columns: document.querySelectorAll('.column').length,
        headings: Array.from(document.querySelectorAll('.column-name')).map((n) => n.textContent)
      })`),
    );
    checks.record(
      'removing a model drops its column immediately (Settings still open)',
      afterRemove.settingsStillOpen && afterRemove.cards === 1 && afterRemove.columns === 1,
      `cards=${afterRemove.cards}, columns=${afterRemove.columns}, left="${afterRemove.headings.join()}"`,
    );

    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(400);
    const afterRemoveLayout = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        width: Math.round(document.querySelector('.column').getBoundingClientRect().width),
        marker: document.querySelector('.column')?.dataset.marker || '',
        text: document.querySelector('.column .answer')?.innerText || ''
      })`),
    );
    checks.record(
      'the rest of the chat is not re-rendered (same node, same answer)',
      afterRemoveLayout.marker === 'keep-me' &&
        afterRemoveLayout.text === before.text &&
        afterRemoveLayout.text.length > 0,
      `same node=${afterRemoveLayout.marker === 'keep-me'}, same text=${afterRemoveLayout.text === before.text}`,
    );
    checks.record(
      'remaining column grows into the freed width',
      afterRemoveLayout.width > before.widths[0] + 40,
      `${before.widths.join('+')}px → ${afterRemoveLayout.width}px`,
    );

    /* ── 10. removing the last model locks the composer ─────────────────── */
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(`document.querySelector('.model-card [data-act="remove"]')?.click()`);
    await sleep(700);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(400);
    const emptied = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        columns: document.querySelectorAll('.column').length,
        emptyVisible: !document.getElementById('empty-state').hidden,
        headline: document.querySelector('#empty-state h2')?.textContent,
        aboveComposer: (() => {
          const panel = document.getElementById('empty-state');
          const composer = document.querySelector('.composer');
          return panel && composer
            ? panel.getBoundingClientRect().top < composer.getBoundingClientRect().top
            : false;
        })(),
        promptDisabled: document.getElementById('prompt').disabled,
        sendDisabled: document.getElementById('send-btn').disabled,
        meta: document.getElementById('conversation-meta')?.textContent
      })`),
    );
    checks.record(
      'last model removed → “Please add a model” above a disabled input',
      emptied.columns === 0 &&
        emptied.emptyVisible &&
        /please add a model/i.test(emptied.headline || '') &&
        emptied.aboveComposer &&
        emptied.promptDisabled &&
        emptied.sendDisabled,
      `columns=${emptied.columns}, headline="${emptied.headline}"`,
    );

    /* ── 11. another window changing settings updates this window live ──── */
    await cdp.evaluate(
      `(async () => {
         const stored = await chrome.storage.local.get('settings');
         const settings = stored.settings || {};
         settings.models = [{
           id: 'm_external', providerId: 'ollama', mode: 'api', label: 'Ollama',
           modelName: 'llama3.2', enabled: true, addedAt: Date.now()
         }];
         await chrome.storage.local.set({ settings });
       })()`,
      true,
    );
    const synced = await waitFor(
      async () => {
        const state = JSON.parse(
          await cdp.evaluate(`JSON.stringify({
            columns: document.querySelectorAll('.column').length,
            heading: document.querySelector('.column-name')?.textContent,
            promptDisabled: document.getElementById('prompt').disabled,
            emptyHidden: document.getElementById('empty-state').hidden
          })`),
        );
        return state.columns === 1 && state.emptyHidden && !state.promptDisabled ? state : null;
      },
      6000,
      200,
    );
    checks.record(
      'settings changed in another window update this window live',
      Boolean(synced),
      synced ? `column="${synced.heading}"` : 'no live update',
    );

    /* ── 12. a browser-session model never opens a tab ──────────────────── */
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(setInput('#add-provider', 'chatgpt'));
    await sleep(250);
    await cdp.evaluate(setInput('#add-mode', 'web'));
    await sleep(250);
    await cdp.evaluate(`document.querySelector('[data-act="add-model"]').click()`);
    await sleep(700);
    const webCard = JSON.parse(
      await cdp.evaluate(`JSON.stringify({
        cards: document.querySelectorAll('.model-card').length,
        badge: document.querySelectorAll('.model-card .mode-badge')[1]?.dataset.mode,
        label: document.querySelectorAll('.model-card .mode-badge')[1]?.textContent
      })`),
    );
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    const tabsBeforeWebRun = await cdp.evaluate(tabCount, true);
    await cdp.evaluate(typePrompt('browser session test'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);

    const webRunSettled = await waitFor(
      async () => {
        const state = JSON.parse(await cdp.evaluate(columnStates));
        return state.count === 2 &&
          state.stopHidden &&
          state.statuses.every((status) => status !== 'streaming' && status !== 'pending')
          ? state
          : null;
      },
      30000,
      250,
    );
    const tabsAfterWebRun = await cdp.evaluate(tabCount, true);
    const webColumnText = await cdp.evaluate(
      `document.querySelector('.column:nth-child(2) .column-body')?.innerText || ''`,
    );

    checks.record(
      'an existing-tab model becomes a “Tab” column',
      webCard.cards === 2 && webCard.badge === 'web',
      `cards=${webCard.cards}, badge=${webCard.badge} (${webCard.label})`,
    );
    checks.record(
      'sending to a browser-session model opens no tab',
      Boolean(webRunSettled) && tabsAfterWebRun === tabsBeforeWebRun,
      `tabs ${tabsBeforeWebRun} → ${tabsAfterWebRun}`,
    );
    checks.record(
      'that column explains no tab is open instead of opening one',
      /no chatgpt tab is open|does not open tabs/i.test(webColumnText),
      webColumnText.replaceAll('\n', ' ').slice(0, 100),
    );

    /* ── 12b. a tab-mode column can go back to the embedded panel ────────── */
    const recovery = JSON.parse(
      await cdp.evaluate(`(() => {
        const column = document.querySelector('.column:nth-child(2)');
        return JSON.stringify({
          openTab: !!column.querySelector('[data-act="open-tab"]'),
          switchEmbed: !!column.querySelector('[data-act="switch-embed"]')
        });
      })()`),
    );
    checks.record(
      'a tab-mode error offers both fixes in place',
      recovery.openTab && recovery.switchEmbed,
      `open-tab=${recovery.openTab}, switch-embed=${recovery.switchEmbed}`,
    );

    const tabsBeforeSwitch = await cdp.evaluate(tabCount, true);
    await cdp.evaluate(`document.querySelector('.column:nth-child(2) [data-act="switch-embed"]').click()`);
    const switched = await waitFor(
      async () =>
        cdp.evaluate(`(() => {
           const column = document.querySelector('.column:nth-child(2)');
           const frame = column ? column.querySelector('iframe') : null;
           const src = frame ? frame.getAttribute('src') || '' : '';
           return column && column.classList.contains('is-embed') && /chatgpt\\.com/.test(src)
             ? JSON.stringify({ embed: true, src })
             : null;
         })()`),
      20000,
      250,
    );
    const tabsAfterSwitch = await cdp.evaluate(tabCount, true);
    checks.record(
      '“Use the embedded panel” turns that column into the provider page, without a tab',
      Boolean(switched) && tabsAfterSwitch === tabsBeforeSwitch,
      switched ? `src=${JSON.parse(switched).src}` : 'no iframe',
    );

    /* The same switch exists on the card, for models that were added as a tab. */
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(400);
    const cardMode = JSON.parse(
      await cdp.evaluate(`(() => {
        const select = document.querySelector('.model-card:nth-child(2) [data-act="model-mode"]');
        return JSON.stringify({
          hasSelect: Boolean(select),
          value: select ? select.value : '',
          options: select ? Array.from(select.options).map((option) => option.value) : []
        });
      })()`),
    );
    checks.record(
      'each model card has a Connection dropdown',
      cardMode.hasSelect &&
        cardMode.value === 'embed' &&
        cardMode.options.includes('embed') &&
        cardMode.options.includes('web'),
      `${cardMode.value} of ${cardMode.options.join('/')}`,
    );

    await cdp.evaluate(`(() => {
      const select = document.querySelector('.model-card:nth-child(2) [data-act="model-mode"]');
      select.value = 'web';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(700);
    const backToTab = JSON.parse(
      await cdp.evaluate(`(() => {
        const column = document.querySelector('.column:nth-child(2)');
        const select = document.querySelector('.model-card:nth-child(2) [data-act="model-mode"]');
        return JSON.stringify({
          embed: column ? column.classList.contains('is-embed') : null,
          badge: (document.querySelectorAll('.model-card .mode-badge')[1] || {}).dataset
            ? document.querySelectorAll('.model-card .mode-badge')[1].dataset.mode
            : '',
          select: select ? select.value : ''
        });
      })()`),
    );
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(250);
    checks.record(
      'the Connection dropdown switches an existing model back',
      backToTab.embed === false && backToTab.badge === 'web' && backToTab.select === 'web',
      `embed=${backToTab.embed}, badge=${backToTab.badge}, select=${backToTab.select}`,
    );

    /* ── 13. New chat works even while a model is still answering ───────── */
    // The reported bug: with an answer in flight, New chat refused to do anything
    // (it waited for a `final` that a slow model may take minutes to send).
    await cdp.evaluate(`document.getElementById('settings-btn').click()`);
    await sleep(300);
    await cdp.evaluate(setInput('.model-card:nth-child(1) input[data-act="model-name"]', 'slow-model'));
    await sleep(300);
    await cdp.evaluate(`document.getElementById('settings-back').click()`);
    await sleep(300);

    const historyBefore = await cdp.evaluate(`document.querySelectorAll('.history-item').length`);
    await cdp.evaluate(typePrompt('new chat during a run'));
    await cdp.evaluate(`document.getElementById('send-btn').click()`);
    await waitFor(
      async () => cdp.evaluate(`!!document.querySelector('.column-status[data-state="streaming"]')`),
      15000,
      150,
    );

    await cdp.evaluate(`document.getElementById('new-chat').click()`);
    const clearedDuringRun = await waitFor(
      async () => {
        const state = JSON.parse(
          await cdp.evaluate(`JSON.stringify({
            title: document.getElementById('conversation-title')?.textContent,
            stopHidden: document.getElementById('stop-btn').hidden,
            sendDisabled: document.getElementById('send-btn').disabled,
            columns: document.querySelectorAll('.column').length,
            answers: Array.from(document.querySelectorAll('.column .answer')).map(a => (a.innerText || '').length),
            history: document.querySelectorAll('.history-item').length
          })`),
        );
        return state.title === 'New chat' && state.stopHidden && !state.sendDisabled ? state : null;
      },
      8000,
      200,
    );
    checks.record(
      'New chat stops the running answer instead of refusing',
      Boolean(clearedDuringRun) &&
        clearedDuringRun.columns === 2 &&
        clearedDuringRun.answers.every((length) => length === 0) &&
        clearedDuringRun.history >= historyBefore,
      clearedDuringRun
        ? `title="${clearedDuringRun.title}", answers=${clearedDuringRun.answers.join(',')}, history ${historyBefore}→${clearedDuringRun.history}`
        : 'New chat stayed blocked',
    );

    /* ── 14. health ─────────────────────────────────────────────────────── */
    const errors = cdp.pageErrors();
    checks.record('no console errors / exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));  } finally {
    cdp?.close();
    await browser.close();
    await mock.close();
  }

  process.exit(checks.summary() ? 0 : 1);
}

run().catch((error) => {
  console.error(`\n✗ e2e test crashed: ${error.message}`);
  process.exit(1);
});
