/**
 * A deliberately small Markdown renderer.
 *
 * Why not a library? MV3 forbids remotely-hosted code and we do not want to
 * vendor 30 kB of parser for what chat answers actually contain. This handles
 * the constructs that matter for comparing model output: headings, (nested)
 * lists, fenced code, inline code, bold/italic/strike, links, blockquotes,
 * rules and pipe tables.
 *
 * Security: the input is HTML-escaped first and no attribute is ever built from
 * raw source except `href`, which must start with http(s). Rendering therefore
 * cannot inject markup or script.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const CODE_TOKEN = '\u0000CODE';

/** Inline spans, applied to already-escaped text. */
function renderInline(escaped) {
  let out = escaped;
  // `code` first so its contents are not touched by emphasis rules.
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=$|[^\w*])/g, '$1<em>$2</em>');
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  // Bare URLs. The `"` lookbehind guard keeps already-built hrefs untouched.
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)"]+)/g,
    '$1<a href="$2" target="_blank" rel="noreferrer noopener">$2</a>',
  );
  return out;
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

/**
 * Build nested <ul>/<ol> markup from a flat run of list items.
 * @param {Array<{indent:number, ordered:boolean, text:string}>} items
 * @param {number} start inclusive
 * @param {number} end exclusive
 */
function renderListLevel(items, start, end) {
  if (start >= end) return '';
  const base = items[start].indent;
  const tag = items[start].ordered ? 'ol' : 'ul';
  const parts = [];
  let idx = start;

  while (idx < end) {
    const item = items[idx];
    if (item.indent < base) break;
    if (item.indent > base) {
      // Should have been consumed as a child; guard against malformed input.
      idx += 1;
      continue;
    }
    let childEnd = idx + 1;
    while (childEnd < end && items[childEnd].indent > base) childEnd += 1;
    const children = childEnd > idx + 1 ? renderListLevel(items, idx + 1, childEnd) : '';
    parts.push(`<li>${renderInline(item.text)}${children}</li>`);
    idx = childEnd;
  }

  return `<${tag}>${parts.join('')}</${tag}>`;
}

/**
 * @param {string} source raw model output
 * @returns {string} HTML safe to assign to innerHTML
 */
export function renderMarkdown(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const codeBlocks = [];

  const stash = (lang, code) => {
    codeBlocks.push({ lang: String(lang || '').trim(), code });
    return `${CODE_TOKEN}${codeBlocks.length - 1}\u0000`;
  };

  let escaped = escapeHtml(text);
  escaped = escaped.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/g, (_m, lang, code) => stash(lang, code));
  // Unclosed fence while the model is still streaming.
  escaped = escaped.replace(/```([\w+#.-]*)[ \t]*\n([\s\S]*)$/g, (_m, lang, code) => stash(lang, code));

  const lines = escaped.split('\n');
  const out = [];
  const paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) {
      flushParagraph();
      i += 1;
      continue;
    }

    const tokenMatch = line.match(/\u0000CODE(\d+)\u0000/);
    if (tokenMatch) {
      flushParagraph();
      const block = codeBlocks[Number(tokenMatch[1])];
      const lang = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : '';
      const body = block.code.replace(/\n$/, '');
      out.push(`<pre>${lang}<code>${body}</code></pre>`);
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 1, 5);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      out.push('<hr />');
      i += 1;
      continue;
    }

    // Pipe table: a header row followed by a divider row.
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const body = rows
        .map((cells) => {
          const padded = header.map((_h, idx) => cells[idx] ?? '');
          return `<tr>${padded.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`;
        })
        .join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    // Blockquote: collect consecutive "> " lines (">" is escaped to &gt;).
    if (/^&gt;\s?/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(quoted.join(' '))}</blockquote>`);
      continue;
    }

    // Lists, possibly nested by indentation.
    if (/^([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (match) {
          items.push({
            indent: match[1].replace(/\t/g, '  ').length,
            ordered: /^\d/.test(match[2]),
            text: match[3],
          });
          i += 1;
          continue;
        }
        if (!lines[i].trim()) {
          // A blank line only continues the list when another item follows.
          const next = lines[i + 1];
          if (next && /^\s*([-*+]|\d+[.)])\s+/.test(next)) {
            i += 1;
            continue;
          }
        }
        break;
      }
      out.push(renderListLevel(items, 0, items.length));
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return out.join('');
}

/** One-line plain-text preview of a Markdown answer (used in tooltips). */
export function markdownToPlain(source, max = 240) {
  const flat = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_~`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
