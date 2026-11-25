/**
 * The column board: one column per model, each showing that model's answer.
 *
 * The board is rendered from "column descriptors" so it can show a live run
 * (models from settings) or a restored conversation turn (whatever models were
 * used back then, even if they were removed since).
 */

import { escapeHtml, formatDuration, throttle } from '../util.js';
import { renderMarkdown } from '../markdown.js';
import { buildSnapshotDocument } from '../snapshot-doc.js';

/**
 * @typedef {Object} ColumnDescriptor
 * @property {string} key        stable id (model id)
 * @property {string} name       e.g. "ChatGPT"
 * @property {string} subtitle   e.g. "gpt-4o-mini" or "browser session"
 * @property {string} color      dot colour
 * @property {string} providerId
 * @property {string} mode       'web' | 'api'
 */

const STATUS_TEXT = {
  idle: 'Ready',
  pending: 'Waiting for reply…',
  streaming: 'Streaming…',
  done: 'Done',
  error: 'Error',
  timeout: 'Timed out',
  aborted: 'Stopped',
};

export class ColumnBoard {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root       the .columns container
   * @param {HTMLElement} options.emptyEl    the empty-state panel
   * @param {(descriptor: ColumnDescriptor, text: string) => void} options.onCopy
   * @param {(descriptor: ColumnDescriptor) => void} options.onOpen
   */
  constructor({ root, emptyEl, onCopy, onOpen, onSwitchTab, onSwitchEmbed, onOpenTab, onOpenLive, onFocusChange }) {
    this.root = root;
    this.emptyEl = emptyEl;
    this.onCopy = onCopy;
    this.onOpen = onOpen;
    this.onSwitchTab = onSwitchTab;
    this.onSwitchEmbed = onSwitchEmbed;
    this.onOpenTab = onOpenTab;
    this.onOpenLive = onOpenLive;
    this.onFocusChange = onFocusChange;
    /** Key of the column shown full-width, or '' for the normal board. */
    this.focusedKey = '';
    /** @type {Map<string, any>} */
    this.columns = new Map();
    /** @type {ColumnDescriptor[]} */
    this.descriptors = [];

    this.root.addEventListener('click', (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest('[data-act]');
      if (!btn) return;
      const columnEl = btn.closest('.column');
      if (!columnEl) return;
      const rec = this.columns.get(columnEl.getAttribute('data-key'));
      if (!rec) return;
      if (btn.dataset.act === 'copy') this.onCopy(rec.descriptor, rec.rawText);
      else if (btn.dataset.act === 'open') this.onOpen(rec.descriptor);
      else if (btn.dataset.act === 'reload-embed') this.reload(rec.descriptor.key);
      else if (btn.dataset.act === 'switch-tab') this.onSwitchTab?.(rec.descriptor);
      else if (btn.dataset.act === 'switch-embed') this.onSwitchEmbed?.(rec.descriptor);
      else if (btn.dataset.act === 'open-tab') this.onOpenTab?.(rec.descriptor);
      else if (btn.dataset.act === 'open-thread') this.openThread(rec.descriptor.key);
      else if (btn.dataset.act === 'focus') this.toggleFocus(rec.descriptor.key);
      else if (btn.dataset.act === 'open-live') this.openLive(rec.descriptor.key);
    });
  }

  /** Build the DOM + bookkeeping for one column descriptor. */
  #create(descriptor) {
    const embedded = descriptor.mode === 'embed';
    const el = document.createElement('article');
    el.className = `column${embedded ? ' is-embed' : ''}`;
    el.setAttribute('data-key', descriptor.key);

    const focusBtn = `<button class="icon-btn icon-btn-text" type="button" data-act="focus"
              title="Show this model full width" aria-label="Show this model full width"
              aria-pressed="false">Full</button>`;

    const tools = embedded
      ? `<button class="icon-btn" type="button" data-act="reload-embed" title="Reload this panel" aria-label="Reload this panel">
           <svg class="ico" aria-hidden="true"><use href="#i-refresh" /></svg>
         </button>
         <button class="icon-btn" type="button" data-act="open" title="Open this site in a new tab" aria-label="Open this site in a new tab">
           <svg class="ico" aria-hidden="true"><use href="#i-external" /></svg>
         </button>
         ${focusBtn}`
      : `<button class="icon-btn" type="button" data-act="copy" title="Copy this answer" aria-label="Copy this answer">
           <svg class="ico" aria-hidden="true"><use href="#i-copy" /></svg>
         </button>
         <button class="icon-btn" type="button" data-act="open" title="Open this model's site in a new tab" aria-label="Open this model's site in a new tab">
           <svg class="ico" aria-hidden="true"><use href="#i-external" /></svg>
         </button>
         ${focusBtn}`;

    const body = embedded
      ? `<div class="column-body is-embed">
           <div class="column-embed-wrap">
             <iframe class="column-embed" title="${escapeHtml(descriptor.name)} chat"
                     allow="clipboard-read; clipboard-write"></iframe>
           </div>
           <div class="column-snapshot" hidden>
             <div class="snapshot-bar"></div>
             <div class="snapshot-list"></div>
           </div>
           <div class="column-embed-notice" hidden></div>
         </div>`
      : `<div class="column-body">
           <span class="column-status" data-state="idle">${STATUS_TEXT.idle}</span>
           <div class="answer"></div>
           <div class="column-placeholder">Waiting for your prompt…</div>
         </div>`;

    el.innerHTML = `
      <header class="column-head">
        <span class="column-dot" style="--dot:${escapeHtml(descriptor.color || '#8b93a7')}"></span>
        <span class="column-title">
          <span class="column-name">${escapeHtml(descriptor.name)}</span>
          <span class="column-model">${escapeHtml(descriptor.subtitle || '')}</span>
        </span>
        ${embedded ? '<span class="column-status embed-pill" data-state="idle">Loading…</span>' : ''}
        <span class="column-tools">${tools}</span>
      </header>
      ${body}`;

    const record = {
      descriptor,
      embedded,
      el,
      body: el.querySelector('.column-body'),
      status: el.querySelector('.column-status'),
      // Embedded columns render inside the iframe; the answer node stays
      // detached so history capture/paint code paths keep working unchanged.
      answer: el.querySelector('.answer') || document.createElement('div'),
      placeholder: el.querySelector('.column-placeholder'),
      iframe: el.querySelector('.column-embed'),
      wrap: el.querySelector('.column-embed-wrap'),
      snapshot: el.querySelector('.column-snapshot'),
      snapshotBar: el.querySelector('.snapshot-bar'),
      snapshotList: el.querySelector('.snapshot-list'),
      notice: el.querySelector('.column-embed-notice'),
      view: 'live',
      rawText: '',
      streaming: false,
      hasError: false,
      errorEl: null,
      mountedSrc: '',
      identityTimers: [],
      paint: throttle(() => this.#paint(descriptor.key), 70),
    };
    this.columns.set(descriptor.key, record);
    return record;
  }

  /** Stop the handshake timers of a column that is going away. */
  #dispose(record) {
    for (const timer of record.identityTimers) clearTimeout(timer);
    record.identityTimers = [];
  }

  /** Refresh just the header text of an existing column (no body touch). */
  #updateHead(record, descriptor) {
    record.descriptor = descriptor;
    const nameEl = record.el.querySelector('.column-name');
    const subEl = record.el.querySelector('.column-model');
    const dotEl = record.el.querySelector('.column-dot');
    if (nameEl && nameEl.textContent !== descriptor.name) nameEl.textContent = descriptor.name;
    const subtitle = descriptor.subtitle || '';
    if (subEl && subEl.textContent !== subtitle) subEl.textContent = subtitle;
    if (dotEl && descriptor.color) dotEl.style.setProperty('--dot', descriptor.color);
  }

  /**
   * Show a different conversation.
   *
   * Same rules as `sync`, except that the content of every surviving column is
   * cleared first. Columns are **reused** instead of recreated, so switching
   * conversations does not reload an embedded provider page — recreating an
   * <iframe> navigates it, which is why every “New chat” popped a cookie banner
   * on DeepSeek.
   */
  render(descriptors) {
    return this.#reconcile(descriptors, { reset: true });
  }

  /**
   * Reconcile the board with a descriptor list *in place*.
   *
   * Columns whose model disappeared are removed, columns for new models are
   * appended, and every surviving column is left completely untouched — its
   * rendered answer, its scroll position and any in-flight streaming survive.
   * This is what a model-list edit uses, so removing a model never re-renders
   * the rest of the chat.
   *
   * @param {ColumnDescriptor[]} descriptors
   * @returns {Set<string>} keys of the columns that were just created
   */
  sync(descriptors) {
    return this.#reconcile(descriptors, { reset: false });
  }

  #reconcile(descriptors, { reset }) {
    const wanted = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));

    for (const [key, record] of [...this.columns]) {
      const next = wanted.get(key);
      // Gone, or the connection mode changed (iframe <-> answer pane) ⇒ rebuild it.
      if (next && record.descriptor.mode === next.mode) continue;
      this.#dispose(record);
      record.el.remove();
      this.columns.delete(key);
    }

    const created = new Set();
    let previous = null;
    for (const descriptor of descriptors) {
      let record = this.columns.get(descriptor.key);
      if (!record) {
        record = this.#create(descriptor);
        created.add(descriptor.key);
      } else {
        this.#updateHead(record, descriptor);
        if (reset) {
          this.clearAnswer(descriptor.key);
          this.setEmbedNotice(descriptor.key, '');
        }
      }
      // Keep DOM order in sync with the descriptor order.
      const target = previous ? previous.nextSibling : this.root.firstChild;
      if (record.el !== target) this.root.insertBefore(record.el, target);
      previous = record.el;
    }

    this.descriptors = descriptors;
    this.emptyEl.hidden = descriptors.length > 0;
    const hadFocus = this.focusedKey;
    this.#applyFocus();
    if (hadFocus && !this.focusedKey) this.onFocusChange?.(null);
    return created;
  }

  /* ───────────────────────────── focus mode ───────────────────────────── */

  /**
   * Show one column across the whole board (“Full” in its header).
   *
   * A view change only: the other columns are hidden with `display: none`, which keeps
   * their documents — and any embedded provider page — alive. Nothing is reloaded when
   * you go full width or come back.
   */
  setFocus(key) {
    this.focusedKey = key && this.columns.has(key) ? key : '';
    this.#applyFocus();
    this.onFocusChange?.(this.focusedKey || null);
  }

  toggleFocus(key) {
    this.setFocus(this.focusedKey === key ? '' : key);
  }

  #applyFocus() {
    const focused = this.focusedKey && this.columns.has(this.focusedKey) ? this.focusedKey : '';
    this.focusedKey = focused;
    this.root.classList.toggle('is-focus', Boolean(focused));
    for (const [key, rec] of this.columns) {
      const on = key === focused;
      if (on) rec.el.dataset.focus = '1';
      else delete rec.el.dataset.focus;
      const btn = rec.el.querySelector('[data-act="focus"]');
      if (!btn) continue;
      btn.textContent = on ? 'Return' : 'Full';
      btn.title = on ? 'Back to all models' : 'Show this model full width';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /**
   * “New chat” without reloading anything.
   *
   * What this window shows is emptied; the provider pages inside the columns stay
   * exactly where they are — no navigation, no cookie banners, no lost scroll. A
   * column that was showing a saved transcript goes back to its live page (which
   * is only mounted if it never was).
   */
  resetForNewChat() {
    for (const [key, record] of this.columns) {
      this.clearAnswer(key);
      this.setEmbedNotice(key, '');
      if (!record.embedded) continue;
      if (record.view === 'snapshot') {
        record.view = 'live';
        if (record.snapshot) record.snapshot.hidden = true;
        if (record.wrap) record.wrap.hidden = false;
        this.onOpenLive?.(record.descriptor);
      }
      this.setStatus(key, 'idle', 'Ready for a new topic');
    }
  }

  /**
   * New chat: reload this panel at the provider's home URL.
   *
   * A reload is the only way to be certain a fresh conversation starts on every site
   * — providers disagree about their “New chat” control, and a SPA can keep its old
   * thread alive after a click that looks like it worked. The cost is one page load,
   * which is a fair price for an explicit “New chat” (and it happens once per click).
   */
  startFresh(key, homeUrl) {
    const rec = this.#get(key);
    if (!rec || !rec.embedded || !rec.iframe) return;
    rec.view = 'live';
    if (rec.snapshot) rec.snapshot.hidden = true;
    if (rec.wrap) rec.wrap.hidden = false;
    this.setEmbedNotice(key, '');
    this.setStatus(key, 'idle', 'Starting a new chat…');
    // Clearing mountedSrc is what makes mountEmbed navigate even to the same URL.
    rec.mountedSrc = '';
    rec.iframe.src = 'about:blank';
    setTimeout(() => this.mountEmbed(key, { src: homeUrl, modelId: key }), 60);
  }

  /* ─────────────────────────── embedded panels ─────────────────────────── */

  /**
   * Point an embedded column's iframe at the provider's chat and start the
   * identity handshake (the bridge in the frame needs to know which model it is
   * so the worker can target it). Idempotent: calling it again only re-posts the
   * identity unless the src actually changed.
   */
  mountEmbed(key, { src, modelId }) {
    const rec = this.#get(key);
    if (!rec || !rec.iframe) return;

    const frame = rec.iframe;
    const postIdentity = () => {
      try {
        frame.contentWindow?.postMessage({ type: 'MULTICHAI_IDENTITY', modelId }, '*');
      } catch {
        /* frame navigating */
      }
    };

    if (rec.mountedSrc !== src) {
      rec.mountedSrc = src;
      this.#dispose(rec);
      frame.addEventListener('load', postIdentity, { once: true });
      frame.src = src;
      // The bridge appears at document_idle; retry the handshake for a while.
      [300, 1200, 2500, 4500, 8000, 14000].forEach((delay) => {
        rec.identityTimers.push(setTimeout(postIdentity, delay));
      });
      this.setStatus(key, 'idle', 'Loading the chat…');
      this.setEmbedNotice(key, '');
    } else {
      postIdentity();
    }
  }

  /**
   * Point an embedded column at the provider's own URL for this conversation.
   *
   * Only ever called from an explicit click ("Open in ChatGPT" on a saved copy):
   * loading the provider's page restores everything it rendered — charts, tables,
   * artifacts — but it is a real page load, which can ask you to sign in again or
   * re-show a cookie banner. History itself never does this (see showSnapshot).
   */
  restoreThread(key, url) {
    const rec = this.#get(key);
    if (!rec || !rec.embedded || !url) return;
    rec.view = 'live';
    if (rec.snapshot) rec.snapshot.hidden = true;
    if (rec.wrap) rec.wrap.hidden = false;
    this.setEmbedNotice(key, '');
    rec.snapshotThreadUrl = url;
    // No navigation when the panel is already showing that conversation.
    this.mountEmbed(key, { src: url, modelId: key });
  }

  /** Load the provider's own page for the saved conversation (explicit click). */
  openThread(key) {
    const rec = this.#get(key);
    if (!rec || !rec.embedded) return;
    const url = rec.snapshotThreadUrl || '';
    if (!url) return;
    this.restoreThread(key, url);
  }

  /**
   * Show the saved answer of each turn in this conversation, without loading
   * anything: the provider page stays exactly as it is.
   *
   * `threadUrl` is the model's own link to that chat, when the bridge captured one.
   * It becomes an optional button (“Open in ChatGPT”), because loading it is a page
   * load — worth it for charts and artifacts, not worth forcing on every history
   * click.
   *
   * @param {string} key
   * @param {Array<{prompt: string, answers: Record<string, any>}>} turns
   * @param {string} [threadUrl]
   */
  showSnapshot(key, turns, threadUrl = '') {
    const rec = this.#get(key);
    if (!rec || !rec.embedded || !rec.snapshot) return;

    rec.snapshotList.textContent = '';
    const rows = turns || [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'snapshot-none';
      empty.textContent = 'Nothing saved in this conversation yet.';
      rec.snapshotList.appendChild(empty);
    }
    for (const turn of rows) {
      const block = document.createElement('div');
      block.className = 'snapshot-turn';

      const question = document.createElement('p');
      question.className = 'snapshot-q';
      question.textContent = turn.prompt || '';
      block.appendChild(question);

      const answer = turn.answers ? turn.answers[key] : null;
      block.appendChild(this.#savedAnswer(answer));
      rec.snapshotList.appendChild(block);
    }
    /*
     * What kind of copy is this? A turn recorded with the answer's rendered HTML is
     * replayed as the model produced it; one recorded before that capture existed
     * only has text. Saying which is which prevents “history lost my tables” guesses.
     */
    const rendered = rows.some((turn) => {
      const answer = turn.answers ? turn.answers[key] : null;
      return Boolean(answer && answer.html);
    });

    rec.snapshotThreadUrl = threadUrl;
    rec.snapshotBar.innerHTML =
      `<span class="snapshot-label">${
        rendered ? 'Saved copy · as the model rendered it' : 'Saved copy · text only'
      }</span>` +
      (threadUrl
        ? `<button class="btn btn-sm" type="button" data-act="open-thread"
                   title="Load this model's own page for the conversation. It re-renders charts and artifacts, but it is a page load, so the site may ask you to sign in again.">
             Open in ${escapeHtml(rec.descriptor.name)}
           </button>`
        : '') +
      '<button class="btn btn-sm" type="button" data-act="open-live">Show live panel</button>';

    rec.view = 'snapshot';
    rec.wrap.hidden = true;
    rec.snapshot.hidden = false;
    this.setStatus(key, 'idle', rendered ? 'Saved copy · rendered' : 'Saved copy · text only');
    this.setEmbedNotice(key, '');
  }

  /**
   * One saved answer.
   *
   * Captured HTML is replayed in a sandboxed frame, so tables, code blocks, diagrams
   * and chart images come back exactly as the model rendered them — without loading
   * the provider's page (which is what used to ask for a login again and re-show
   * cookie banners). Conversations recorded before that capture existed fall back to
   * the markdown text, which is all there is for them.
   */
  #savedAnswer(answer) {
    const html = (answer && answer.html) || '';
    if (html) {
      const frame = document.createElement('iframe');
      frame.className = 'snapshot-rich';
      /*
       * `allow-same-origin` without `allow-scripts`: the frame keeps a normal
       * origin so the parent can measure it (`contentDocument`), but no script from
       * the captured markup can run — and the extension page's CSP blocks inline
       * scripts in srcdoc anyway. It cannot submit forms, open windows or navigate
       * this page.
       */
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', 'Saved answer');
      frame.srcdoc = buildSnapshotDocument(html, {
        dark: document.documentElement.dataset.theme !== 'light',
      });
      frame.addEventListener('load', () => this.#measure(frame));
      // The frame is created before its column is shown, and images arrive later:
      // measure again once it is visible and after things settle.
      for (const delay of [0, 400, 1200, 2500]) {
        setTimeout(() => this.#measure(frame), delay);
      }
      return frame;
    }

    const box = document.createElement('div');
    box.className = 'snapshot-a answer';
    const text = (answer && answer.text) || '';
    if (text) {
      box.innerHTML = renderMarkdown(text);
      return box;
    }

    // Nothing was captured for this turn. Say why it is empty instead of implying the
    // model never answered.
    const why = (answer && answer.note) || (answer ? 'No answer was captured for this turn.' : 'No saved answer for this model.');
    box.innerHTML = `<p class="snapshot-none">${escapeHtml(why)} Use “Show live panel”, or reopen the conversation from its own link.</p>`;
    return box;
  }

  /** Fit a saved-answer frame to its own content. */
  #measure(frame) {
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      const height = Math.max(
        doc.body ? doc.body.scrollHeight : 0,
        doc.documentElement ? doc.documentElement.scrollHeight : 0,
      );
      if (!height) return;
      frame.style.height = `${Math.min(Math.max(48, Math.round(height)), 6000)}px`;
    } catch {
      /* frame not readable (should not happen with allow-same-origin) */
    }
  }

  /** Does this embedded column already have a provider page mounted? */
  hasMount(key) {
    const rec = this.#get(key);
    return Boolean(rec && rec.embedded && rec.mountedSrc);
  }

  /** Switch an embedded column back to the live provider page. */
  openLive(key) {
    const rec = this.#get(key);
    if (!rec || !rec.embedded) return;
    rec.view = 'live';
    if (rec.snapshot) rec.snapshot.hidden = true;
    if (rec.wrap) rec.wrap.hidden = false;
    this.setStatus(key, 'idle', 'Loading the chat…');
    this.onOpenLive?.(rec.descriptor);
  }

  /** Is this embedded column currently showing a saved transcript? */
  isSnapshot(key) {
    const rec = this.#get(key);
    return Boolean(rec && rec.embedded && rec.view === 'snapshot');
  }
  /** Hard-reload an embedded panel (used by the ⟳ button and New chat). */
  reload(key) {
    const rec = this.#get(key);
    if (!rec || !rec.iframe || !rec.mountedSrc) return;
    const src = rec.mountedSrc;
    this.setStatus(key, 'idle', 'Reloading…');
    this.setEmbedNotice(key, '');
    // Clearing mountedSrc is what makes mountEmbed navigate again: with the same
    // src it only re-posts the identity handshake.
    rec.mountedSrc = '';
    rec.iframe.src = 'about:blank';
    setTimeout(() => this.mountEmbed(key, { src, modelId: rec.descriptor.key }), 60);
  }

  /**
   * Message overlaid at the bottom of an embedded panel.
   * @param {string} text empty hides the overlay
   * @param {boolean} showActions adds “Reload” and “Use a tab” buttons
   */
  setEmbedNotice(key, text, showActions = false) {
    const rec = this.#get(key);
    if (!rec || !rec.notice) return;
    if (!text) {
      rec.notice.hidden = true;
      rec.notice.innerHTML = '';
      return;
    }
    rec.notice.hidden = false;
    rec.notice.innerHTML =
      `<span class="embed-notice-text">${escapeHtml(text)}</span>` +
      (showActions
        ? `<span class="embed-notice-actions">
             <button class="btn btn-sm" type="button" data-act="reload-embed">Reload</button>
             <button class="btn btn-sm" type="button" data-act="switch-tab">Use a tab instead</button>
           </span>`
        : '');
  }

  #get(key) {
    return this.columns.get(key) || null;
  }

  #paint(key) {
    const rec = this.#get(key);
    if (!rec || rec.embedded) return; // embedded columns render inside their iframe
    const nearBottom =
      rec.body.scrollHeight - rec.body.scrollTop - rec.body.clientHeight < 90;
    rec.answer.innerHTML = renderMarkdown(rec.rawText);
    if (rec.streaming) {
      const caret = document.createElement('span');
      caret.className = 'caret';
      rec.answer.appendChild(caret);
    }
    rec.placeholder.hidden = Boolean(rec.rawText) || rec.hasError;
    if (nearBottom) rec.body.scrollTop = rec.body.scrollHeight;
  }

  /** @param {string} key @param {{state: string, text?: string}} status */
  setStatus(key, state, text) {
    const rec = this.#get(key);
    if (!rec) return;
    rec.status.dataset.state = state;
    const label = text || STATUS_TEXT[state] || state;
    rec.status.innerHTML =
      (state === 'pending' || state === 'streaming' ? '<span class="spinner"></span>' : '') +
      `<span>${escapeHtml(label)}</span>`;
    rec.status.hidden = false;
  }

  /** Mark every column as waiting (used right after Send). */
  markPending(keys) {
    for (const key of keys) this.setStatus(key, 'pending', 'Sending…');
  }

  /** Replace the answer text (full text so far). */
  setText(key, text, streaming = false) {
    const rec = this.#get(key);
    if (!rec) return;
    rec.rawText = String(text ?? '');
    rec.streaming = streaming;
    rec.hasError = false;
    rec.errorEl?.remove();
    rec.errorEl = null;
    rec.paint();
  }

  /** Append a delta chunk. */
  appendText(key, chunk) {
    const rec = this.#get(key);
    if (!rec) return;
    rec.rawText += String(chunk ?? '');
    rec.streaming = true;
    rec.paint();
  }

  /** Finish a column successfully. */
  finish(key, text, ms) {
    const rec = this.#get(key);
    if (!rec) return;
    if (typeof text === 'string' && text.length) rec.rawText = text;
    rec.streaming = false;
    rec.paint();
    const duration = Number.isFinite(ms) ? ` · ${formatDuration(ms)}` : '';
    this.setStatus(key, 'done', `Done${duration}`);
  }

  /** Show an error inside a column (keeping any partial text). */
  fail(key, message, hint) {
    const rec = this.#get(key);
    if (!rec) return;
    rec.streaming = false;
    rec.hasError = true;
    if (rec.embedded) {
      this.setStatus(key, 'error', 'Failed');
      this.setEmbedNotice(key, [message, hint].filter(Boolean).join(' '));
      return;
    }
    rec.paint();
    if (!rec.errorEl) {
      rec.errorEl = document.createElement('div');
      rec.errorEl.className = 'column-error';
      rec.answer.appendChild(rec.errorEl);
    }
    /*
     * A column whose model drives a tab fails here whenever no such tab is open.
     * That is fixable in one click — open the tab, or go back to the embedded
     * panel — so the error carries the buttons instead of only prose.
     */
    const tabModeActions =
      rec.descriptor.mode === 'web'
        ? `<span class="column-error-actions">
             <button class="btn btn-sm" type="button" data-act="open-tab">Open a ${escapeHtml(
               rec.descriptor.name,
             )} tab</button>
             <button class="btn btn-sm" type="button" data-act="switch-embed">Use the embedded panel</button>
           </span>`
        : '';
    rec.errorEl.innerHTML =
      escapeHtml(message || 'Something went wrong.') +
      (hint ? `<span class="column-error-hint">${escapeHtml(hint)}</span>` : '') +
      tabModeActions;
    rec.placeholder.hidden = true;
    this.setStatus(key, rec.rawText ? 'done' : 'error', rec.rawText ? 'Partial answer' : 'Failed');
    if (!rec.rawText) {
      rec.status.dataset.state = 'error';
      rec.status.innerHTML = `<span>${escapeHtml(hint || 'Failed')}</span>`;
    }
  }

  /** Mark a column as "ready, no answer yet". */
  clearAnswer(key) {
    const rec = this.#get(key);
    if (!rec) return;
    rec.rawText = '';
    rec.streaming = false;
    rec.hasError = false;
    rec.errorEl?.remove();
    rec.errorEl = null;
    rec.answer.innerHTML = '';
    // Embedded columns render the provider page, not an answer pane: they have no
    // placeholder element, so this must stay optional.
    if (rec.placeholder) {
      rec.placeholder.hidden = false;
      rec.placeholder.textContent = 'Waiting for your prompt…';
    }
    this.setStatus(key, 'idle');
  }

  clearAll() {
    for (const key of this.columns.keys()) this.clearAnswer(key);
  }

  /**
   * Restore one conversation turn onto the board.
   * @param {any} turn
   * @param {Set<string>|null} onlyKeys paint just these columns (used by sync,
   *   so columns that are already displaying something are not repainted)
   */
  showTurn(turn, onlyKeys = null) {
    if (!turn) return;
    for (const [key, answer] of Object.entries(turn.answers || {})) {
      if (onlyKeys && !onlyKeys.has(key)) continue;
      if (!this.#get(key)) continue;
      const text = answer.text || '';

      if (text) this.finish(key, text, answer.ms);

      if (answer.status === 'error' && answer.error) {
        this.fail(key, answer.error, null);
      } else if (answer.status === 'stopped') {
        // A stopped turn must not read as "Done" after a re-render.
        this.setStatus(key, 'aborted', text ? 'Stopped' : 'Stopped · no answer');
      } else if (answer.status === 'timeout') {
        this.setStatus(key, 'timeout', text ? 'Partial answer' : 'No answer captured');
      } else if (!text) {
        // A turn whose answer stayed inside the provider panel has a note but no
        // captured text; it is still a finished turn, not an empty one.
        this.setStatus(
          key,
          answer.note ? 'done' : 'idle',
          answer.note ||
            (answer.status === 'pending' ? STATUS_TEXT.pending : 'No answer in this turn'),
        );
      }
    }
  }

  /** Colour/subtitle helper: what to show under the model name. */
  static describe(model, provider) {
    const subtitle =
      model.mode === 'api'
        ? model.modelName || (provider && provider.api ? provider.api.defaultModel : '')
        : model.mode === 'embed'
          ? 'embedded web chat'
          : 'existing tab';
    return {
      key: model.id,
      name: model.label || (provider ? provider.label : model.providerId),
      subtitle,
      color: (provider && provider.color) || '#8b93a7',
      providerId: model.providerId,
      mode: model.mode,
    };
  }
}
