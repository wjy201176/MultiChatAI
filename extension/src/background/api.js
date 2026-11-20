/**
 * API-mode adapters.
 *
 * Three dialects cover every provider in the catalogue:
 *   openai    — POST {base}/chat/completions with SSE deltas
 *               (ChatGPT, DeepSeek, Grok, Perplexity, Qwen, Kimi, Mistral, Ollama)
 *   anthropic — POST {base}/messages with Messages-stream events
 *   gemini    — POST {base}/models/{model}:streamGenerateContent?alt=sse
 *
 * Each adapter returns the full answer text and calls `onDelta(fullTextSoFar)`
 * while streaming, so the UI is idempotent: a dropped/duplicated event can
 * never scramble the column.
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {string|null} hint actionable next step shown under the error
   */
  constructor(message, hint = null) {
    super(message);
    this.name = 'ProviderError';
    this.hint = hint;
  }
}

/* ────────────────────────────── helpers ────────────────────────────── */

/** Split "data:image/png;base64,AAA" into { mimeType, data }. */
function splitDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

/**
 * Combine the user prompt with attached files.
 * Text files are inlined; images are only kept when the API supports vision.
 */
function buildPrompt(prompt, attachments = [], vision = false) {
  let text = String(prompt || '');
  const texts = attachments.filter((item) => item && item.kind === 'text' && item.text);
  if (texts.length) {
    const blocks = texts
      .map((file) => `<file name="${file.name}">\n${file.text}\n</file>`)
      .join('\n\n');
    text += `\n\nAttached file contents:\n${blocks}`;
  }

  const allImages = attachments.filter((item) => item && item.kind === 'image' && item.dataUrl);
  if (allImages.length && !vision) {
    text += `\n\n(${allImages.length} image attachment${allImages.length === 1 ? '' : 's'} skipped: this model does not accept images over its API.)`;
  }

  return { text, images: vision ? allImages : [] };
}

/** @returns {AsyncGenerator<any>} parsed JSON payloads from an SSE body */
async function* iterateSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch {
          // Ignore partial/keep-alive frames.
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function tidy(value, max = 300) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function httpError(response, provider) {
  let detail = '';
  try {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || parsed?.message || parsed?.error || raw;
    } catch {
      detail = raw;
    }
  } catch {
    /* body already consumed or empty */
  }

  const status = response.status;
  const hints = {
    400: 'The provider rejected the request — check the model name and inputs.',
    401: 'Check that the API key is valid.',
    403: 'This key is not allowed to use that model.',
    404: 'The model name may be wrong or unavailable for your account.',
    429: 'Rate limit or quota exhausted for this key.',
    500: 'The provider is failing right now — retry in a moment.',
    503: 'The provider is temporarily unavailable — retry in a moment.',
  };

  return new ProviderError(
    `${provider.label} API error ${status}${detail ? `: ${tidy(detail)}` : ''}`,
    hints[status] || (status >= 500 ? hints[500] : null),
  );
}

/* ────────────────────────── message builders ────────────────────────── */

function openAiMessages(history, promptText, images) {
  /** @type {Array<any>} */
  const messages = [];
  for (const turn of history || []) {
    if (!turn || !turn.prompt) continue;
    messages.push({ role: 'user', content: turn.prompt });
    if (turn.answer) messages.push({ role: 'assistant', content: turn.answer });
  }

  if (images.length) {
    const parts = [{ type: 'text', text: promptText }];
    for (const image of images) {
      const parsed = splitDataUrl(image.dataUrl);
      if (!parsed) continue;
      parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    }
    messages.push({ role: 'user', content: parts });
  } else {
    messages.push({ role: 'user', content: promptText });
  }
  return messages;
}

function anthropicMessages(history, promptText, images) {
  /** @type {Array<any>} */
  const messages = [];
  for (const turn of history || []) {
    if (!turn || !turn.prompt) continue;
    messages.push({ role: 'user', content: turn.prompt });
    if (turn.answer) messages.push({ role: 'assistant', content: turn.answer });
  }

  if (images.length) {
    const blocks = [{ type: 'text', text: promptText }];
    for (const image of images) {
      const parsed = splitDataUrl(image.dataUrl);
      if (!parsed) continue;
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mimeType, data: parsed.data },
      });
    }
    messages.push({ role: 'user', content: blocks });
  } else {
    messages.push({ role: 'user', content: promptText });
  }
  return messages;
}

function geminiContents(history, promptText, images) {
  /** @type {Array<any>} */
  const contents = [];
  for (const turn of history || []) {
    if (!turn || !turn.prompt) continue;
    contents.push({ role: 'user', parts: [{ text: turn.prompt }] });
    if (turn.answer) contents.push({ role: 'model', parts: [{ text: turn.answer }] });
  }

  const parts = [{ text: promptText }];
  for (const image of images) {
    const parsed = splitDataUrl(image.dataUrl);
    if (!parsed) continue;
    parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
  }
  contents.push({ role: 'user', parts });
  return contents;
}

/* ────────────────────────────── dialects ────────────────────────────── */

async function runOpenAi({ api, provider, modelName, apiKey, history, promptText, images, signal, onDelta }) {
  const url = `${api.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey || 'none'}`,
    ...(api.headers || {}),
  };
  const body = {
    model: modelName,
    messages: openAiMessages(history, promptText, images),
    stream: true,
  };

  let text = '';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await httpError(response, provider);

    for await (const payload of iterateSse(response)) {
      if (payload?.error) {
        throw new ProviderError(payload.error.message || `${provider.label} returned an error.`);
      }
      const delta = payload?.choices?.[0]?.delta?.content ?? payload?.choices?.[0]?.text;
      const chunk =
        typeof delta === 'string'
          ? delta
          : Array.isArray(delta)
            ? delta.map((part) => part?.text || '').join('')
            : '';
      if (chunk) {
        text += chunk;
        onDelta(text);
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      error.partialText = text;
      throw error;
    }
    throw error;
  }

  if (!text.trim()) {
    throw new ProviderError(
      `${provider.label} returned an empty answer.`,
      'Try again, or check that the model name is available for your key.',
    );
  }
  return text;
}

async function runAnthropic({ api, provider, modelName, apiKey, history, promptText, images, signal, onDelta }) {
  const url = `${api.baseUrl.replace(/\/+$/, '')}/messages`;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...(api.headers || {}),
  };
  const body = {
    model: modelName,
    max_tokens: 4096,
    stream: true,
    messages: anthropicMessages(history, promptText, images),
  };

  let text = '';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await httpError(response, provider);

    for await (const payload of iterateSse(response)) {
      if (payload?.type === 'error') {
        throw new ProviderError(payload?.error?.message || 'Claude returned an error.');
      }
      if (payload?.type === 'content_block_delta') {
        const chunk = payload?.delta?.text;
        if (chunk) {
          text += chunk;
          onDelta(text);
        }
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      error.partialText = text;
      throw error;
    }
    throw error;
  }

  if (!text.trim()) {
    throw new ProviderError(
      'Claude returned an empty answer.',
      'Check the model name; some models need access enabled on your account.',
    );
  }
  return text;
}

async function runGemini({ api, provider, modelName, apiKey, history, promptText, images, signal, onDelta }) {
  const base = api.baseUrl.replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(modelName)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: geminiContents(history, promptText, images),
    generationConfig: { maxOutputTokens: 8192 },
  };

  let text = '';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(api.headers || {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await httpError(response, provider);

    for await (const payload of iterateSse(response)) {
      if (payload?.error) {
        throw new ProviderError(payload.error.message || 'Gemini returned an error.');
      }
      const parts = payload?.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) continue;
      const chunk = parts.map((part) => part?.text || '').join('');
      if (chunk) {
        text += chunk;
        onDelta(text);
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      error.partialText = text;
      throw error;
    }
    throw error;
  }

  if (!text.trim()) {
    throw new ProviderError(
      'Gemini returned an empty answer.',
      'Check the model name (for example gemini-2.5-flash) and your API key quota.',
    );
  }
  return text;
}

/* ────────────────────────────── public API ────────────────────────────── */

/**
 * @param {Object} options
 * @param {any} options.model       stored model entry
 * @param {any} options.provider    provider catalogue entry
 * @param {string} options.apiKey
 * @param {string} options.prompt
 * @param {Array} options.attachments
 * @param {Array<{prompt:string, answer:string}>} options.history
 * @param {AbortSignal} options.signal
 * @param {(text: string) => void} options.onDelta
 * @returns {Promise<string>} the full answer
 */
export async function runApiModel({
  model,
  provider,
  apiKey,
  prompt,
  attachments = [],
  history = [],
  signal,
  onDelta,
}) {
  const api = provider.api;
  if (!api) {
    throw new ProviderError(
      `${provider.label} has no API mode.`,
      'Use “browser session” mode for this provider instead.',
    );
  }
  if (!apiKey && !api.keyOptional) {
    throw new ProviderError(
      `No API key saved for ${model.label || provider.label}.`,
      'Open Settings → Models, paste a key and press Save key.',
    );
  }

  const modelName = (model.modelName || api.defaultModel || '').trim();
  if (!modelName) {
    throw new ProviderError(
      `No model name set for ${provider.label}.`,
      'Open Settings → Models and enter a model name.',
    );
  }

  const { text: promptText, images } = buildPrompt(prompt, attachments, Boolean(api.vision));

  if (api.kind === 'openai') {
    return runOpenAi({ api, provider, modelName, apiKey, history, promptText, images, signal, onDelta });
  }
  if (api.kind === 'anthropic') {
    return runAnthropic({ api, provider, modelName, apiKey, history, promptText, images, signal, onDelta });
  }
  if (api.kind === 'gemini') {
    return runGemini({ api, provider, modelName, apiKey, history, promptText, images, signal, onDelta });
  }

  throw new ProviderError(`Unsupported API dialect: ${api.kind}`);
}

/**
 * Minimal round-trip used by the "Test" button in Settings.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function testApiModel({ model, provider, apiKey }) {
  const api = provider && provider.api;
  if (!api) return { ok: false, message: 'This provider has no API mode.' };
  if (!apiKey && !api.keyOptional) return { ok: false, message: 'No API key saved yet.' };

  const modelName = (model.modelName || api.defaultModel || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    let response;
    if (api.kind === 'anthropic') {
      response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...(api.headers || {}),
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        }),
        signal: controller.signal,
      });
    } else if (api.kind === 'gemini') {
      const base = api.baseUrl.replace(/\/+$/, '');
      response = await fetch(
        `${base}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
            generationConfig: { maxOutputTokens: 16 },
          }),
          signal: controller.signal,
        },
      );
    } else {
      response = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey || 'none'}`,
          ...(api.headers || {}),
        },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
          max_tokens: 16,
        }),
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      const error = await httpError(response, provider);
      return { ok: false, message: tidy(error.message, 160) };
    }
    return { ok: true, message: `Connected · ${modelName}` };
  } catch (error) {
    const message =
      error?.name === 'AbortError' ? 'Timed out after 30s.' : tidy(error?.message || error, 160);
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}
