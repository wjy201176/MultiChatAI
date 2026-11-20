/**
 * Site adapters for browser-session mode.
 *
 * ⚠️  These selectors track other companies' front-ends. When a provider ships a
 * redesign, one adapter breaks; fix it here (data only — no logic lives in this
 * file) and reload the extension. See docs/PROVIDERS.md for the update recipe.
 *
 * Each list is ordered most-specific-first; bridge.js also appends generic
 * fallbacks, so a page with an unusual composer still has a chance of working.
 *
 * Loaded as a classic content script (MV3 has no module support for
 * declarative content scripts), so it exposes a global instead of exports.
 */

window.MultiChatAISite = (function () {
  'use strict';

  /** Fallbacks tried after the site-specific selectors. */
  const GENERIC = {
    composer: [
      'textarea:not([readonly]):not([disabled])',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"]',
    ],
    send: [
      'button[aria-label*="send" i]:not([disabled])',
      'button[data-testid*="send" i]:not([disabled])',
      'button[type="submit"]:not([disabled])',
    ],
    stop: [
      'button[aria-label*="stop" i]',
      'button[data-testid*="stop" i]',
    ],
    assistant: [
      '[data-message-author-role="assistant"]',
      '.markdown',
      '.prose',
      '[class*="markdown"]',
    ],
    user: ['[data-message-author-role="user"]'],
    newChat: [],
  };

  const ADAPTERS = [
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      composer: [
        '#prompt-textarea',
        'div#prompt-textarea[contenteditable="true"]',
        'textarea#prompt-textarea',
        'form div.ProseMirror[contenteditable="true"]',
      ],
      send: [
        'button[data-testid="send-button"]',
        'button#composer-submit-button',
        'button[aria-label="Send prompt"]',
        'button[aria-label*="Send message" i]',
      ],
      stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating" i]'],
      assistant: [
        '[data-message-author-role="assistant"]',
        'div[data-message-author-role="assistant"]',
      ],
      user: ['[data-message-author-role="user"]'],
      newChat: ['a[data-testid="create-new-chat-button"]', 'nav a[href="/"]'],
    },

    {
      id: 'claude',
      label: 'Claude',
      hosts: ['claude.ai'],
      composer: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][aria-label*="prompt" i]',
        'div.ProseMirror[contenteditable="true"]',
      ],
      send: [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[aria-label*="Send" i]:not([disabled])',
      ],
      stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
      assistant: [
        'div[data-testid="conversation-turn"] div.font-claude-message',
        'div.font-claude-message',
        'div[data-testid="assistant-message"]',
      ],
      user: ['[data-testid="user-message"]', 'div.font-user-message'],
      newChat: ['a[href="/new"]', 'button[aria-label*="New chat" i]'],
    },

    {
      id: 'gemini',
      label: 'Gemini',
      hosts: ['gemini.google.com'],
      composer: [
        'rich-textarea div.ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
      ],
      send: [
        'button.send-button',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Send" i]',
      ],
      stop: ['button[aria-label*="Stop response" i]', 'button[aria-label*="Stop" i]'],
      /*
       * Gemini is a Google (Angular/Material) app: when signed out it renders a
       * “Sign in” **button** with class `mdc-button`, outside any <header>/<nav>, so
       * the generic header/nav scan cannot see it and the panel claimed “Signed in”
       * while Google's own Sign in button sat in the corner.
       */
      signedOut: ['button.mdc-button', 'button[jsname]', 'a[href*="accounts.google.com"]'],
      assistant: [
        'model-response message-content',
        'model-response .markdown',
        '.model-response-text',
        'message-content',
      ],
      user: ['user-query', '.user-query-text'],
      newChat: ['button[aria-label*="New chat" i]', 'side-nav-action-button a[href="/app"]'],
    },

    {
      id: 'deepseek',
      label: 'DeepSeek',
      hosts: ['chat.deepseek.com'],
      composer: [
        'textarea#chat-input',
        'textarea[placeholder]',
        'div[contenteditable="true"][role="textbox"]',
      ],
      send: [
        'div[role="button"][aria-disabled="false"] div:only-child',
        'button[type="submit"]',
        'div[class*="send"] button',
      ],
      stop: ['button[aria-label*="stop" i]', 'div[class*="stop"] button'],
      assistant: ['div.ds-markdown', 'div.markdown-body', 'div[class*="markdown"]'],
      user: ['div.fbb737a4', 'div[class*="fbb737a4"]'],
      // DeepSeek has no stable class names; its logo/“new chat” links to the root.
      // bridge.js also falls back to any control *named* or *labelled* like one.
      newChat: [
        'a[href="/"]',
        '[aria-label*="new chat" i]',
        '[aria-label*="新对话"]',
        '[title*="new chat" i]',
        'div[class*="new-chat"]',
      ],
    },

    {
      id: 'grok',
      label: 'Grok',
      hosts: ['grok.com'],
      composer: [
        'textarea[aria-label*="Ask" i]',
        'form textarea',
        'div[contenteditable="true"][role="textbox"]',
      ],
      send: [
        'button[type="submit"]:not([disabled])',
        'button[aria-label*="Submit" i]',
        'button[aria-label*="Send" i]',
      ],
      stop: ['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]'],
      assistant: ['div.message-bubble', 'div[class*="response-content"]', 'div[class*="markdown"]'],
      user: ['div[class*="message-bubble"][class*="user"]'],
      newChat: ['a[href="/chat"]', 'button[aria-label*="New" i]'],
      /*
       * Grok's chat needs its realtime WebSocket. When that cannot be established the
       * page says so itself and the column would otherwise just sit there "waiting".
       * The app turns this into a specific notice (API mode / existing tab).
       */
      blocked: /real-?time connection|websocket|network or security software/i,
      /*
       * Grok keeps a two-pane layout (bot/chat rail on the left, chat on the right) and
       * does not collapse it in a narrow column, so both panes get squeezed. Inside our
       * frame only, drop the left rail and let the chat take the full width.
       */
      embeddedStyles: `
        html.mca-embedded [class*="sidebar-wrapper"] > aside,
        html.mca-embedded [class*="sidebar-wrapper"] > [class*="sidebar"],
        html.mca-embedded aside[class*="sidebar"] { display: none !important; }
        html.mca-embedded [class*="sidebar-wrapper"] > main,
        html.mca-embedded [role="main"] { width: 100% !important; min-width: 0 !important; }
      `,
    },

    {
      id: 'copilot',
      label: 'Copilot',
      // copilot.microsoft.com redirects the framed page to copilot.com; without that
      // host here the bridge found no adapter and exited, so the panel never reported in.
      hosts: ['copilot.microsoft.com', 'copilot.com'],
      /*
       * Signed out, Copilot shows "Sign in" as a header button (aria-label "Sign In",
       * text "ME") plus a /login link outside header/nav - neither is visible to the
       * generic header/nav text scan.
       */
      signedOut: ['a[href*="/login"]', 'button[aria-label*="Sign in" i]', 'button[aria-label*="Sign In"]'],
      composer: ['textarea#userInput', 'textarea[data-testid="composer-input"]', 'textarea'],
      send: ['button[data-testid="submit-button"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]'],
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['.ac-textBlock', 'div[data-content="ai-message"]', 'div[class*="markdown"]'],
      user: ['div[data-content="user-message"]'],
      newChat: ['button[aria-label*="New" i]'],
    },

    {
      id: 'perplexity',
      label: 'Perplexity',
      hosts: ['www.perplexity.ai'],
      composer: ['textarea[placeholder*="Ask" i]', '#ask-input', 'div[contenteditable="true"]'],
      send: ['button[aria-label*="Submit" i]', 'button[type="submit"]'],
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['div[data-testid="answer"]', 'div[class*="prose"]'],
      user: ['div[class*="group/query"]'],
      newChat: ['a[href="/"]', 'button[aria-label*="New" i]'],
    },

    {
      id: 'qwen',
      label: 'Qwen',
      hosts: ['chat.qwen.ai'],
      composer: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'],
      send: ['#send-message-button', 'button[aria-label*="Send" i]', 'button[type="submit"]'],
      stop: ['button[aria-label*="Stop" i]', '#stop-message-button'],
      assistant: ['div.markdown-body', 'div[class*="markdown"]'],
      user: ['div[class*="user-message"]'],
      newChat: ['button[aria-label*="New chat" i]', 'a[href="/"]'],
    },

    {
      id: 'kimi',
      label: 'Kimi',
      hosts: ['www.kimi.com', 'kimi.moonshot.cn'],
      composer: ['div[contenteditable="true"][role="textbox"]', 'textarea', 'div[contenteditable="true"]'],
      send: ['button[aria-label*="发送"]', 'button[aria-label*="Send" i]', 'div[class*="send"] button'],
      stop: ['button[aria-label*="停止"]', 'button[aria-label*="Stop" i]'],
      assistant: ['div[class*="markdown"]', 'div.segment-content', 'div[class*="segment"]'],
      user: ['div[class*="user-content"]'],
      newChat: ['a[href="/"]', 'button[aria-label*="新对话"]'],
    },
  ];

  function normalizeHost(hostname) {
    return String(hostname || '')
      .toLowerCase()
      .replace(/^www\./, '');
  }

  /** @returns {any|null} */
  function forHost(hostname) {
    const host = normalizeHost(hostname);
    for (const adapter of ADAPTERS) {
      for (const candidate of adapter.hosts) {
        const target = normalizeHost(candidate);
        if (host === target || host.endsWith(`.${target}`)) {
          return { ...adapter, generic: GENERIC };
        }
      }
    }
    return null;
  }

  return { adapters: ADAPTERS, generic: GENERIC, forHost };
})();
