/**
 * MultiChatAI — provider catalog.
 *
 * Shared by the extension page (ES module) and the service worker (ES module).
 *
 * A provider entry answers two independent questions:
 *
 *   `web`  — can we drive the provider's own web app, using the browser
 *            session the user already signed in with? (`browser session` mode)
 *   `api`  — can we call the provider's HTTP API with an API key?
 *            (`API key` mode)
 *
 * Either may be `null` when unsupported. Adding a provider is data-only:
 * a new API *dialect* would need code in src/background/api.js, but new
 * providers using an existing dialect need nothing but an entry here.
 */

/**
 * Connection modes for a model.
 *
 *   embed — the provider's own chat page is framed inside the column (free web
 *           chat, no API key). Requires the extension to strip the provider's
 *           framing headers for its own frames only (see background/embed-rules.js).
 *   api   — direct HTTP calls from the service worker (no page at all).
 *   web   — drives a provider tab the user already has open.
 */
export const MODE_EMBED = 'embed';
export const MODE_WEB = 'web';
export const MODE_API = 'api';

/**
 * @typedef {Object} ProviderApi
 * @property {'openai'|'anthropic'|'gemini'} kind   API dialect
 * @property {string} baseUrl                       base URL, no trailing slash
 * @property {string} defaultModel                  pre-filled model name
 * @property {string[]} modelSuggestions            datalist suggestions
 * @property {string} keyUrl                        where a user creates a key
 * @property {string} [keyHint]                     placeholder for the key field
 * @property {boolean} vision                       accepts image inputs
 * @property {string[]} [headers]                   extra static headers
 */

/**
 * @typedef {Object} ProviderWeb
 * @property {string[]} hosts        hostnames the content-script bridge runs on
 * @property {string[]} urlPatterns  chrome.tabs.query() match patterns
 * @property {RegExp} thread         matches the provider's own per-conversation URL
 * @property {boolean} files         the site accepts file attachments
 * @property {boolean} [signInInFrame] false when sign-in cannot complete inside a frame
 *                                    (Google properties answer 403 to framed OAuth)
 */

/**
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} label
 * @property {string} vendor
 * @property {string} color
 * @property {string} homeUrl
 * @property {ProviderWeb|null} web
 * @property {ProviderApi|null} api
 */

/** @type {Record<string, Provider>} */
export const PROVIDERS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    vendor: 'OpenAI',
    color: '#10a37f',
    homeUrl: 'https://chatgpt.com/',
    web: {
      hosts: ['chatgpt.com', 'chat.openai.com'],
      urlPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      thread: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/(g\/[^/]+\/)?c\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
      keyUrl: 'https://platform.openai.com/api-keys',
      keyHint: 'sk-...',
      vision: true,
    },
  },

  claude: {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    color: '#d97757',
    homeUrl: 'https://claude.ai/',
    web: {
      hosts: ['claude.ai'],
      urlPatterns: ['https://claude.ai/*'],
      thread: /^https:\/\/claude\.ai\/chat\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-4-5',
      modelSuggestions: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
      keyUrl: 'https://console.anthropic.com/settings/keys',
      keyHint: 'sk-ant-...',
      vision: true,
      // Required for calling the Messages API from a browser/extension context.
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    },
  },

  gemini: {
    id: 'gemini',
    label: 'Gemini',
    vendor: 'Google',
    color: '#4285f4',
    homeUrl: 'https://gemini.google.com/app',
    web: {
      hosts: ['gemini.google.com'],
      urlPatterns: ['https://gemini.google.com/*'],
      thread: /^https:\/\/gemini\.google\.com\/app\/[A-Za-z0-9]+$/,
      files: true,
      // Google refuses OAuth inside a frame (403), so this one must be signed in
      // in a real tab; the column then uses that session.
      signInInFrame: false,
    },
    api: {
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      defaultModel: 'gemini-2.5-flash',
      modelSuggestions: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'],
      keyUrl: 'https://aistudio.google.com/app/apikey',
      keyHint: 'AIza...',
      vision: true,
    },
  },

  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: 'DeepSeek',
    color: '#4d6bfe',
    homeUrl: 'https://chat.deepseek.com/',
    web: {
      hosts: ['chat.deepseek.com'],
      urlPatterns: ['https://chat.deepseek.com/*'],
      thread: /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      modelSuggestions: ['deepseek-chat', 'deepseek-reasoner'],
      keyUrl: 'https://platform.deepseek.com/api_keys',
      keyHint: 'sk-...',
      vision: false,
    },
  },

  grok: {
    id: 'grok',
    label: 'Grok',
    vendor: 'xAI',
    color: '#8b5cf6',
    homeUrl: 'https://grok.com/',
    web: {
      hosts: ['grok.com'],
      urlPatterns: ['https://grok.com/*'],
      thread: /^https:\/\/grok\.com\/(c|chat)\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'openai',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4-fast',
      modelSuggestions: ['grok-4-fast', 'grok-4', 'grok-3', 'grok-3-mini'],
      keyUrl: 'https://console.x.ai/',
      keyHint: 'xai-...',
      vision: true,
    },
  },

  copilot: {
    id: 'copilot',
    label: 'Copilot',
    vendor: 'Microsoft',
    color: '#0a7cff',
    homeUrl: 'https://copilot.microsoft.com/',
    web: {
      // copilot.microsoft.com redirects the framed page to copilot.com, so both
      // hosts need the framing rules and the bridge — otherwise the frame dies on
      // copilot.com's own "frame-ancestors 'self'" ("refused to connect").
      hosts: ['copilot.microsoft.com', 'copilot.com', 'www.copilot.com'],
      urlPatterns: ['https://copilot.microsoft.com/*', 'https://copilot.com/*', 'https://www.copilot.com/*'],
      thread: /^https:\/\/(copilot\.microsoft\.com|(www\.)?copilot\.com)\/(chats|chat)\/[A-Za-z0-9-]+$/,
      files: false,
    },
    api: null,
  },

  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    vendor: 'Perplexity',
    color: '#20b8cd',
    homeUrl: 'https://www.perplexity.ai/',
    web: {
      hosts: ['www.perplexity.ai'],
      urlPatterns: ['https://www.perplexity.ai/*'],
      thread: /^https:\/\/www\.perplexity\.ai\/search\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'openai',
      baseUrl: 'https://api.perplexity.ai',
      defaultModel: 'sonar',
      modelSuggestions: ['sonar', 'sonar-pro', 'sonar-reasoning'],
      keyUrl: 'https://www.perplexity.ai/settings/api',
      keyHint: 'pplx-...',
      vision: false,
    },
  },

  qwen: {
    id: 'qwen',
    label: 'Qwen',
    vendor: 'Alibaba',
    color: '#615ced',
    homeUrl: 'https://chat.qwen.ai/',
    web: {
      hosts: ['chat.qwen.ai'],
      urlPatterns: ['https://chat.qwen.ai/*'],
      thread: /^https:\/\/chat\.qwen\.ai\/(c|chat)\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      modelSuggestions: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-plus'],
      keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
      keyHint: 'sk-...',
      vision: true,
    },
  },

  kimi: {
    id: 'kimi',
    label: 'Kimi',
    vendor: 'Moonshot',
    color: '#1a1a1a',
    homeUrl: 'https://www.kimi.com/',
    web: {
      hosts: ['www.kimi.com', 'kimi.moonshot.cn'],
      urlPatterns: ['https://www.kimi.com/*', 'https://kimi.moonshot.cn/*'],
      thread: /^https:\/\/(www\.kimi\.com|kimi\.moonshot\.cn)\/chat\/[A-Za-z0-9-]+$/,
      files: true,
    },
    api: {
      kind: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: 'moonshot-v1-8k',
      modelSuggestions: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-latest'],
      keyUrl: 'https://platform.moonshot.cn/console/api-keys',
      keyHint: 'sk-...',
      vision: false,
    },
  },

  mistral: {
    id: 'mistral',
    label: 'Mistral',
    vendor: 'Mistral AI',
    color: '#ff7000',
    homeUrl: 'https://chat.mistral.ai/',
    web: null,
    api: {
      kind: 'openai',
      baseUrl: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-large-latest',
      modelSuggestions: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
      keyUrl: 'https://console.mistral.ai/api-keys/',
      keyHint: '...',
      vision: true,
    },
  },

  ollama: {
    id: 'ollama',
    label: 'Ollama',
    vendor: 'Local',
    color: '#7c8b98',
    homeUrl: 'http://localhost:11434/',
    web: null,
    api: {
      kind: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      defaultModel: 'llama3.2',
      modelSuggestions: ['llama3.2', 'qwen2.5', 'mistral', 'phi4', 'gemma3'],
      keyUrl: 'https://ollama.com/download',
      keyHint: 'not required for localhost',
      vision: false,
      // A local Ollama server needs no authentication.
      keyOptional: true,
    },
  },
};

/** Order used in the "Add model" dropdown: the five majors first. */
export const PROVIDER_ORDER = [
  'chatgpt',
  'gemini',
  'claude',
  'deepseek',
  'grok',
  'copilot',
  'perplexity',
  'qwen',
  'kimi',
  'mistral',
  'ollama',
];

/** @returns {Provider|null} */
export function getProvider(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id] : null;
}

/** @returns {Provider[]} */
export function listProviders() {
  return PROVIDER_ORDER.map((id) => PROVIDERS[id]).filter(Boolean);
}

/** Providers that support at least one usable mode, most autonomous first. */
export function availableModes(provider) {
  const modes = [];
  if (provider.web) modes.push(MODE_EMBED);
  if (provider.api) modes.push(MODE_API);
  if (provider.web) modes.push(MODE_WEB);
  return modes;
}

/**
 * Resolve a hostname (e.g. "chat.openai.com") to its provider.
 * @returns {{provider: Provider, web: ProviderWeb}|null}
 */
export function providerForHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  for (const provider of listProviders()) {
    if (!provider.web) continue;
    if (provider.web.hosts.some((h) => host === h || host.endsWith('.' + h))) {
      return { provider, web: provider.web };
    }
  }
  return null;
}

/**
 * Resolve a full URL to its provider.
 * @returns {Provider|null}
 */
export function providerForUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hit = providerForHost(parsed.hostname);
  return hit ? hit.provider : null;
}

/**
 * Human label for a stored model entry, e.g. "ChatGPT · gpt-4o-mini" or "Claude".
 * @param {{providerId: string, modelName?: string, mode?: string, label?: string}} model
 */
export function modelDisplayName(model) {
  const provider = getProvider(model.providerId);
  const base = model.label || (provider ? provider.label : model.providerId || 'Unknown model');
  if (model.mode === MODE_API && model.modelName) return `${base} · ${model.modelName}`;
  return base;
}

/** Colour for a model entry (provider colour, so columns are recognisable). */
export function modelColor(model) {
  const provider = getProvider(model.providerId);
  return (provider && provider.color) || '#8b93a7';
}

/**
 * The provider's own URL for one conversation, if `url` points at one.
 *
 * Every provider gives each chat its own reloadable URL (`chatgpt.com/c/<id>`,
 * `claude.ai/chat/<id>`, …). Storing that URL lets a column reopen the *real*
 * conversation — charts, tables, artifacts and all — instead of replaying our
 * plain-text copy of the answer.
 *
 * Query strings and trailing slashes are dropped, so a reload of the same chat is
 * recognised as the same chat.
 *
 * @param {string|Provider|null} providerOrId
 * @param {string} url
 * @returns {string} canonical thread URL, or '' when this is not a conversation URL
 */
export function threadUrlFor(providerOrId, url) {
  const provider = typeof providerOrId === 'string' ? getProvider(providerOrId) : providerOrId;
  if (!provider || !provider.web || !provider.web.thread) return '';

  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';

  const canonical = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  return provider.web.thread.test(canonical) ? canonical : '';
}

export const DEFAULT_SETTINGS = {
  /** @type {Array} model entries shown as columns */
  models: [],
  theme: 'dark',
  /** Per-run timeout in seconds for browser-session mode. */
  timeoutSec: 180,
  /**
   * “New chat” also starts a fresh chat inside every model panel, by pressing the
   * site's own “New chat” control (no page reload). This is what the window is for:
   * a new topic that starts clean everywhere.
   */
  resetProviderChatsOnNewChat: true,
  /** Keep at most this many conversations in storage (oldest pruned). */
  historyLimit: 100,
  /**
   * Which model writes the summary (a model id). Empty means “the first column”,
   * so a fresh profile needs no choice at all.
   */
  summarizerModelId: '',
  /** Stamped on save, so behaviour changes can migrate a profile exactly once. */
  settingsVersion: 2,
};
