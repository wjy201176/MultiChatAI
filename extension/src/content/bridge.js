/**
 * Content-script bridge (browser-session mode).
 *
 * Runs inside the provider's own page, where the user's session cookies already
 * work. It receives a prompt from the service worker, types it into the real
 * composer, submits it, then polls the rendered transcript and streams the
 * newest answer back.
 *
 * Design notes
 *   - Everything is retried and verified: a click that does not clear the
 *     composer is followed by a synthetic Enter.
 *   - Progress frames carry the *full* text so far, so the column can never be
 *     corrupted by a lost or duplicated message.
 *   - The answer is considered finished when the text stops changing AND the
 *     site's stop button is gone (or after a long stability window).
 *   - Nothing is written to the page's own UI; the app tab is the only surface.
 */

(function () {
  'use strict';

  if (window.__MULTICHAI_BRIDGE__) return;
  window.__MULTICHAI_BRIDGE__ = true;

  const site = window.MultiChatAISite;
  const adapter = site ? site.forHost(location.hostname) : null;
  if (!adapter) return;

  const POLL_MS = 650;
    /** @type {Map<string, {aborted: boolean, text: string}>} */
  const runs = new Map();

  /* ────────────────────────────── DOM utilities ────────────────────────────── */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function safeQueryAll(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function firstVisible(selectors) {
    for (const selector of selectors || []) {
      for (const el of safeQueryAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function readText(el) {
    if (!el) return '';
    const raw = el.innerText || el.textContent || '';
    return String(raw)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function composerSelectors() {
    return [...adapter.composer, ...(adapter.generic?.composer || [])];
  }

  function findComposer() {
    return firstVisible(composerSelectors());
  }

  /*
   * Signed-out provider pages still render a composer (it is the landing page),
   * so "composer exists" alone would claim Signed in. A visible sign-in
   * affordance in the page chrome is the reliable signal.
   */
  const LOGIN_SELECTORS = [
    'header button[data-testid="login-button"]',
    'header a[data-testid="login-button"]',
    'header a[href*="login"]',
    'header a[href*="signin"]',
    'header a[href*="sign-in"]',
    'nav a[href*="login"]',
    'nav a[href*="signin"]',
    'nav a[href*="sign-in"]',
  ];

  function looksSignedOut() {
    for (const selector of LOGIN_SELECTORS) {
      for (const el of safeQueryAll(selector)) {
        if (isVisible(el)) return true;
      }
    }
    /*
     * Site-specific affordances, matched by their *text*. Some apps (Gemini) put
     * "Sign in" in a plain Material button outside <header>/<nav>, which the generic
     * scan below can never see - that is how a signed-out panel reported "Signed in".
     * Only sites that declare signedOut selectors are scanned here, so no other
     * provider's detection changes.
     */
    for (const selector of adapter.signedOut || []) {
      for (const el of safeQueryAll(selector)) {
        if (!isVisible(el)) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        if (/^(log ?in|sign ?in|sign ?up|登录|登入|ログイン)$/i.test(text)) return true;
        if (/^(log ?in|sign ?in|sign ?up|登录|登入|ログイン)$/i.test(label)) return true;
      }
    }
    const candidates = Array.from(
      document.querySelectorAll('header button, header a, nav button, nav a'),
    ).slice(0, 150);
    return candidates.some(
      (el) =>
        isVisible(el) &&
        /^(log ?in|sign ?in|sign ?up|登录|登入|ログイン)$/i.test((el.textContent || '').trim()),
    );
  }

  /**
   * Does the page itself report that its realtime channel is blocked?
   *
   * Grok streams over a WebSocket to its own server; when a network or security policy
   * blocks that, the site renders its own message and every send fails. Detecting the
   * site's own words is the only reliable signal available to us.
   */
  function looksBlocked() {
    if (!adapter.blocked) return false;
    const text = (document.body && document.body.innerText) || '';
    if (!text) return false;
    return adapter.blocked.test(text.slice(0, 4000));
  }

  /**
   * The page's own state machine, as the app sees it.
   *
   * `ready` is the answer to the only question that matters to the user:
   * *can this model take the next question right now?* — the composer is there
   * and the site is not generating. A disabled send button does NOT count as
   * busy (an empty composer always disables it), so it is reported separately
   * as `sendReady` for diagnostics only.
   */
  function readState() {
    const hasComposer = Boolean(findComposer());
    const busy = Boolean(findStopButton());
    return {
      hasComposer,
      busy,
      ready: hasComposer && !busy,
      sendReady: Boolean(findSendButton()),
      signedIn: hasComposer && !looksSignedOut(),
      // Is this page actually on screen? A column showing a saved copy hides its
      // live iframe, and hiding a frame makes every element measure 0×0 — which must
      // NOT be reported as “this site refuses to be framed”.
      visible: document.visibilityState !== 'hidden',
      blocked: looksBlocked(),
      // Diagnostics: did the column-specific stylesheet get applied to this page?
      styled: Boolean(document.getElementById('mca-embedded-style')),
      // Can this page start a fresh conversation without a reload? The app uses it
      // to tell “started over” apart from “this site has no New chat control”.
      canStartNewChat: canStartNewChat(),
      // The provider rewrites this to its own per-conversation URL as soon as the
      // first message is sent; the app stores it so a column can reopen the real
      // conversation later (charts, tables and all) instead of our text copy.
      url: location.href,
    };
  }

  /**
   * Tell the app page (our parent) that this panel is ready / busy.
   *
   * This is push, not pull: the app does not have to ask the worker — which may
   * have been restarted mid-run — so a panel that finished answering can settle
   * its column on its own. Cross-origin safe: plain postMessage to the parent,
   * never read back.
   */
  /** Tell the column what happened when it asked for a fresh chat. */
  function reportNewChat(result) {
    if (!embedModelId) return;
    try {
      window.parent.postMessage(
        {
          type: 'MULTICHAI_NEW_CHAT_ACK',
          modelId: embedModelId,
          ok: Boolean(result && result.ok),
          saw: (result && result.saw) || [],
        },
        '*',
      );
    } catch {
      /* frame is navigating */
    }
  }

  function reportState() {
    if (!embedModelId) return; // a normal tab, not a column
    const state = readState();
    try {
      window.parent.postMessage(
        { type: 'MULTICHAI_STATE', modelId: embedModelId, ...state },
        '*',
      );
    } catch {
      /* frame is navigating */
    }
  }

  /** Words that name a new-chat control, in the languages these sites ship. */
  const NEW_CHAT_TEXT =
    /^(new chat|new conversation|start new chat|start a new chat|new thread|开启新对话|新对话|新建对话|新会话|新的对话|新しいチャット)$/i;

  /** Attributes / class names that name a new-chat control. */
  const NEW_CHAT_NAMES = [
    '[aria-label*="new chat" i]',
    '[aria-label*="new conversation" i]',
    '[title*="new chat" i]',
    '[data-testid*="new-chat" i]',
    '[class*="new-chat" i]',
    '[class*="newchat" i]',
    '[aria-label*="新对话"]',
    '[aria-label*="新会话"]',
    '[title*="新对话"]',
    '[class*="new-session" i]',
  ].join(',');

  /** The innermost of a set of nested matches — the one that handles clicks. */
  function pickDeepest(elements) {
    for (const el of elements) {
      if (elements.some((other) => other !== el && el.contains(other))) continue;
      return el;
    }
    return null;
  }

  /**
   * The site's own “New chat” control, if this page has one on screen.
   *
   * Three attempts, because providers disagree about markup: the selectors in
   * site-adapters.js, then anything *named* like a new-chat control (aria-label,
   * title, data-testid, class), then any small element whose visible text says
   * “New chat” / “新对话”. The last one exists because some sites (DeepSeek) use a
   * bare <div> with no role and no useful class — nothing a selector can find.
   */
  function findNewChatControl() {
    const precise = firstVisible([...adapter.newChat, ...(adapter.generic?.newChat || [])]);
    if (precise) return precise;

    const named = pickDeepest(safeQueryAll(NEW_CHAT_NAMES).filter(isVisible));
    if (named) return named;

    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], [role="link"], div, span, li'),
    ).slice(0, 4000);
    for (const el of candidates) {
      if (el.children.length > 2) continue; // a real control is (nearly) a leaf
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 24) continue;
      if (!NEW_CHAT_TEXT.test(text)) continue;
      return el;
    }
    return null;
  }

  // The DOM scan is not free, and the heartbeat runs every 1.5 s.
  let newChatCache = { at: 0, found: false };
  function canStartNewChat() {
    const now = Date.now();
    if (now - newChatCache.at > 5000) {
      newChatCache = { at: now, found: Boolean(findNewChatControl()) };
    }
    return newChatCache.found;
  }

  /**
   * Press the site's own “New chat” control.
   *
   * Used instead of navigating the page: a navigation reloads everything (cookie
   * banners, sign-in flashes, scroll) just to start a new thread. Returns `{ok}` —
   * the app turns a failure into a visible “press ⟳” instead of silently staying
   * on the old conversation.
   * @returns {{ok: boolean, saw?: Array<Object>}}
   */
  function clickNewChat() {
    const el = findNewChatControl();
    if (!el) return { ok: false, saw: sampleControls() };
    const clicked = clickEl(el);
    newChatCache.at = 0; // the control may disappear after the switch
    return { ok: clicked, saw: [] };
  }

  /**
   * A short sample of the page's visible controls, sent back when no new-chat
   * control was found. It is the only way to learn a site's markup from a report
   * (“DeepSeek did not reset”) without access to its page.
   */
  function sampleControls(limit = 8) {
    const out = [];
    for (const el of Array.from(
      document.querySelectorAll('button, a, [role="button"], [tabindex]'),
    ).slice(0, 400)) {
      if (!isVisible(el)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20),
        aria: (el.getAttribute('aria-label') || '').slice(0, 20),
        cls: String(el.className || '').slice(0, 32),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The element that carries the click handler (a span is usually inside one). */
  function actionable(el) {
    let node = el;
    for (let depth = 0; node && depth < 4; depth += 1) {
      if (node.matches?.('button, a, [role="button"], [role="link"], [tabindex]')) return node;
      node = node.parentElement;
    }
    return el;
  }

  /**
   * Click like a person does.
   *
   * A bare `.click()` only dispatches a `click` event; sites that act on
   * pointerdown/mousedown (icon buttons often do) ignore it. This dispatches the
   * whole sequence, then a real `.click()` for links.
   */
  function clickEl(el) {
    const target = actionable(el);
    try {
      const fire = (type, buttons) => {
        const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        target.dispatchEvent(
          new Ctor(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 0,
            buttons,
            pointerId: 1,
            isPrimary: true,
          }),
        );
      };
      fire('pointerdown', 1);
      fire('mousedown', 1);
      fire('pointerup', 0);
      fire('mouseup', 0);
      if (typeof target.click === 'function') target.click();
      else fire('click', 0);
      return true;
    } catch {
      return false;
    }
  }

  function findSendButton() {
    const selectors = [...adapter.send, ...(adapter.generic?.send || [])];
    for (const selector of selectors) {
      for (const el of safeQueryAll(selector)) {
        if (!isVisible(el)) continue;
        if (el.disabled) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        return el;
      }
    }
    return null;
  }

  function findStopButton() {
    const selectors = [...adapter.stop, ...(adapter.generic?.stop || [])];
    for (const selector of selectors) {
      for (const el of safeQueryAll(selector)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  /** The newest assistant message element currently on screen. */
  function lastAssistantNode() {
    const selectors = [...adapter.assistant, ...(adapter.generic?.assistant || [])];
    for (const selector of selectors) {
      const nodes = safeQueryAll(selector);
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        if (readText(nodes[i])) return nodes[i];
      }
    }
    return null;
  }

  /** Text of the newest assistant message currently on screen. */
  function lastAssistantText() {
    const node = lastAssistantNode();
    return node ? readText(node) : '';
  }

  /**
   * The newest answer as HTML, with charts baked in.
   *
   * Why: history has to show what the model actually rendered — tables, code,
   * diagrams — without loading the provider's page again (that reload is what asked
   * Gemini to sign in and re-showed DeepSeek's cookie banner). So the rendered
   * answer is captured once, when it settles, and replayed later in a sandboxed
   * frame. Canvases are replaced by their pixels, because a cloned <canvas> is blank.
   *
   * @returns {string} HTML, or '' when there is nothing worth storing
   */
  function captureAnswerHtml(maxChars = 240000, maxCanvasBytes = 180000) {
    const node = lastAssistantNode();
    if (!node) return '';

    const clone = node.cloneNode(true);

    // Charts are usually <canvas>: copy the original pixels into an <img>.
    try {
      const originals = node.querySelectorAll('canvas');
      const copies = clone.querySelectorAll('canvas');
      for (let i = 0; i < Math.min(originals.length, copies.length); i += 1) {
        try {
          const url = originals[i].toDataURL('image/png');
          if (!url || url.length > maxCanvasBytes) {
            copies[i].remove();
            continue;
          }
          const img = document.createElement('img');
          img.src = url;
          img.alt = 'chart';
          copies[i].replaceWith(img);
        } catch {
          copies[i].remove(); // tainted canvas — nothing we can copy
        }
      }
    } catch {
      /* canvases are best effort */
    }

    // Provider scripts and form controls have no place in a stored copy.
    for (const el of clone.querySelectorAll(
      'script, link, iframe, object, embed, form, input, button, textarea, select, meta',
    )) {
      el.remove();
    }
    for (const el of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        else if (
          (attr.name === 'href' || attr.name === 'xlink:href' || attr.name === 'src') &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const html = clone.outerHTML;
    return html.length < 40 || html.length > maxChars ? '' : html;
  }

  function userMessageCount() {
    const selectors = [...adapter.user, ...(adapter.generic?.user || [])];
    let count = 0;
    for (const selector of selectors) count = Math.max(count, safeQueryAll(selector).length);
    return count;
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(intervalMs);
    }
  }

  /* ────────────────────────────── input driving ────────────────────────────── */

  async function setComposerValue(composer, text) {
    composer.focus();
    const tag = composer.tagName;

    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      return;
    }

    // contenteditable: a paste event keeps newlines without submitting.
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      composer.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
      await sleep(220);
    } catch {
      /* ClipboardEvent unsupported — fall back below */
    }

    if (!readText(composer)) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, text);
      await sleep(150);
    }

    if (!readText(composer)) {
      // Last resort for frameworks that only listen to input events.
      composer.textContent = text;
      composer.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
      );
      await sleep(150);
    }
  }

  function fireEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  async function dataUrlToFile(dataUrl, name, type) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl || ''));
    if (!match) return null;
    try {
      const binary = atob(match[2]);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name || 'attachment', { type: type || match[1] });
    } catch {
      return null;
    }
  }

  /** Best-effort attachment upload through the site's own file input. */
  async function attachFiles(attachments) {
    const input = document.querySelector('input[type="file"]');
    if (!input || !attachments || !attachments.length) return false;

    const files = [];
    for (const item of attachments) {
      if (!item) continue;
      if (item.kind === 'image' && item.dataUrl) {
        const file = await dataUrlToFile(item.dataUrl, item.name, item.type);
        if (file) files.push(file);
      } else if (item.kind === 'text' && typeof item.text === 'string') {
        files.push(new File([item.text], item.name || 'attachment.txt', { type: item.type || 'text/plain' }));
      }
    }
    if (!files.length) return false;

    try {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(700);
      return true;
    } catch {
      return false;
    }
  }

  /* ────────────────────────────── answering ────────────────────────────── */

  function emit(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* worker asleep or extension reloading */
    }
  }

  /**
   * @param {string} runId
   * @param {string} text
   * @param {boolean} stopped
   * @param {boolean} [captured]
   * @param {string} [html] the rendered answer, so history can show it without a reload
   */
  function finishOk(runId, text, stopped, captured = true, html = '') {
    emit({
      type: 'MULTICHAI_RESULT',
      runId,
      ok: true,
      text: text || '',
      stopped: Boolean(stopped),
      captured: captured !== false,
      // Captured here, while the page still has the rendered answer (charts, tables).
      html: html || '',
    });
  }

  function finishFail(runId, error, hint) {
    emit({
      type: 'MULTICHAI_RESULT',
      runId,
      ok: false,
      error: String(error || 'Unknown error'),
      hint: hint || null,
    });
  }

  /**
   * Wait for the page to finish answering.
   *
   * Completion is decided by the page's **own state machine** — "is this page
   * ready for the next question again?" (composer present, stop control gone) —
   * not by the send button and not only by scraped text. The scraped text is
   * best effort (history, copy); an empty capture still finishes cleanly, and the
   * app is told so it can say “Answered in the panel”.
   */
  async function collectAnswer(runId, state, baseline, timeoutMs) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let text = '';
    let lastSeen = '';
    let stablePolls = 0;
    let readyPolls = 0;
    let lastChangeAt = Date.now();
    let sawBusy = false;

    while (Date.now() < deadline) {
      if (state.aborted) {
        findStopButton()?.click();
        return { text, stopped: true, captured: Boolean(text) };
      }

      const busy = Boolean(findStopButton());
      if (busy) sawBusy = true;

      const current = lastAssistantText();
      if (current && current !== baseline) {
        if (current !== lastSeen) {
          lastSeen = current;
          text = current;
          state.text = text;
          stablePolls = 0;
          lastChangeAt = Date.now();
          emit({ type: 'MULTICHAI_PROGRESS', runId, text, phase: 'streaming' });
        } else {
          stablePolls += 1;
        }
      }

      const hasComposer = Boolean(findComposer());
      readyPolls = hasComposer && !busy ? readyPolls + 1 : 0;
      reportState();

      const verdict = window.MultiChatAICompletion.decide({
        hasComposer,
        busy,
        sawBusy,
        elapsedMs: Date.now() - startedAt,
        quietMs: Date.now() - lastChangeAt,
        stablePolls,
        readyPolls,
        haveText: Boolean(text),
      });

      if (verdict === 'done') return { text, stopped: false, captured: true };
      if (verdict === 'done-no-text') return { text: '', stopped: false, captured: false };

      await sleep(POLL_MS);
    }

    return { text, stopped: false, timedOut: true, captured: Boolean(text) };
  }

  async function runPrompt(message) {
    const runId = message.runId;
    const state = { aborted: false, text: '' };
    runs.set(runId, state);

    const notify = (text, phase) => emit({ type: 'MULTICHAI_PROGRESS', runId, text, phase });

    try {
      const composer = await waitFor(findComposer, 20000, 300);
      if (!composer) {
        finishFail(
          runId,
          `Could not find the message box on ${location.hostname}.`,
          'The page may still be loading, or it is showing a sign-in screen. Use the ↗ button in the column to open the tab.',
        );
        return;
      }

      if (message.attachments && message.attachments.length) {
        await attachFiles(message.attachments).catch(() => false);
      }

      notify('', 'typing');
      await setComposerValue(composer, String(message.prompt || ''));

      if (!readText(composer) && !(composer.value || '').trim()) {
        finishFail(
          runId,
          'The prompt could not be typed into the page.',
          'The site changed its composer. Use API mode, or update src/content/site-adapters.js.',
        );
        return;
      }

      const baseline = lastAssistantText();
      const usersBefore = userMessageCount();

      const sendButton = findSendButton();
      if (sendButton) sendButton.click();
      else fireEnter(composer);

      const sent = await waitFor(() => {
        const remaining = (composer.value || readText(composer) || '').trim();
        return (
          !remaining ||
          lastAssistantText() !== baseline ||
          userMessageCount() > usersBefore ||
          Boolean(findStopButton())
        );
      }, 3500, 300);

      if (!sent) {
        fireEnter(composer);
        const retried = await waitFor(
          () => !(composer.value || readText(composer) || '').trim() || Boolean(findStopButton()),
          4000,
          300,
        );
        if (!retried) {
          finishFail(
            runId,
            'The prompt was typed but the site did not send it.',
            'Press Send once in that tab to check you can chat there, then try again.',
          );
          return;
        }
      }

      /*
       * If the site says its realtime channel is blocked, this answer cannot arrive —
       * fail in a second with that reason instead of sitting on the timeout (Grok needs
       * a WebSocket to its own server; a network policy that blocks it makes every send
       * fail). Sites without `blocked` are unaffected.
       */
      if (looksBlocked()) {
        finishFail(
          runId,
          `${location.hostname} reports that its realtime connection is blocked here.`,
          'This model needs a WebSocket to its own server. Switch it to API-key mode, or use “existing tab” mode with that tab open.',
        );
        return;
      }

      notify('', 'waiting');
      const timeoutMs = Math.max(30000, Number(message.timeoutMs) || 180000);
      const result = await collectAnswer(runId, state, baseline, timeoutMs);

      /*
       * Capture what the page rendered *now*, before anything can navigate it away:
       * this is the copy that history replays later (tables, charts, code) without
       * loading the provider again.
       */
      const html = captureAnswerHtml();

      if (result.text) {
        finishOk(runId, result.text, result.stopped, true, html);
        return;
      }

      // The page finished answering, we simply could not read its answer text
      // (adapter mismatch). Report success with `captured:false` so the UI can say
      // “answered in the panel” instead of holding the run open.
      if (!result.timedOut && result.captured === false) {
        finishOk(runId, '', result.stopped, false, html);
        return;
      }

      finishFail(
        runId,
        result.timedOut ? 'No answer arrived before the timeout.' : 'No answer text was found on the page.',
        'The adapter may need an update, or the model refused to answer. Check the tab with ↗.',
      );
    } catch (error) {
      finishFail(runId, error?.message || String(error));
    } finally {
      runs.delete(runId);
    }
  }

  function abort(runId) {
    const state = runs.get(runId);
    if (state) {
      state.aborted = true;
      findStopButton()?.click();
    }
  }

  /* ────────────────────────────── registration ────────────────────────────── */

  /*
   * When this page is framed inside a MultiChatAI column, the app page tells the
   * bridge which model it is with a postMessage handshake (cross-origin safe, no
   * URL or window.name rewriting needed). An un-framed page (a normal tab) simply
   * never receives one and keeps working tab-style.
   */
  let embedModelId = '';

  function announce() {
    try {
      const state = readState();
      const result = chrome.runtime.sendMessage({
        type: 'MULTICHAI_HELLO',
        modelId: embedModelId,
        host: location.hostname,
        adapter: adapter.id,
        signedIn: state.signedIn,
        hasComposer: state.hasComposer,
        busy: state.busy,
        ready: state.ready,
        embedded: Boolean(embedModelId),
        url: location.href,
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* worker asleep or extension reloading */
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (event.source !== window.parent) return;

    // “New chat” from the column: press the site's own control, never navigate.
    if (data.type === 'MULTICHAI_NEW_CHAT') {
      const result = clickNewChat();
      reportNewChat(result);
      return;
    }

    if (data.type !== 'MULTICHAI_IDENTITY') return;
    const next = String(data.modelId || '');
    if (!next) return;
    embedModelId = next;
    announce();
    reportState();
  });

  announce();
  // Composers usually appear after first paint; keep announcing until we have one.
  (async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(1500);
      announce();
      if (findComposer() && embedModelId) break;
    }
  })();

  /* ─────────────────────── framed layout adjustments ─────────────────────── */

  /**
   * Some sites keep a desktop two-pane layout inside a 300–500 px column (Grok:
   * bot rail + chat), which squeezes both. Only the *column* is affected: the styles
   * belong to the provider's adapter, are injected once, and only when this page is
   * actually framed.
   */
  function applyEmbeddedStyles() {
    if (window.top === window) return; // a normal tab keeps the site's own layout
    if (!adapter.embeddedStyles) return;
    try {
      document.documentElement.classList.add('mca-embedded');
      if (document.getElementById('mca-embedded-style')) return;
      const style = document.createElement('style');
      style.id = 'mca-embedded-style';
      style.textContent = adapter.embeddedStyles;
      (document.head || document.documentElement).appendChild(style);
    } catch {
      /* the frame may be navigating */
    }
  }

  applyEmbeddedStyles();
  setInterval(applyEmbeddedStyles, 3000); // survives client-side re-renders

  /*
   * Readiness heartbeat for the column: pushed to the app page every 1.5s so a
   * panel that has finished answering can unlock the composer on its own, even
   * if the worker was restarted and no longer has this run.
   */
  setInterval(reportState, 1500);

  /* ────────────────────────────── messaging ────────────────────────────── */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'MULTICHAI_PING') {
      const state = readState();
      sendResponse({
        ok: true,
        ready: true,
        host: location.hostname,
        adapter: adapter.id,
        signedIn: state.signedIn,
        hasComposer: state.hasComposer,
        visible: state.visible,
        styled: state.styled,
        busy: state.busy,
        readyForNext: state.ready,
        modelId: embedModelId,
        embedded: Boolean(embedModelId),
        url: location.href,
      });
      return false;
    }

    if (message.type === 'MULTICHAI_RUN') {
      sendResponse({ accepted: true });
      void runPrompt(message);
      return false;
    }

    if (message.type === 'MULTICHAI_ABORT') {
      abort(message.runId);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'MULTICHAI_NEW_CHAT') {
      sendResponse(clickNewChat());
      return false;
    }

    return false;
  });
})();
