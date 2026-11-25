/**
 * Settings — rendered *inside the left sidebar* (no modal).
 *
 * Opening Settings swaps the sidebar's chat view for this panel and widens the
 * sidebar so the model cards stay readable; the back arrow returns to the chat
 * list. Sections, in order: Models (default), General, About.
 *
 * The view never imports the store; it calls the `actions` supplied by app.js.
 */

import {
  MODE_API,
  MODE_EMBED,
  MODE_WEB,
  PROVIDER_ORDER,
  availableModes,
  getProvider,
} from '../../shared/providers.js';
import { escapeHtml, toast } from '../util.js';

const SECTIONS = [
  { id: 'models', label: 'Models' },
  { id: 'general', label: 'General' },
  { id: 'about', label: 'About' },
];

const MAJOR = ['chatgpt', 'gemini', 'claude', 'deepseek', 'grok'];

export class SettingsView {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.appRoot        .app (toggles the wide-sidebar class)
   * @param {HTMLElement} options.viewChat       sidebar chat view
   * @param {HTMLElement} options.viewSettings   sidebar settings view
   * @param {HTMLElement} options.navEl          tab strip
   * @param {HTMLElement} options.bodyEl         scrollable panel body
   * @param {HTMLElement} options.backBtn        "back to chats"
   * @param {Object} options.actions
   */
  constructor({ appRoot, viewChat, viewSettings, navEl, bodyEl, backBtn, actions }) {
    this.appRoot = appRoot;
    this.viewChat = viewChat;
    this.viewSettings = viewSettings;
    this.navEl = navEl;
    this.bodyEl = bodyEl;
    this.backBtn = backBtn;
    this.actions = actions;
    this.section = 'models';
    this.addProvider = 'chatgpt';

    backBtn.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close();
    });

    navEl.addEventListener('click', (event) => {
      const btn = /** @type {HTMLElement} */ (event.target).closest('[data-section]');
      if (btn) this.show(btn.getAttribute('data-section'));
    });

    bodyEl.addEventListener('click', (event) => this.#onClick(event));
    bodyEl.addEventListener('change', (event) => this.#onChange(event));
  }

  get isOpen() {
    return !this.viewSettings.hidden;
  }

  /** Show the panel (default section: Models). */
  open(section = 'models') {
    this.viewChat.hidden = true;
    this.viewSettings.hidden = false;
    this.appRoot.classList.add('is-settings');
    this.show(section);
  }

  /** Back to the chat list. */
  close() {
    this.viewSettings.hidden = true;
    this.viewChat.hidden = false;
    this.appRoot.classList.remove('is-settings');
  }

  show(section) {
    this.section = SECTIONS.some((entry) => entry.id === section) ? section : 'models';
    this.#renderNav();
    this.#renderBody();
  }

  /** Re-render the open panel (called after external changes). */
  refresh() {
    if (this.isOpen) this.#renderBody();
  }

  /* ───────────────────────────── rendering ───────────────────────────── */

  #renderNav() {
    this.navEl.innerHTML = SECTIONS.map(
      (section) =>
        `<button type="button" data-section="${section.id}" aria-current="${
          section.id === this.section ? 'true' : 'false'
        }">${escapeHtml(section.label)}</button>`,
    ).join('');
  }

  #renderBody() {
    if (this.section === 'models') this.#renderModels();
    else if (this.section === 'general') this.#renderGeneral();
    else this.#renderAbout();
  }

  #renderModels() {
    const models = this.actions.getModels();
    const providers = PROVIDER_ORDER.map((id) => getProvider(id)).filter(Boolean);
    const option = (provider) =>
      `<option value="${provider.id}"${
        provider.id === this.addProvider ? ' selected' : ''
      }>${escapeHtml(provider.label)} — ${escapeHtml(provider.vendor)}</option>`;

    const majorOptions = providers.filter((provider) => MAJOR.includes(provider.id)).map(option).join('');
    const moreOptions = providers.filter((provider) => !MAJOR.includes(provider.id)).map(option).join('');

    this.bodyEl.innerHTML = `
      <section class="settings-section">
        <h3>Add a model</h3>
        <p class="section-desc">
          Pick a provider and how to reach it. The model appears as a column in the chat
          window right away — no tab is opened. <strong>API key</strong> models run entirely
          inside the extension; <strong>browser session</strong> models reuse a provider tab
          you already have open.
        </p>
        <div class="field-row">
          <div class="field">
            <label for="add-provider">Provider</label>
            <select id="add-provider" data-act="add-provider">
              <optgroup label="Major AI models">${majorOptions}</optgroup>
              <optgroup label="More providers">${moreOptions}</optgroup>
            </select>
          </div>
          <div class="field">
            <label for="add-mode">Connection</label>
            <select id="add-mode" data-act="add-mode">${this.#modeOptions(this.addProvider)}</select>
          </div>
          <button class="btn btn-accent" type="button" data-act="add-model">Add model</button>
        </div>
      </section>

      <section class="settings-section">
        <h3>Models <span class="status-pill">${models.length}</span></h3>
        <p class="section-desc">
          Every checked model gets an equal-width column. <strong>×</strong> removes a model and
          its column right away — its past answers stay in storage but are no longer shown.
          Unchecking a model hides its column the same way.
        </p>
        ${
          models.length
            ? `<ul class="model-list">${models.map((model) => this.#modelCard(model)).join('')}</ul>`
            : '<div class="settings-empty">No models yet. Add ChatGPT, Gemini, Claude, DeepSeek or Grok above.</div>'
        }
      </section>`;

    // Restore the status pill of each API model.
    for (const model of models) {
      if (model.mode !== MODE_API) continue;
      const provider = getProvider(model.providerId);
      if (provider && provider.api && provider.api.keyOptional) {
        this.#setPill(model.id, 'idle', 'Local server');
        continue;
      }
      const hasKey = Boolean(this.actions.getApiKey(model.id));
      this.#setPill(model.id, hasKey ? 'ok' : 'warn', hasKey ? 'Key saved' : 'No key yet');
    }
  }

  #modeOptions(providerId, selected = '') {
    const provider = getProvider(providerId);
    const modes = provider ? availableModes(provider) : [MODE_EMBED];
    const label = provider ? provider.label : 'provider';
    return modes
      .map((mode) => {
        const chosen = mode === selected ? ' selected' : '';
        if (mode === MODE_EMBED) {
          return `<option value="${MODE_EMBED}"${chosen}>Embedded web chat — free, inside the column</option>`;
        }
        if (mode === MODE_API) {
          return `<option value="${MODE_API}"${chosen}>API key — direct calls, no page</option>`;
        }
        return `<option value="${MODE_WEB}"${chosen}>Existing tab — reuse a ${escapeHtml(label)} tab you opened</option>`;
      })
      .join('');
  }

  #modelCard(model) {
    const provider = getProvider(model.providerId);
    if (!provider) return '';
    const isApi = model.mode === MODE_API;
    const isEmbed = model.mode === MODE_EMBED;
    const checked = model.enabled === false ? '' : 'checked';
    const keyOptional = Boolean(provider.api && provider.api.keyOptional);

    const embedControls = `<div class="model-row">
           <div class="model-actions">
             <button class="btn btn-sm" type="button" data-act="sign-in"
                     title="Opens ${escapeHtml(provider.homeUrl)} in a new tab — explicit click only">Open in tab</button>
           </div>
         </div>
         <p class="model-note">
           The provider's own <strong>free web chat</strong> runs inside this model's column —
           no API key, no cost. Sign in once inside the panel (or with “Open in tab”, then ⟳)
           and it is remembered. If the site refuses to be framed, switch this model to
           “Existing tab” or “API key”.
         </p>`;

    const controls = isApi
      ? `<div class="model-row">
           <div class="field">
             <label for="model-name-${model.id}">Model name</label>
             <input type="text" id="model-name-${model.id}" data-act="model-name"
                    value="${escapeHtml(model.modelName || provider.api.defaultModel)}"
                    list="dl-${model.id}" spellcheck="false" />
             <datalist id="dl-${model.id}">
               ${provider.api.modelSuggestions
                 .map((name) => `<option value="${escapeHtml(name)}"></option>`)
                 .join('')}
             </datalist>
           </div>
           <div class="field">
             <label for="key-${model.id}">API key</label>
             <input type="password" id="key-${model.id}" data-act="api-key"
                    placeholder="${escapeHtml(provider.api.keyHint || 'paste key')}"
                    autocomplete="off" spellcheck="false" />
           </div>
           <div class="model-actions">
             <button class="btn btn-sm" type="button" data-act="save-key">Save key</button>
             <button class="btn btn-sm" type="button" data-act="clear-key" title="Forget the stored key">Clear</button>
             <button class="btn btn-sm" type="button" data-act="test">Test</button>
           </div>
         </div>
         <p class="model-note">
           ${
             keyOptional
               ? 'No API key needed — make sure the local server is running, then press Test.'
               : `Keys are stored only in this browser profile (<code>chrome.storage.local</code>) and are sent straight from your machine to ${escapeHtml(provider.label)}.`
           }
           ${
             provider.api.keyUrl && !keyOptional
               ? `Create one at <a href="${escapeHtml(provider.api.keyUrl)}" target="_blank" rel="noreferrer noopener">${escapeHtml(provider.label)} console</a>.`
               : ''
           }
         </p>`
      : isEmbed
      ? embedControls
      : `<div class="model-row">
           <div class="model-actions">
             <button class="btn btn-sm" type="button" data-act="sign-in"
                     title="Opens ${escapeHtml(provider.homeUrl)} in a new tab — explicit click only">Open in tab</button>
             <button class="btn btn-sm" type="button" data-act="check">Check tab</button>
           </div>
         </div>
         <p class="model-note">
           Drives the ${escapeHtml(provider.label)} tab you already have open (your login,
           no password or key stored). MultiChatAI never opens tabs on Send. Prefer the
           in-column option? Switch this model to “Embedded”.
         </p>`;

    return `<li class="model-card${model.enabled === false ? ' is-off' : ''}" data-model-id="${model.id}">
        <div class="model-top">
          <input type="checkbox" class="model-enabled" data-act="enabled" ${checked}
                 title="Include this model in the chat" aria-label="Include this model in the chat" />
          <span class="model-swatch" style="--swatch:${escapeHtml(provider.color)}"></span>
          <span class="model-name">${escapeHtml(model.label || provider.label)}</span>
          <span class="mode-badge" data-mode="${isApi ? 'api' : isEmbed ? 'embed' : 'web'}">${
            isApi ? 'API' : isEmbed ? 'Embed' : 'Tab'
          }</span>
          <button class="model-remove" type="button" data-act="remove" title="Remove model" aria-label="Remove model">
            <svg class="ico" aria-hidden="true"><use href="#i-x" /></svg>
          </button>
        </div>
        <div class="model-status">
          <span class="status-pill" data-pill="${model.id}" data-state="idle">
            <span class="status-dot"></span>${
              isApi ? (keyOptional ? 'Local server' : 'No key yet') : isEmbed ? 'Embedded panel' : 'Status unknown'
            }
          </span>
        </div>
        <div class="model-row">
          <div class="field">
            <label for="mode-${model.id}">Connection</label>
            <select id="mode-${model.id}" data-act="model-mode" data-model="${model.id}">
              ${this.#modeOptions(model.providerId, model.mode)}
            </select>
          </div>
        </div>
        ${controls}
      </li>`;
  }

  #renderGeneral() {
    const settings = this.actions.getSettings();
    const conversations = this.actions.getTurnCount();
    this.bodyEl.innerHTML = `
      <section class="settings-section">
        <h3>Appearance</h3>
        <div class="field-row">
          <div class="field">
            <label for="theme-select">Theme</label>
            <select id="theme-select" data-act="theme">
              <option value="dark"${settings.theme === 'light' ? '' : ' selected'}>Dark</option>
              <option value="light"${settings.theme === 'light' ? ' selected' : ''}>Light</option>
            </select>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3>Behaviour</h3>
        <div class="toggle-row">
          <input type="checkbox" id="reset-provider" data-act="reset-provider"
                 ${settings.resetProviderChatsOnNewChat ? 'checked' : ''} />
          <div class="toggle-text">
            <strong>Reload each model panel on “New chat”</strong>
            <span>
              Presses each site's own “New chat” button — no page reload. Turn it off to keep
              the panels on their current conversation.
            </span>
          </div>
        </div>
        <div class="field-row" style="margin-top:10px">
          <div class="field">
            <label for="timeout">Browser-session timeout (seconds)</label>
            <input type="number" id="timeout" data-act="timeout" min="30" max="900" step="10"
                   value="${Number(settings.timeoutSec) || 180}" />
          </div>
          <div class="field">
            <label for="history-limit">Conversations to keep</label>
            <input type="number" id="history-limit" data-act="history-limit" min="10" max="1000" step="10"
                   value="${Number(settings.historyLimit) || 100}" />
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3>History</h3>
        <p class="section-desc">
          ${conversations} conversation${conversations === 1 ? '' : 's'} stored locally.
          Deleting is permanent.
        </p>
        <button class="btn" type="button" data-act="clear-history">Delete all conversations</button>
      </section>`;
  }

  #renderAbout() {
    const manifest = chrome.runtime.getManifest();
    this.bodyEl.innerHTML = `
      <section class="settings-section">
        <h3>MultiChatAI ${escapeHtml(manifest.version)}</h3>
        <p class="section-desc">
          Ask one question, read every model's answer side by side. Everything runs locally
          in your browser profile; there is no MultiChatAI server and no analytics.
        </p>
        <ul class="about-list">
          <li><strong>Browser session</strong> — MultiChatAI drives the provider's own web app
            in a background tab using the login you already have. No key needed, but it
            depends on that site's page structure, so a redesign can break one adapter until
            it is updated.</li>
          <li><strong>API key</strong> — direct calls to the official API. Exact, stable and
            able to stream token by token, but you pay the provider per token.</li>
          <li>Provider pages block being framed (<code>frame-ancestors</code>), so a column
            mirrors the answer text instead of embedding the site. Use the ↗ button in a
            column to jump to that model's tab.</li>
          <li>Keyboard: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> opens MultiChatAI,
            <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line,
            <kbd>Esc</kbd> leaves Settings.</li>
        </ul>
      </section>`;
  }

  /* ───────────────────────────── events ───────────────────────────── */

  #cardModelId(node) {
    const card = node.closest('.model-card');
    return card ? card.getAttribute('data-model-id') : null;
  }

  async #onClick(event) {
    const btn = /** @type {HTMLElement} */ (event.target).closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');

    if (act === 'add-model') {
      await this.actions.addModel(this.addProvider, this.#currentMode());
      this.#renderBody();
      return;
    }

    if (act === 'clear-history') {
      await this.actions.clearHistory();
      this.#renderBody();
      return;
    }

    const modelId = this.#cardModelId(btn);
    if (!modelId) return;
    const model = this.actions.getModels().find((entry) => entry.id === modelId);
    if (!model) return;

    if (act === 'remove') {
      await this.actions.removeModel(modelId);
      this.#renderBody();
      return;
    }

    if (act === 'save-key') {
      const input = /** @type {HTMLInputElement|null} */ (
        this.bodyEl.querySelector(`[data-act="api-key"][id="key-${modelId}"]`)
      );
      const value = input ? input.value.trim() : '';
      if (!value) {
        this.#setPill(modelId, 'warn', 'Enter a key first');
        return;
      }
      await this.actions.setApiKey(modelId, value);
      if (input) input.value = '';
      this.#setPill(modelId, 'ok', 'Key saved');
      return;
    }

    if (act === 'clear-key') {
      await this.actions.setApiKey(modelId, '');
      this.#setPill(modelId, 'warn', 'Key removed');
      return;
    }

    if (act === 'test') {
      btn.setAttribute('disabled', 'disabled');
      this.#setPill(modelId, 'idle', 'Testing…');
      const result = await this.actions.testApi(modelId);
      btn.removeAttribute('disabled');
      this.#setPill(modelId, result.ok ? 'ok' : 'error', result.message);
      return;
    }

    if (act === 'sign-in') {
      await this.actions.openProvider(model.providerId, { active: true });
      this.#setPill(modelId, 'idle', 'Tab opened — sign in there');
      return;
    }

    if (act === 'check') {
      this.#setPill(modelId, 'idle', 'Checking…');
      const result = await this.actions.checkProvider(model.providerId);
      this.#setPill(modelId, result.ok ? (result.signedIn ? 'ok' : 'warn') : 'error', result.message);
    }
  }

  #currentMode() {
    const select = /** @type {HTMLSelectElement|null} */ (
      this.bodyEl.querySelector('[data-act="add-mode"]')
    );
    return select ? select.value : MODE_WEB;
  }

  async #onChange(event) {
    const input = /** @type {HTMLElement} */ (event.target).closest('[data-act]');
    if (!input) return;
    const act = input.getAttribute('data-act');

    if (act === 'add-provider') {
      this.addProvider = /** @type {HTMLSelectElement} */ (input).value;
      const modeSelect = this.bodyEl.querySelector('[data-act="add-mode"]');
      if (modeSelect) modeSelect.innerHTML = this.#modeOptions(this.addProvider);
      return;
    }

    /*
     * Change how an existing model is reached. This used to be impossible: the
     * connection was fixed when the model was added, so a model stuck in “existing
     * tab” could only be fixed by deleting and re-adding it.
     */
    if (act === 'model-mode') {
      const modelId = input.getAttribute('data-model') || '';
      const mode = /** @type {HTMLSelectElement} */ (input).value;
      const model = this.actions.getModels().find((entry) => entry.id === modelId);
      if (!model || model.mode === mode) return;
      await this.actions.updateModel(modelId, { mode });
      const where =
        mode === MODE_EMBED
          ? 'inside its column'
          : mode === MODE_API
            ? 'through its API key, no page'
            : 'through a provider tab you keep open';
      toast(`${model.label || model.providerId}: now answered ${where}`, 'ok', 5000);
      // The card's badge and note depend on the mode: repaint this panel.
      this.show(this.section);
      return;
    }

    if (act === 'theme') {
      await this.actions.saveSettings({ theme: /** @type {HTMLSelectElement} */ (input).value });
      return;
    }

    if (act === 'timeout') {
      const value = Math.min(900, Math.max(30, Number(/** @type {HTMLInputElement} */ (input).value) || 180));
      await this.actions.saveSettings({ timeoutSec: value });
      return;
    }

    if (act === 'history-limit') {
      const value = Math.min(
        1000,
        Math.max(10, Number(/** @type {HTMLInputElement} */ (input).value) || 100),
      );
      await this.actions.saveSettings({ historyLimit: value });
      return;
    }

    if (act === 'reset-provider') {
      await this.actions.saveSettings({
        resetProviderChatsOnNewChat: /** @type {HTMLInputElement} */ (input).checked,
      });
      return;
    }

    const modelId = this.#cardModelId(input);
    if (!modelId) return;

    if (act === 'enabled') {
      const checked = /** @type {HTMLInputElement} */ (input).checked;
      await this.actions.updateModel(modelId, { enabled: checked });
      const card = input.closest('.model-card');
      if (card) card.classList.toggle('is-off', !checked);
      return;
    }

    if (act === 'model-name') {
      const value = /** @type {HTMLInputElement} */ (input).value.trim();
      if (value) await this.actions.updateModel(modelId, { modelName: value });
    }
  }

  #setPill(modelId, state, text) {
    const pill = this.bodyEl.querySelector(`[data-pill="${modelId}"]`);
    if (!pill) return;
    pill.dataset.state = state;
    pill.innerHTML = `<span class="status-dot"></span>${escapeHtml(text)}`;
  }
}
