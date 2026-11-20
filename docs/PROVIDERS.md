# Providers: adding one, fixing a broken adapter

There are two independent halves to a provider, and a provider may support either or both:

| Half | File | Needs |
| --- | --- | --- |
| **API mode** | `src/shared/providers.js` (`api` block) + `src/background/api.js` (only for a *new dialect*) | an API key |
| **Browser-session mode** | `src/shared/providers.js` (`web` block) + `src/content/site-adapters.js` | the user's existing login |

## Shipped providers

| id | Label | Browser session | API mode | API dialect |
| --- | --- | --- | --- | --- |
| `chatgpt` | ChatGPT (OpenAI) | ✅ | ✅ | openai |
| `gemini` | Gemini (Google) | ✅ | ✅ | gemini |
| `claude` | Claude (Anthropic) | ✅ | ✅ | anthropic |
| `deepseek` | DeepSeek | ✅ | ✅ | openai |
| `grok` | Grok (xAI) | ✅ | ✅ | openai |
| `copilot` | Copilot (Microsoft) | ✅ | — | — |
| `perplexity` | Perplexity | ✅ | ✅ | openai |
| `qwen` | Qwen (Alibaba) | ✅ | ✅ | openai |
| `kimi` | Kimi (Moonshot) | ✅ | ✅ | openai |
| `mistral` | Mistral | — | ✅ | openai |
| `ollama` | Ollama (local) | — | ✅ | openai |

Every API name is editable in **Settings → Models → Model name**, with a datalist of
known-good values. That is deliberate: model catalogues change monthly, the extension
should not.

> **Embedded mode** frames the provider page inside a column. That only works because
> `src/background/embed-rules.js` strips the provider's `X-Frame-Options` / `frame-ancestors`
> headers, scoped to this extension's own frames. A new provider therefore needs its host in
> `web.hosts` (already used for both the manifest and the rules) and nothing else; if a site
> adds JavaScript anti-framing on top of the headers, add a small shim to the bridge.
>
> Adding a browser-session provider does **not** open its site: the model is simply added
> as a column. Nothing ever opens a tab automatically — sending to a browser-session model
> requires that provider's page to be open already (the column explains this), and the only
> way a tab appears is an explicit click on **Open <Provider>** or a column's ↗ button.
> API-mode providers never need a page at all.

## Adding a provider (no code, 2 files)

1. **Catalogue entry** — `src/shared/providers.js`:

   ```js
   newprovider: {
     id: 'newprovider',
     label: 'NewProvider',
     vendor: 'Vendor',
     color: '#4f9dff',
     homeUrl: 'https://chat.newprovider.com/',
     web: {
       hosts: ['chat.newprovider.com'],
       urlPatterns: ['https://chat.newprovider.com/*'],
       files: true,
     },
     api: {
       kind: 'openai',                       // reuse an existing dialect
       baseUrl: 'https://api.newprovider.com/v1',
       defaultModel: 'new-1',
       modelSuggestions: ['new-1', 'new-1-mini'],
       keyUrl: 'https://dashboard.newprovider.com/keys',
       keyHint: 'sk-...',
       vision: false,
     },
   },
   ```

2. Register the id in `PROVIDER_ORDER` so it shows up in the dropdown.

3. If `web` is present, add the host to **both** places in `extension/manifest.json`:
   `host_permissions` and `content_scripts[0].matches` — `node scripts/validate.mjs`
   fails if you forget, because the bridge would never load.

4. Nothing else: the app, the worker and both runners are data-driven. Reload the
   extension in `edge://extensions`.

### Hosts must cover redirect targets and the adapter

A framed provider page often **redirects to another host**, and every host has to be
declared in four places or the panel breaks in a way that looks like “refused to connect”:

| place | why |
| --- | --- |
| `providers.js` → `web.hosts` | one `declarativeNetRequest` rule per host that strips the framing headers; a host missing here is refused by its own `frame-ancestors` |
| `manifest.json` → `host_permissions` **and** `content_scripts[0].matches` | the bridge only runs where it is injected |
| `site-adapters.js` → `hosts` | `forHost()` must resolve the page, or the bridge finds no adapter and **exits silently** (the panel then never reports in, and looks like a framing failure) |

Copilot is the live example: `copilot.microsoft.com` redirects the framed document to
`copilot.com`, so both hosts (plus `www.copilot.com`) are listed. When a panel shows
“refused to connect”, check the redirect target first:

## Adding a new API dialect

Only needed when a provider is not OpenAI-compatible. In `src/background/api.js`:

1. Write `async function runDialect({api, provider, modelName, apiKey, history, promptText, images, signal, onDelta})`:
   - `fetch` with `signal`
   - on `!response.ok` → `throw await httpError(response, provider)` (gives good hints)
   - iterate `for await (const payload of iterateSse(response))` and call
     `onDelta(textSoFar)` with the **full** text so far
   - return the final string
2. Add it to the `switch` in `runApiModel` and to `testApiModel`.
3. Add the dialect name to the JSDoc in `providers.js`.

## Fixing a broken browser-session adapter

This is the maintenance work this design concentrates in one file. Symptoms: a column
shows *“Could not find the message box”*, *“The prompt was typed but the site did not send
it”* or *“No answer text was found on the page”*.

### Debug loop

1. Open the provider in a normal tab, sign in, and open DevTools.
2. Inspect the composer, the send button, the stop button and one assistant message.
3. In the console, check the adapter that is active for the host:

   ```js
   window.MultiChatAISite.forHost(location.hostname)
   ```

4. Test candidate selectors directly:

   ```js
   document.querySelectorAll('button[aria-label*="Send" i]').length
   ```

5. Update the adapter lists in `src/content/site-adapters.js` (**most specific first**),
   reload the extension, retry.

### What each selector is used for

| key | used for | requirement |
| --- | --- | --- |
| `composer` | where the prompt is typed | visible; `textarea` or `contenteditable` |
| `send` | submitting the prompt | visible, not `disabled`, `aria-disabled !== "true"` |
| `stop` | **the** completion signal: visible ⇒ still generating | visible while streaming |
| `assistant` | reading the newest answer | text-bearing container of **one** message |
| `user` | counting sent messages (send verification) | one per user message |
| `signedOut` | selectors whose **visible text** means “not signed in” — only sites that declare them are scanned by `looksSignedOut()` | text matches log in / sign in / 登录 … |
| `signInInFrame` | `false` when the site cannot complete a sign-in inside a frame (Google answers 403 to framed OAuth, so the column must use a real tab) | Gemini |
| `newChat` | the site's own “New chat” control — used for *tab mode* (frames are reset by reloading) | one visible control; bridge.js then tries aria-label/title/class names, then any small element whose text is “New chat” / “新对话”, so a bare `<div>` still works |

`src/content/bridge.js` appends a generic fallback list after every site list, so a partial
match still has a chance: `textarea`, `[contenteditable=true]`, `button[type=submit]`,
`.markdown`, `.prose`, `[class*="markdown"]`.

### `web.thread` — the site's own link to a conversation

Separate from the DOM selectors: `providers.js` gives each provider a `thread` regular
expression matching its per-conversation URL, e.g.

| provider | pattern (canonical, query stripped) |
| --- | --- |
| ChatGPT | `https://chatgpt.com/c/<id>` (also `/g/<gpt>/c/<id>`, `chat.openai.com`) |
| Claude | `https://claude.ai/chat/<id>` |
| Gemini | `https://gemini.google.com/app/<id>` |
| DeepSeek | `https://chat.deepseek.com/a/chat/s/<id>` |
| Grok | `https://grok.com/chat/<id>` |
| Copilot | `https://copilot.microsoft.com/chats/<id>` |
| Perplexity | `https://www.perplexity.ai/search/<slug>` |
| Qwen | `https://chat.qwen.ai/c/<id>` |
| Kimi | `https://www.kimi.com/chat/<id>` |

The bridge reports `location.href` every 1.5 s; the app stores the link that matches this
pattern on the answer (`answer.threadUrl`), and opening that topic later loads it. If a site
changes its URL shape, history silently degrades to the text copy — fix the regex here, then
`node scripts/test-providers.mjs` tells you whether it still matches the real thing.

### How the bridge decides an answer is finished

The rule is “**is this page ready for the next question?**”, polled every 650 ms:

- `stop` visible → still generating, keep waiting;
- `composer` present, `stop` gone, for two polls in a row, and either the page was busy or
  text arrived → done;
- the last `assistant` text must additionally have been stable for 1.5 s before it is kept as
  the answer (the transcript copy), but unreadable text no longer holds the run open;
- no signal at all (no `stop`, no readable text) → done after a 20 s grace period, reported as
  “Answered in the panel”;
- a site that never takes its `stop` control down → done after 90 s of silent text.

The `send` selector is **not** used to decide “busy”: an empty composer disables the send
button on every provider, and an empty composer is exactly the state after submitting. It is
reported for diagnostics only (`sendReady`). The timeout is `timeoutSec` from Settings
(default 180 s), and the app gives every model another 25 s of slack before it settles the
column itself.

Getting `stop` right is therefore worth more than any other selector in this table: if a
provider renames it, its runs fall back to the 20 s no-signal path (still finishing, just
without a captured transcript).

### Tips that save time

- Prefer `data-testid` / `aria-label` attributes; class names on these sites are
  generated and churn weekly.
- If the answer contains tool/thinking blocks, choose the selector that returns the
  **prose** container, not the whole turn.
- If typing works but sending does not, the site probably needs a real button click: put
  its selector in `send` instead of relying on the synthetic Enter fallback.
- Newline handling: the bridge deliberately *pastes* into `contenteditable` composers so a
  multi-line prompt does not submit early.

## Measured framing status (headless Edge, this machine)

| provider | embedded panel | note |
| --- | --- | --- |
| ChatGPT | ✅ loads | sign in inside the panel, or once in a tab then ⟳ |
| Gemini | ✅ loads | Google account sign-in inside the frame |
| Claude | ✅ loads | — |
| DeepSeek | ❌ blocked | CloudFront answers `403 Request blocked` for framed requests; use **Use a tab instead** or an API key |
| Grok | ⚠️ loads | needs a WebSocket to grok.com; a blocked network shows Grok's own “security software” message (same in a tab) |

Re-measure with `node scripts/diagnose-provider.mjs <providerId>`: it adds the model through
the real UI, attaches to the cross-origin frame target over CDP and prints the composer,
buttons, login affordances and the visible page text.

## Notes per provider

- **ChatGPT** — ProseMirror composer (`#prompt-textarea`), `data-message-author-role`
  marks messages. Text streams into the same node.
- **Claude** — `.ProseMirror` composer, `font-claude-message` for the assistant bubble.
- **Gemini** — Quill (`rich-textarea .ql-editor`), answers in `model-response`.
- **DeepSeek** — plain `textarea#chat-input`, answers in `.ds-markdown`.
- **Grok** — form textarea + submit button; bubble class names change often. Two
  Grok-specific fields exist for the reasons below:
  - `blocked` (a regex on the site's own text): Grok streams over a **WebSocket** to
    `grok.com`. When a network or security policy blocks it, the page says so and every send
    fails. The bridge fails the run immediately with that message, and the column offers the
    two things that do work: **API-key mode** (`api.x.ai`) or **existing-tab mode**. The
    extension cannot tunnel a blocked WebSocket — that is a network fact, not a code path.
  - `embeddedStyles`: Grok keeps a desktop two-pane layout (bot/chat rail + chat) and does not
    collapse it in a 300–500 px column, so both panes get squeezed. The bridge injects that
    stylesheet **only when the page is framed** (never in a tab) and re-applies it as the SPA
    re-renders; it hides the left rail and gives the chat the full width.
- **Copilot** — `textarea#userInput`; answers in `.ac-textBlock`. Remember the redirect:
  `copilot.microsoft.com` lands on `copilot.com`.
- **Perplexity** — answers arrive with citations; the prose container is what you want.
- **Qwen / Kimi** — Composer is a `textarea` / `role=textbox`; both ship Chinese labels, so
  the adapters include `发送` / `停止` / `新对话` alternates.
