# Testing

Eight scripts, zero dependencies (Node ≥ 20, plus Pillow for icons). Every browser test
runs a throwaway Edge profile in **headless** mode with the unpacked extension loaded — no
window pops up on your desktop, and no real provider is contacted.

```bash
node scripts/validate.mjs        # static checks
node scripts/smoke-test.mjs      # UI boots (16 checks)
node scripts/e2e-test.mjs        # mock-provider round trip (52 checks)
node scripts/embed-test.mjs      # real provider framed in a column (23 checks, needs internet)
node scripts/probe-embed.mjs     # proves the framing-header technique (3 scenarios)
node scripts/test-completion.mjs # bridge completion logic (12 cases, offline)
node scripts/test-run-policy.mjs # app-side readiness + deadlines (13 cases, offline)
node scripts/test-providers.mjs  # provider chat-link patterns (21 cases, offline)
node scripts/test-summary.mjs    # the prompt that asks a model to summarise (16 cases, offline)
node scripts/check-signin.mjs    # what a provider page offers as a sign-in control (needs internet)
node scripts/screenshot.mjs      # regenerate docs/screenshot-*.png
```

Current status: **static ✓ · 16/16 smoke · 52/52 e2e · 23/23 embed · 12/12 completion ·
13/13 run-policy · 21/21 providers · 16/16 summary-request**.

## `validate.mjs` — static checks

Fast and dependency-free; it catches what otherwise shows up as a mysterious
“Could not load extension”:

- `manifest.json` parses, is MV3, has `action`, `background.service_worker` (`type: module`);
- every file the manifest references exists (icons, worker, content scripts);
- `site-adapters.js` is listed **before** `bridge.js`;
- every content-script host is covered by `host_permissions`;
- every `.js` file parses (checked as an ES module, which also accepts classic scripts);
- relative ES-module imports resolve;
- no `eval` / `new Function`;
- no inline `<script>` or inline event handlers in HTML (MV3 CSP);
- every `<use href="#i-…">` has a matching `<symbol id="i-…">`.

## `embed-test.mjs` — the real provider, framed inside a column (needs internet)

Unlike the two suites below this one talks to a real provider, because the whole point is to
prove its page can be framed and driven:

1. a new model defaults to **embedded web chat**
2. the column contains an `<iframe>` pointing at the provider
3. framing headers are stripped by **scoped** rules (present, `sub_frame`-only,
   `initiatorDomains: [our id]`)
4. the bridge inside the framed page registers — the header leaves “Loading the chat…”
   and reports Signed in / Sign in inside this panel
5. the panel **pushes its own readiness** to the app (`__multichaiPanelStates()` reports
   `ready: true, composer: true`) — the signal that settles a column without the worker
6. the app **recognises the panel's own conversation link** from that push (a synthetic
   `MULTICHAI_STATE` with a `chatgpt.com/c/…` URL lands in `threadUrl`)
7. the panel reports that it **can start a fresh chat without reloading** (the bridge finds
   the site's own “New chat” control on the real page)
8. nothing opened a tab
9. **opening a topic without a recorded link** shows the saved answer — and the same
   `<iframe>` element survives with its `src` unchanged (a re-created frame would navigate,
   i.e. show the cookie banner again); no “Open in …” button is offered
10. **opening a topic with a recorded link** still shows the saved answer, still without
   navigating (same `src`), and offers **Open in ChatGPT** as a button
11. **“Open in ChatGPT”** — the explicit click — loads `chatgpt.com/c/…` in that column and
    hides the saved copy (charts/artifacts path)
12. **“Show live panel”** brings the untouched provider page back, `src` unchanged
13. **a conversation stored with the rendered HTML replays it** — the table is in the saved-answer frame and the text copy is not used
14. **that frame is sandboxed** — `allow-same-origin` without `allow-scripts`, and a hostile `<script>` in the stored markup never runs in the extension page
15. **the frame sizes itself** to the measured content height
16. **New chat does not reload the panel** — same iframe element, same `src`
17. **New chat empties this window only** — title back to “New chat”, saved copy hidden,
    history list untouched
18. **“Full” widens the panel without reloading it** — same iframe element, same `src`, and
    the button turns into “Return”
19. **“Return”** brings the multi-model view back
20. **Summarize stays off** while this window holds no captured answer — there is nothing to
    compare yet, so the button is disabled rather than opening an empty summary
21. no unexpected console errors

Run it after changing `embed-rules.js`, the identity handshake, `columns.js` reconciliation,
or a provider's framing policy.

## `probe-embed.mjs` — the header-stripping technique itself

Builds three throwaway extensions and frames both a local server (which sends
`X-Frame-Options: DENY` + `frame-ancestors 'none'`) and a real provider:

| scenario | expected |
| --- | --- |
| control, no header modification | blocked |
| static rules, unscoped | framed |
| dynamic rules, `initiatorDomains: [chrome.runtime.id]` | framed |

The third row is what the product uses: it proves the bypass is limited to this extension's
own frames, so websites stay protected.

## `test-completion.mjs` — when is a browser-session run over? (offline)

`src/content/completion.js` is a pure state machine (`decide(state)`) that the bridge
consults every poll; this test loads it into a `vm` sandbox and asserts all twelve branches.

It exists because “the model answered but the Stop button stayed” was a real bug, twice over:

1. the loop trusted only scraped text, so a panel whose answer container the adapter did not
   recognise waited for the whole timeout;
2. it counted a **disabled send button** as “still generating” — but the send button of an
   *empty composer* is disabled on every provider, which is exactly the state after
   submitting. Every such run therefore ran to the timeout with Stop on screen.

The rule is now the one the UI needs: a model is done when its page is **ready for the next
question** — composer available and the site's own stop control gone.

| state | verdict |
| --- | --- |
| stop control on screen, text changing | wait |
| text settled, page ready for the next question | done |
| text still changing / idle for only one poll | wait |
| answered, but no text readable | done-no-text |
| empty composer (send button disabled) — *not* busy | wait inside the grace window |
| never busy and no text, past the 20 s grace | done-no-text |
| no usable composer (loading / sign-in) | wait |
| site keeps its stop control forever (90 s of silence) | done |
| text settled but the site still says busy | wait |

`done-no-text` surfaces as **“Answered in the panel”** in the column instead of an error.

## `test-run-policy.mjs` — the app's side of “is it over?” (offline)

`src/app/run-policy.js` is a plain ES module with two pure functions, so it is asserted
without a browser (copied to a temp `.mjs` first, because this checkout is not a
`type: module` package):

- `panelVerdict(state)` — a column settles when its **own panel reports “ready for the next
  question”** twice in a row, having shown that it worked on the prompt (it was busy, or text
  arrived). No signal at all → settle after a 20 s grace. This is what makes a run finish
  even when the service worker was restarted mid-run and no `final` message will ever arrive.
- `runDeadline({startedAt, timeoutSec})` — `timeout + 25 s`, capped at 5 min. The last
  resort: whatever happens, a model settles and the composer unlocks.

## `check-signin.mjs` — what a provider page offers as a sign-in control (needs internet)

Opens a provider page in a real tab and lists every visible control that looks like a
login, with its tag, class, `href`, text and whether it sits inside `header`/`nav`. The bridge
decides “signed in” from exactly that, so this is the fast way to diagnose a column that claims
“Signed in” while the site is signed out.

It exists because of Gemini: its signed-out “Sign in” is a plain
`<button class="mdc-button …">` **outside** `header`/`nav`, so the generic scan missed it and
the panel claimed “Signed in” — with a “Sign in” button that returns 403 (Google refuses OAuth
inside a frame). Usage: `node scripts/check-signin.mjs https://gemini.google.com/app`.

## `test-providers.mjs` — recognising a model's own chat link (offline)

Reopening a topic works by pointing the column at the provider's **own** URL for that
conversation, because only the provider's page restores charts, tables and artifacts.
`threadUrlFor(providerId, url)` (in `src/shared/providers.js`) is what decides whether a URL
is a conversation link, and this test pins it down: every browser-session provider has a
`web.thread` pattern, real conversation URLs are canonicalised (query and trailing slash
dropped), landing pages / “new chat” pages / another provider's link / non-http URLs are
rejected.

That is 21 assertions over the nine providers with a web app; run it after adding a provider
or when a site changes its URL shape.

## `test-summary.mjs` — the prompt that asks a model to summarise (offline)

`src/app/summary-request.js` is pure (text in, text out), and its output *is* the contract: one
prompt, one exact shape, plus the Markdown the Copy button produces.

1. the prompt asks for `### Agreed` and `### Where they differ`
2. it carries the question
3. every model is listed with its own answer, labelled by name and mode
4. the difference table has one column per model, in board order, and the rules repeat that order
5. the model is told **not** to add links or preamble (`Do not add a preamble…`)
6. both answering models are counted
7. a model with no readable text is marked in place **and** named in the rules
8. a long answer is cut to an even share and says `[answer cut here]`
9. a short answer is left untouched
10. the answers section stays inside the budget (`share ≤ per-answer limit`, total ≤ limit)
11. a whole-chat prompt is labelled per turn (`[Turn 1] Q: …`) and does not claim one question
12. the same answers always produce the same prompt (no randomness)
13. Chinese questions and answers survive verbatim
14. the links list the provider thread, and say “no saved link” when there is none
15. the Copy text is the summary plus those links

## `smoke-test.mjs` — does the UI boot?

Launches Edge with `--load-extension`, attaches over the DevTools Protocol and drives the
real DOM:

1. service worker registered
2. app page booted
3. sidebar + history + composer present
4. the settings panel lives **inside** the sidebar (`aside.sidebar #settings-body`)
5. background answers on the port (`pong`)
6. Settings opens in the sidebar on the **Models** section and widens the sidebar
7. dropdown lists the five majors first (ChatGPT, Gemini, Claude, DeepSeek, Grok)
8. the Connection dropdown defaults to the **no-tab API mode**
9. a model can be added and shows an **×** plus status controls
10. **adding a model opens no browser tab** (tab count unchanged)
11. the model also appears in the sidebar's compact model list
12. the first model becomes a column above the input box, empty state hidden
13. state survives a page reload
14. a model can be removed with **×** (card and sidebar row both go)
15. removing the **last** model shows “Please add a model” and disables the input box
16. no console errors or page exceptions

## `e2e-test.mjs` — real round trip against a mock provider

`scripts/lib/mock-provider.mjs` listens on `127.0.0.1:11434` and implements the OpenAI
chat-completions endpoint with **real SSE streaming**. The “Ollama” provider already points
there, and its key is optional — so the full production path runs offline. Prompts matching
`cats and dogs` or `rag` get a comparative answer (two shared lines, two model-specific
lines), which is what the summary checks below line up.

1. the settings panel opens inside the sidebar on Models
2. API-only provider offers only API mode
3. API model card shows model name + key field
4. **adding a model does not open a tab**
5. the first model appears above the input box while Settings stays open
6. **Test** button validates the API path
7. the column streams while the model answers
8. the answer finishes and reports done (+ duration)
9. markdown is rendered (bold, list, code fence)
10. a history row appears with topic + timestamp
11. a second turn finishes and shows the turn picker
12. the newest turn is shown by default
13. an earlier turn can be restored in place
14. the second request carries the prior turn as context
15. the model name is forwarded verbatim
16. after a reload the conversation is restored
17. clicking a history item brings the columns back
18. **New chat** clears the board
19. **New chat does not rebuild the columns** — the same column element survives, the answer
    pane is emptied and the history list is untouched (a rebuild would reload every embedded
    provider page; this is the “DeepSeek asks about cookies on every new chat” regression)
20. two models answer one prompt in two columns
21. the same prompt reached both providers
22. columns share exactly the same width
23. **“Full”** gives one column the whole board (the button says “Return”, the sibling column
    is still in the DOM, just not painted)
24. **“Return”** brings the multi-model view back with exactly equal widths
25. the top bar carries a **“Summary by”** tag listing every model, the first column selected
26. **Summarize opens the panel with a model's answer** in it
27. **clicking Summarize asks exactly one model, once** — not the whole board
28. **that model is handed every answer of the round**, by name, plus the output contract
    (`### Agreed` / `### Where they differ`)
29. the panel shows what the model wrote — the bullets and headings are there, the columns are
    only `visibility: hidden` (still mounted, answers intact), and **Ask again**/**Copy** are live
30. **the model's table keeps one column per model** under an “Item” corner
31. **each differing item is a row with one cell per model** (Cats / Dogs)
32. **the window adds the per-model chat links** the model could not know (here: “API model —
    its transcript lives in this window”)
33. **“Whole chat” asks again**, and that prompt is labelled per turn (`THE CONVERSATION`)
34. **picking another model in the tag re-asks that model** (`qwen2.5`)
35. **closing the summary brings the same answers back untouched** — same two columns, equal
    widths, the answers still in place
36. **reopening the same summary costs no second request** (it is stored with its turn)
37. **Esc closes the summary**
38. a slow model starts streaming
39. the **fast** column reports done while the slow model is still streaming (the exact
    situation where Stop used to stay on screen)
40. **Stop** ends the run and re-enables Send
41. **Stop settles on its own within 3 s** — the app no longer waits for a `final` that may
    never come
42. the stopped column says "Stopped" and keeps its partial text
43. **removing a model drops its column immediately** (while Settings is still open)
44. the rest of the chat is **not re-rendered** — same DOM node, same answer text
45. the remaining column grows into the freed width
46. removing the last model shows "Please add a model" above a disabled input (and Send is off)
47. settings changed in another window update this window live (storage sync)
48. a browser-session model becomes a **Tab** column
49. **sending to a browser-session model opens no tab** (tab count unchanged)
50. that column explains no tab is open instead of opening one
51. **New chat stops a running answer instead of refusing** — with a slow model still
    streaming, New chat empties the window, hides Stop and re-enables Send
52. no console errors or exceptions

What is *not* covered automatically, because it needs a real signed-in account:
driving chatgpt.com / claude.ai / … in browser-session mode. That path is verified by hand
(see the checklist below).

### Manual checklist for browser-session mode

With a fresh profile:

- [ ] Add **ChatGPT** in browser-session mode → the column appears, no tab opens
- [ ] Press **Open ChatGPT** on that card → the site opens (explicit click) → sign in → **Check status** shows “Signed in”
- [ ] Send a prompt with that web model open → the column streams the answer and ends “Done · Ns”
- [ ] Close the provider tab, send again → the column says “No ChatGPT tab is open” and **no tab is created**
- [ ] Send again with the tab open → the provider keeps context (same tab, same conversation)
- [ ] Enable *Start a fresh chat in each model tab on “New chat”* → New chat → send → the provider starts a new thread
- [ ] Attach a text file and an image → the file is uploaded in the provider tab
- [ ] Sign out of the provider and send → the column explains it and brings the tab forward
- [ ] Stop mid-answer → the site's own Stop is clicked, partial text stays

## `screenshot.mjs`

Builds a three-model conversation against the mock provider and captures the images used in
the README (1440×900 each): `docs/screenshot-main.png`, `docs/screenshot-summary.png` (the
same round summarised), `docs/screenshot-settings.png`, `docs/screenshot-light.png`, and
`docs/screenshot-empty.png` (every model removed, so the “Please add a model” panel and the
locked composer are visible).

## Harness internals (`scripts/lib/harness.mjs`)

- `launchExtensionBrowser()` spawns
  `msedge --headless=new --load-extension=<dir> --user-data-dir=<temp>` and waits for the
  DevTools endpoint.
- The extension id of an unpacked extension is derived from its path, so the harness finds
  it by polling `/json/list` for a target whose URL contains `/src/app/app.html` (or the
  service-worker script) — no hard-coded ids.
- `Cdp` is a ~60-line WebSocket client for `Runtime.evaluate` / `Page.captureScreenshot`,
  and it collects `Runtime.exceptionThrown`, error logs and `console.error`.
- `createChecks()` keeps a script running after a failure and prints a summary; each script
  exits non-zero when anything fails.

## Regenerating icons

```bash
python scripts/make-icons.py     # needs Pillow (bundled with the DSH Python runtime)
```

Renders a gradient rounded square with three bars at 8× and downsamples with Lanczos, so
the 16 px toolbar icon stays crisp. Also writes `docs/icon-preview.png`.

## Packaging

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

Produces `dist/MultiChatAI-<version>.zip` with `manifest.json` at the archive root, which is
what the Edge Add-ons / Chrome Web Store upload form expects.

## Gotchas encountered while building this

- **`IncomingMessage` `'close'`** fires after a *normal* request body end in modern Node.
  Using it to detect “client disconnected” in the mock provider stopped the stream after one
  frame and made the extension look stuck at “Streaming…”. Detect disconnects on the
  **response** instead (`response.on('close')` + `!response.writableEnded`).
- **Deterministic DOM writes matter.** `input.value = x` alone is ignored by React-style
  composers; every field in the tests is set through the native value setter and then
  dispatched, exactly like the app does it.
- **`[hidden]` loses to component `display` rules** — `[hidden] { display: none !important }`
  is load-bearing in `app.css`.
- **Headless Edge keeps extensions** with `--headless=new` (old headless does not), but the
  service-worker target appears a beat later than the first page target; poll for it.
