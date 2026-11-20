# Architecture

MultiChatAI is a Manifest V3 extension with three runtime contexts. This document
explains how they talk to each other, what is stored where, and which trade-offs were
made on purpose.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ extension page  chrome-extension://<id>/src/app/app.html                   │
│  sidebar (History / New chat / Settings)  +  column board  +  composer     │
└───────────────▲────────────────────────────────────────────┬───────────────┘
                │ chrome.runtime.connect('multichat-app')    │
                │ ← delta / final / error / run-status        │ run / abort /
                │                                             │ test-api / check
┌───────────────┴─────────────────────────────────────────────▼──────────────┐
│ service worker  src/background/service-worker.js                           │
│   run fan-out · storage reads · provider dispatch · abort bookkeeping      │
│     ├── api.js          openai / anthropic / gemini dialects (fetch, SSE)  │
│     └── web-runner.js   tab discovery + bridge session (bridge-hub.js)     │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ chrome.tabs.sendMessage / chrome.runtime.sendMessage
┌───────────────▼────────────────────────────────────────────────────────────┐
│ provider tab (chatgpt.com, claude.ai, …) — user's own session              │
│   src/content/site-adapters.js (selector data) + bridge.js (DOM driving)   │
└────────────────────────────────────────────────────────────────────────────┘
```

## Why these boundaries

- **The app page owns the UI and the transcript.** It never touches provider DOM or API
  keys for runs; it asks the worker to execute, and it persists turns as they settle.
- **The service worker owns execution.** A page can be closed at any moment; the worker
  keeps its 1:1 port, streams answers back, and can abort in-flight `fetch` calls or tell
  a provider tab to press its own Stop button.
- **The content script owns the provider's DOM.** It is injected by the manifest into
  provider pages (declarative, so no `activeTab` gymnastics) and does nothing until asked.

## Embedded web chat (the default, free path)

A column can run the provider's **own web chat**, so no API key is needed:

1. **Framing headers are stripped, scoped.** Provider sites send `X-Frame-Options` and/or
   `Content-Security-Policy: frame-ancestors`. `src/background/embed-rules.js` installs
   `declarativeNetRequest` dynamic rules that remove exactly those response headers for
   `sub_frame` requests, with `initiatorDomains: [chrome.runtime.id]`. Only frames created by
   this extension are affected — the provider stays unframeable for every website.
   (`scripts/probe-embed.mjs` proves all three cases: control blocked, unscoped rules framed,
   scoped rules framed.)
2. **Identity handshake.** Each column renders
   `<iframe class="column-embed" src=<provider.homeUrl>>`. Because the frame is cross-origin,
   the app page sends `postMessage({type:'MULTICHAI_IDENTITY', modelId})` after every load
   (plus retries, since the bridge only exists at `document_idle`). The bridge stores that id
   and announces `MULTICHAI_HELLO` with it.
3. **Targeted dispatch.** The worker keeps `modelId → {tabId, frameId}` from the hello, and
   runs the prompt with `chrome.tabs.sendMessage(tabId, msg, {frameId})`. Progress/result
   frames travel back through the same bridge-hub protocol as tab mode, so the UI code path
   is identical for both.
4. **Status pill.** The column header shows Loading → *Sign in inside this panel* / *Signed in*
   / streaming / done. `signedIn` is not “composer exists” (landing pages have one); a visible
   sign-in affordance in the page chrome flips it to false.
5. **Readiness push.** The bridge also posts `{type:'MULTICHAI_STATE', ready, busy, hasComposer,
   signedIn}` to the app page every 1.5 s; the app matches it to a column by window identity.
   That push — not the worker's messages — is what lets a panel settle its own column when the
   worker was restarted mid-run (see “When is a run over?”).
5. **Saved transcript vs live page.** A framed provider cannot be rewound to a past thread,
   so opening an old conversation renders the stored Q&A inside the column
   (`ColumnBoard.showSnapshot`) and leaves the iframe unmounted — clicking around History
   never reloads a provider page. **Open live chat** switches that column back to `live`
   (`openLive` → `mountEmbed`). If the user simply types instead, `send()` calls `openLive`
   for any snapshot column and attaches a compact recap (`buildRecap`, last 4 turns, capped)
   that `runEmbedModel` prefixes to the prompt, so the model continues the topic on its fresh
   page instead of restarting it.
6. **Failure surface.** If no hello arrives within ~20s the column says so and offers ⟳
   (reload the frame) and “open in tab”, instead of leaving a blank box.

### Modes at a glance

| mode | transport | needs a page? | needs a key? |
| --- | --- | --- | --- |
| `embed` (default) | iframe in the column, `frameId`-targeted bridge | the frame itself | no |
| `api` | `fetch` from the service worker | no | yes |
| `web` | bridge in a tab **you** opened | that tab | no |

Nothing creates a tab automatically: `runWebModel` only looks for an existing tab and fails
with an actionable hint when there is none.
## UI structure (single window, no modals)

```
┌── sidebar (262px, 396px while settings are open) ──┬── main ──────────────────┐
│ chat view            │ settings view              │  columns (equal width)   │
│  brand               │  ← back   Settings         │  ┌───────┐┌───────┐      │
│  + New chat          │  [Models][General][About]  │  │model 1││model 2│      │
│  History (scroll)    │  body (scroll)             │  └───────┘└───────┘      │
│  Models (compact)    │                            │  composer (input+files)  │
│  ⚙ Settings          │                            │                          │
└─────────────────────┴────────────────────────────┴──────────────────────────┘
```

- **Settings live in the sidebar**, not in a dialog: `SettingsView.open()` hides
  `#view-chat`, shows `#view-settings` and adds `.is-settings` to the app root, which
  widens the sidebar column via a CSS variable. `Esc` or ← returns.
- **Adding a model is a pure UI/storage action** — no tab, no reload. The model list, the
  sidebar model strip and the column board are re-rendered from state immediately, so the
  first model appears above the composer and every further model appears as an additional
  column in the same window.
- **Columns are equal by construction**: `.column { flex: 1 1 0; min-width: 290px }`.
  Content length cannot bias the share; when the window is too narrow for the floor width
  the board scrolls horizontally instead of squashing individual columns.
- **The board mirrors the model list, not the transcript.** `renderBoard()` builds the
  columns from `enabledModels()`; a turn's stored answers are only *looked up* by model id
  (`ColumnBoard.showTurn`). Consequences, all intentional:
  - removing (or unchecking) a model removes its column immediately and the remaining
    columns grow into the freed width;
  - a model that joined later shows “No answer in this turn” on older turns;
  - with no models selected the board shows the **“Please add a model”** panel and
    `updateComposerState()` disables the textarea, the file picker and Send until one is
    added;
  - answers of removed models stay in `conv:<id>` (nothing is destroyed) but are no longer
    rendered, and `endRun()` re-syncs the board so a removal during a run also takes effect
    as soon as the run settles.
- **Two rendering modes, on purpose.**
  - `ColumnBoard.render(descriptors)` rebuilds every column from scratch — used when the
    *content* changes (opening a conversation, switching turn with the picker, reload).
  - `ColumnBoard.sync(descriptors)` reconciles in place: it removes columns whose model is
    gone, appends columns for new models, updates only header text for survivors, and never
    touches a surviving column's body. Model-list edits use this, so removing a model cannot
    disturb the answers already on screen (the e2e test asserts the surviving column keeps
    the exact same DOM node and answer text).
- **Switching topics never navigates a panel.** `ColumnBoard.render()` reconciles like
  `sync()` instead of wiping the DOM: columns whose model is still there are **reused**, so
  opening an old topic (which paints the saved answer over the live page) or pressing
  **New chat** leaves every embedded `<iframe>` exactly where it was. Recreating a column
  navigates it — that is the reload that made DeepSeek show its cookie banner on every new
  chat.
- **New chat reloads each panel instead of pressing the site's button.** `newChat()`
  persists the current conversation (it was already persisted per turn, so the sidebar row is
  there), empties the answer panes (`ColumnBoard.resetForNewChat`), and then calls
  `ColumnBoard.startFresh(key, provider.homeUrl)` for every embedded column: the *same*
  `<iframe>` element is pointed back at the provider's home URL, i.e. a fresh session.
  Pressing the site's own “New chat” control was cheaper but unreliable — providers disagree
  about that control (DeepSeek has no `<button>`, some SPAs keep the old thread alive) and a
  miss leaves the panel silently on the previous conversation. A reload cannot miss, and a
  fresh session is exactly what the button promises. `resetProviderChatsOnNewChat` (Settings
  → General; `settingsVersion` migration for older profiles) turns the reload off; tab-mode
  models get a `reset-provider-chats` message instead, because their page is not ours to
  reload.
- **Settings are shared state.** The page listens to `chrome.storage.onChanged` and adopts
  `settings`/`apiKeys`/`conversationIndex` written by any other context (another app window,
  the worker). Adopting never writes back, so there is no feedback loop; the practical effect
  is that a model removed in one window disappears from the other windows immediately.
- **Nothing opens a tab automatically.** API models run entirely in the service worker, so
  they need no page at all. A browser-session model is driven through a provider tab the
  user already has open (`runWebModel` looks for one and fails with an actionable hint if
  there is none). Only a deliberate click — the **Open ChatGPT** button on a model card, or
  the ↗ button in a column — may open one, which is exactly what a link would do.

## When is a run over?

The question is answered at two levels, because no single signal is trustworthy:

**1. The page's own state machine** (`src/content/completion.js`, pure, polled every 650 ms
inside the bridge): *is this page ready for the next question?* — a composer is available and
the site's own stop control is gone. Scraped text and text stability only refine that.

It has to be phrased this way. Two earlier versions were wrong:

- deciding on scraped text alone meant a panel whose answer container the adapter did not
  match waited for the whole timeout;
- counting a **disabled send button** as “still generating” meant *every* run hung: on every
  provider the send button of an empty composer is disabled, and an empty composer is exactly
  the state after submitting.

**2. The app's own bookkeeping** (`src/app/run-policy.js`, pure, ticked every 2 s): every
model of a run settles through one idempotent function, `finalizeModel`, from whichever
signal arrives first:

| signal | when it fires |
| --- | --- |
| `final` / `error` from the worker | normal case, as soon as the bridge decides |
| the panel pushes “ready for the next question” (twice in a row) | the worker was restarted mid-run, or its message was lost — the panel is the provider's own page, so it can settle itself |
| the Stop button | 600 ms grace for answers already in flight, then everything left is marked stopped |
| per-model deadline (`timeout + 25 s`, ≤ 5 min) | last resort |

Consequences that matter to the user:
- The Stop button disappears as soon as every model is ready for the next question, and Send
  is usable again — no manual stop and no waiting for a timeout.
- Stop always works, even when the worker no longer knows the run (MV3 evicts idle workers;
  a restart drops its in-memory run registry). It is handled in the app, not requested from
  the background.
- If the adapter cannot read the answer text at all, the run still finishes and the column
  says “Answered in the panel” instead of hanging.
- `endRun()` does not rebuild the board: finishing a run never reloads embedded pages. The
  model list is synced by the settings actions themselves, so nothing else needs a re-render.
- **Changing topic abandons the run.** New chat, opening a history entry and deleting a
  conversation all call `abandonRun()`, which settles every pending model immediately instead
  of refusing to switch. Refusing was how “New chat” could look dead while one slow model was
  still answering (or while a `final` was never going to arrive).

## Message protocols

### App ⇄ service worker (long-lived port, `name: 'multichat-app'`)

App → worker:

| message | payload | reply |
| --- | --- | --- |
| `ping` | — | `{type:'pong', version}` |
| `run` | `{runId, prompt, attachments, modelIds, history}` | streamed events below |
| `abort` | `{runId}` | — |
| `open-provider-tab` | `{providerId, active}` | `{type:'reply', requestId, data}` |
| `check-provider` | `{providerId, requestId}` | `{ok, signedIn, message}` |
| `test-api` | `{modelId, requestId}` | `{ok, message}` |
| `reset-provider-chats` | `{requestId}` | `{ok, touched}` |

Worker → app:

| message | meaning |
| --- | --- |
| `run-status` | a model is opening/typing/contacting — sets the column status line |
| `delta` | full answer text so far (idempotent, so a lost frame cannot corrupt a column) |
| `final` | `{text, ms, stop?}` — done (or stopped) |
| `error` | `{message, hint}` — one column failed, the others keep going |

`requestId` turns the port into a tiny RPC, so settings-screen actions (Test, Check login)
can await an answer without a second connection.

### Worker ⇄ provider tab

Worker → bridge:

- `MULTICHAI_PING` → `{ready:true, signedIn, hasComposer, busy, readyForNext, host, adapter, url}`
  (synchronous response)
- `MULTICHAI_RUN` `{runId, prompt, attachments, timeoutMs}` → `{accepted:true}`, then frames
- `MULTICHAI_ABORT` `{runId}` → clicks the site's own stop button

Bridge → worker:

- `MULTICHAI_PROGRESS` `{runId, text, phase:'typing'|'waiting'|'streaming'}`
- `MULTICHAI_RESULT` `{runId, ok, text, error, hint, stopped, captured}`

`runId` here is a **bridge-scoped** id generated per model per turn, so two columns
driving the same provider at the same time cannot cross their streams
(`src/background/bridge-hub.js`).

### Panel ⇄ app page (`window.postMessage`, cross-origin safe, one way)

The bridge inside an embedded column also talks straight to the app page — this is the
signal that does not involve the worker at all:

| direction | message | meaning |
| --- | --- | --- |
| app → panel | `MULTICHAI_IDENTITY` `{modelId}` | “you are column X” (re-posted on mount, before every run, and every 10 s so a restarted worker's frame registry heals itself) |
| panel → app | `MULTICHAI_STATE` `{modelId, hasComposer, busy, ready, sendReady, signedIn, url}` | readiness heartbeat, every 1.5 s; `url` is the panel's own address (see “Reopening a conversation”) |

The app matches the message to a column by **window identity**
(`iframe.contentWindow === event.source`), never by URL, and uses `ready` to settle a pending
model. `ready` means *composer available and nothing generating* — deliberately **not**
“send button enabled”.

## Storage schema (`chrome.storage.local`)

| key | shape |
| --- | --- |
| `settings` | `{models: ModelEntry[], theme, timeoutSec, resetProviderChatsOnNewChat, historyLimit}` |
| `apiKeys` | `{[modelId]: 'sk-…'}` — kept apart from settings so it is easy to audit/clear |
| `conversationIndex` | `[{id, title, createdAt, updatedAt, turnCount}]` — what the sidebar renders |
| `conv:<id>` | `{id, title, createdAt, updatedAt, turns: Turn[]}` |
| `activeConversationId` | the conversation to restore on next open |

```ts
type ModelEntry = {
  id: string;                 // m_…
  providerId: string;         // chatgpt | gemini | claude | …
  mode: 'web' | 'api';
  label: string;              // provider label, user-visible
  modelName?: string;         // API mode only
  enabled: boolean;
  addedAt: number;
};

type Turn = {
  id: string;
  prompt: string;
  attachments: {id, name, type, size, kind: 'text' | 'image', text?, dataUrl?}[];
  createdAt: number;
  answers: Record<string, {   // keyed by model id
    providerId: string; label: string; mode: 'web' | 'api'; modelName?: string;
    text: string; status: 'pending' | 'streaming' | 'done' | 'stopped' | 'error' | 'timeout';
    error?: string; startedAt: number; endedAt?: number; ms?: number;
    threadUrl?: string;       // the model's own link to this conversation
    html?: string;            // the answer as the model rendered it (replayed by history)
    note?: string;            // e.g. "Answered in the panel" when text was not captured
  }>;
};
```

## Reopening a conversation

Three things are stored per answer: the text, the **rendered answer HTML**, and the
provider's own link to that chat. History uses them in that order — richest first, and
never by loading the provider's page.

0. **Link first.** Each answer stores the provider's own URL for that chat
   (`answer.threadUrl`, captured from the panel's `location.href` and validated against the
   provider's `web.thread` pattern). Opening a conversation loads that URL, which is the only
   way to reproduce everything the site rendered — charts, tables, artifacts, interactive
   widgets. It costs a page load, and a framed site may ask you to sign in again.
1. **Capture (when an answer settles).** The bridge clones the newest assistant message,
   replaces every `<canvas>` with its pixels (`toDataURL`, so charts survive; a cloned canvas
   is blank), strips scripts/handlers/form controls, and reports the markup with
   `MULTICHAI_RESULT`. The app stores it as `answer.html` (capped at ~240 KB; anything bigger
   is dropped and history falls back to the text).
2. **Replay instead, when there is no link.** `ColumnBoard.#savedAnswer` renders that markup
   inside `<iframe sandbox="allow-same-origin" srcdoc=…>`: same-origin so the parent can
   measure it, **no `allow-scripts`**, and the extension page's CSP blocks inline scripts in
   `srcdoc` anyway. The frame cannot script this page, read its storage, submit forms or open
   windows. Its height is measured by the parent (`contentDocument.scrollHeight`) after load
   and again as images arrive, so the answer fits without a scrollbar.
3. **Nothing navigates.** The live panel keeps its state — that reload is what asked Gemini
   to sign in again and re-showed DeepSeek's cookie banner. The bar says “Saved copy ·
   nothing reloaded”.
4. **Load on demand.** With a `threadUrl`, the bar offers **Open in <model>**, which calls
   `ColumnBoard.restoreThread()` and loads the provider's page — the only place a column ever
   navigates, and only on an explicit click. `Show live panel` returns to the untouched page.
5. **Continuing** from a saved copy prefixes the prompt with a short recap (`buildRecap`),
   unless the panel is already on that exact thread.

Conversations recorded before the capture existed have no `answer.html`; they show the
markdown text, and the console logs `history copy captured (text only)` for new answers in
that state so the reason is visible.

One storage key per conversation keeps streaming updates cheap: a run rewrites only that
conversation, and the sidebar renders from the small index without loading transcripts.
`historyLimit` (default 100) prunes the oldest conversations on write.

## Summary of a round (written by a model)

**Summarize** does not paraphrase in this window: it asks *one model* to write the comparison.

- **Who writes it.** The chip in the top bar (`#summarize-model`) picks a model from the board;
  the choice is stored as `settings.summarizerModelId` and defaults to the **first column**.
  An unknown or removed id silently falls back to the first column, so a model edit cannot
  leave the chip pointing at nothing.
- **What it is asked.** `src/app/summary-request.js` (pure: text in, text out) builds one
  prompt out of the sources: the question, then every model's answer labelled with its name and
  mode, then an exact output contract — `### Agreed` bullets, `### Where they differ` as a
  Markdown table with one column per model, cells under 20 words, `—` when an answer does not
  address an item. Models without readable text are named and excluded from the comparison.
  Answers are truncated to an even share (4 000 chars per answer, 32 000 in total) so one long
  answer cannot crowd the others out.
- **How it is asked.** Through the ordinary run pipeline — `{type:'run', modelIds:[id]}` — so
  all three modes work unchanged: an API model answers in the service worker; an embedded or
  tab model is typed into its own chat (that thread will show the request, which the panel says
  out loud while it waits). The summary's messages share the run vocabulary, so the app routes
  them by `runId` before the board handlers: `summary.runId` is a run of its own and can never
  paint a column.
- **What the panel shows.** The model's answer, rendered by the same Markdown renderer the
  columns use, streaming as it arrives; then the **links section**, which the window builds
  from `answer.threadUrl` because a model cannot know URLs; then one line saying who wrote it.
  Copy serialises the model's text plus those links (`summaryCopyText`).
- **The columns are only hidden.** The panel is an overlay and `.columns-scroll.is-summary`
  sets `visibility: hidden` + `pointer-events: none` on the board — the frames keep their layout
  and their documents, so an embedded summariser can still be typed into while the panel covers
  it, and closing the panel brings the same answers back without a reload.
- **State.** `summary` in `app.js` holds the run (`status: idle|running|done|cancelled|error`),
  the streamed text, the sources and a deadline. Cancel aborts the run and settles after
  600 ms; a 2 s tick enforces the deadline, so a dead worker cannot leave the panel spinning.
  A finished summary is stored on its turn (`turn.summary = {modelId, modelName, scope, text,
  createdAt}`), so reopening it costs no second request; changing the model, changing the scope
  or pressing **Ask again** asks again.

## Lifecycle notes

- **A panel keeps the content script it was loaded with.** After an extension update that\n  script is the previous build, so eloadPanelsAfterUpdate() reloads every mounted panel\n  once per version (that is why a new build can otherwise keep behaving like the old one).\n- **The port keeps the worker alive** while the app page is open. If the worker is
  recycled anyway, the port disconnects, the app reconnects silently and pending RPCs are
  rejected with a clear message.
- **Runs are fire-and-forget from the UI's perspective.** Every model settles exactly once
  (`final` or `error`); the app clears its "running" state when the set of pending model
  ids is empty.
- **Abort** aborts every `AbortController` of the run. API adapters rethrow `AbortError`
  with `partialText` attached, so a stopped column keeps what it already had. Browser
  sessions get a `MULTICHAI_ABORT`, the page clicks its own Stop, and the partial text is
  reported normally.

## Rendering decisions

- **No framework.** The UI is ES modules + `innerHTML` templates with escaped
  interpolation. Small, fast, and there is nothing to build.
- **Columns are patched, not re-rendered, during a run.** Rebuilding them would reset
  scroll position and flicker the markdown.
- **Streaming repaint is throttled** to ~14 fps per column (`util.throttle`), while the
  text itself is stored on every delta.
- **Markdown is hand-rolled** (`src/app/markdown.js`) because MV3 forbids remote code and a
  full parser is unnecessary: escape first, then handle blocks/inline spans, and only
  `http(s)` URLs may become `href`s.
- **`[hidden]` needs `!important`** in this UI: component rules set `display` explicitly,
  which would otherwise beat the user-agent `[hidden]` rule.

## Security posture

- MV3 CSP: no inline scripts, no `eval`, no remote imports — enforced by
  `scripts/validate.mjs`.
- Answer text is HTML-escaped before any markup is added; user text never reaches an
  attribute except escaped `title`/`value`.
- Content scripts only run on the provider hosts listed in the manifest.
- The bridge never injects UI into provider pages and never reads credentials.
