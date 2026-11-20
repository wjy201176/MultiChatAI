/**
 * Small DOM/format helpers shared by the extension page views.
 * Nothing here depends on chrome.* — safe to unit-test in plain Node.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for safe interpolation into innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

let counter = 0;

/** Short, collision-resistant id with a readable prefix. */
export function uid(prefix = 'id') {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** Trailing-edge debounce. */
export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** Trailing-edge throttle, used to repaint a streaming answer at most N times/s. */
export function throttle(fn, wait = 80) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return (...args) => {
    const now = Date.now();
    const run = () => {
      last = Date.now();
      timer = null;
      const a = pendingArgs;
      pendingArgs = null;
      fn(...(a || args));
    };
    if (now - last >= wait) {
      pendingArgs = null;
      run();
    } else {
      pendingArgs = args;
      if (!timer) timer = setTimeout(run, wait - (now - last));
    }
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** "14:32" */
export function formatClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 1 → "1s", 3200 → "3.2s", 125000 → "2m 5s" */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * Human timestamp for the history list:
 *   same day   → "14:32"
 *   yesterday  → "Yesterday 14:32"
 *   same year  → "Nov 17"
 *   otherwise  → "Nov 17, 2024"
 */
export function formatHistoryTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  const diffDays = Math.round((today - day) / 86400000);
  if (diffDays === 0) return formatClock(ts);
  if (diffDays === 1) return `Yesterday ${formatClock(ts)}`;
  const month = d.toLocaleString(undefined, { month: 'short' });
  if (d.getFullYear() === new Date().getFullYear()) return `${month} ${d.getDate()}`;
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Full timestamp, used in tooltips / settings. */
export function formatFullTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

/** "1.2 KB" */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Trim a prompt into a short conversation topic. */
export function topicFromPrompt(text, max = 48) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return 'New chat';
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Clipboard write with a document.execCommand fallback. */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Ephemeral toast in the bottom-right stack. */
export function toast(message, kind = 'info', timeout = 3400) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

/** Auto-grow a textarea up to a max height. */
export function autoGrow(textarea, maxHeight = 220) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}

/** Stable per-string colour hue (used for provider dots when no colour exists). */
export function hueFromString(value) {
  let hash = 0;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash % 360;
}
