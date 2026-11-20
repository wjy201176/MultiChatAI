/**
 * Embedding rules (declarativeNetRequest).
 *
 * Provider chat pages refuse to be framed — they send `X-Frame-Options` and/or
 * `Content-Security-Policy: frame-ancestors`. To show a provider's own (free)
 * web chat *inside a column*, the extension removes those two framing headers
 * from the response.
 *
 * The rules are deliberately scoped: `initiatorDomains: [chrome.runtime.id]`
 * means the headers are only stripped for requests started by **this
 * extension** (the column iframes). Websites embedding the same provider are
 * still blocked, so the protection is not weakened for anyone else.
 *
 * Verified in scripts/probe-embed.mjs (control blocked, scoped rules framed).
 */

import { PROVIDERS } from '../shared/providers.js';

const STRIP_HEADERS = [
  { header: 'x-frame-options', operation: 'remove' },
  { header: 'content-security-policy', operation: 'remove' },
  { header: 'content-security-policy-report-only', operation: 'remove' },
];

/** Hostnames of every provider that can be embedded. */
export function embeddableHosts() {
  const hosts = new Set();
  for (const provider of Object.values(PROVIDERS)) {
    if (!provider.web) continue;
    for (const host of provider.web.hosts) hosts.add(host);
  }
  return [...hosts];
}

/**
 * Build the dynamic rules. One rule per host, sub_frame requests only, and only
 * when the initiator is this extension.
 */
export function buildEmbedRules(extensionId) {
  return embeddableHosts().map((host, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      // Framing headers on the way out…
      responseHeaders: STRIP_HEADERS,
      // …and the extension origin on the way in: some providers sit behind a WAF
      // (DeepSeek's CloudFront, for one) that answers `Referer: chrome-extension://`
      // with 403 "Request blocked". A frame navigation needs no referrer anyway.
      requestHeaders: [{ header: 'referer', operation: 'remove' }],
    },
    condition: {
      // `|` anchors the match at the URL start, so host suffixes cannot match.
      urlFilter: `|https://${host}`,
      resourceTypes: ['sub_frame'],
      initiatorDomains: [extensionId],
    },
  }));
}

/**
 * Install (or refresh) the rules. Safe to call on every worker start: existing
 * dynamic rules are replaced, never duplicated.
 */
export async function ensureEmbedRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const rules = buildEmbedRules(chrome.runtime.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: rules,
    });
    return rules.length;
  } catch (error) {
    console.warn('[MultiChatAI] could not install embed rules', error);
    return 0;
  }
}

/** How many embed rules are live (used by the settings panel). */
export async function embedRuleCount() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.length;
  } catch {
    return 0;
  }
}
