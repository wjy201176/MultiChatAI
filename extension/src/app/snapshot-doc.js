/**
 * The document used to replay a saved answer inside a column.
 *
 * Why an iframe at all: the HTML comes from a provider's page, so it must never be
 * injected into the extension page — an extension page that can read
 * `chrome.storage` and message the worker is not a place for foreign markup. The
 * frame is sandboxed (`allow-scripts`, no `allow-same-origin`), which gives it an
 * opaque origin: it cannot reach our DOM, our APIs, the top window's URL, or any
 * storage. `allow-scripts` is only there so the frame can report its own height to
 * the parent.
 *
 * What we keep: the answer's own markup (tables, lists, code, SVG, inlined chart
 * images). What we provide: neutral typography, because the provider's stylesheet
 * is not captured with it.
 *
 * There is deliberately **no script** in this document: the extension page's CSP
 * blocks inline scripts in `srcdoc` frames anyway, and the height is measured by
 * the parent through `contentDocument` instead (see `ColumnBoard.#measure`).
 */

const DARK = {
  background: '#1a1e26',
  text: '#e6e9f0',
  border: 'rgba(140, 150, 170, 0.35)',
  soft: 'rgba(140, 150, 170, 0.12)',
  link: '#7ea6ff',
};

const LIGHT = {
  background: '#ffffff',
  text: '#20242c',
  border: 'rgba(60, 70, 90, 0.25)',
  soft: 'rgba(60, 70, 90, 0.06)',
  link: '#1f5fd0',
};

/**
 * @param {string} html the captured answer markup
 * @param {{dark?: boolean}} [options]
 * @returns {string} a complete HTML document for `iframe.srcdoc`
 */
export function buildSnapshotDocument(html, { dark = true } = {}) {
  const palette = dark ? DARK : LIGHT;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; background: ${palette.background}; overflow: hidden; }
  body {
    color: ${palette.text};
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    word-wrap: break-word;
  }
  img, svg, video { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: .6em 0; display: block; overflow-x: auto; }
  th, td { border: 1px solid ${palette.border}; padding: .32em .6em; text-align: left; vertical-align: top; }
  th { background: ${palette.soft}; }
  pre { background: ${palette.soft}; padding: .7em .8em; border-radius: 8px; overflow-x: auto; }
  code { font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: .92em; }
  pre code { font-size: .9em; }
  blockquote { border-left: 3px solid ${palette.border}; margin: .6em 0; padding: .1em 0 .1em .8em; }
  a { color: ${palette.link}; }
  h1, h2, h3, h4 { line-height: 1.25; margin: .7em 0 .35em; }
  h1 { font-size: 1.3em; } h2 { font-size: 1.2em; } h3 { font-size: 1.1em; }
  ul, ol { padding-left: 1.4em; }
  math, .katex { font-size: 1.02em; }
</style></head>
<body>${html}
</body></html>`;
}
