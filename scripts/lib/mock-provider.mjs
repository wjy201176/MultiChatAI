/**
 * Mock OpenAI-compatible provider used by the browser tests.
 *
 * Listens on 127.0.0.1:11434 (the base URL of the built-in "Ollama" provider) and
 * implements POST /v1/chat/completions with real SSE streaming, so the extension
 * exercises its actual openai-dialect adapter end to end.
 *
 * Model name "slow-model" streams one character every ~150 ms, which is used to
 * test the Stop button.
 */

import http from 'node:http';

export const MOCK_PORT = 11434;

/**
 * Answers for comparison prompts: the first two lines are identical across the
 * models (something the summariser can call “shared”), the rest differ per model
 * (something its table can line up).
 */
const COMPARISON = {
  cats: {
    match: /cats and dogs/i,
    shared: [
      'Latency matters more than raw quality in a chat pane.',
      'Watch the cost per token before you commit.',
    ],
    byModel: {
      'llama3.2': [
        'Cats are independent and quiet, which suits a small flat.',
        'Dogs need a walk every single day.',
      ],
      'qwen2.5': [
        'Cats are affectionate when they choose to be.',
        'Dogs are eager to please everyone in the house.',
      ],
    },
  },
  rag: {
    match: /rag|fine-?tun/i,
    shared: [
      'RAG keeps the facts in an index you can refresh without retraining.',
      'Fine-tuning changes tone and format more reliably than retrieval does.',
    ],
    byModel: {
      'llama3.2': [
        'Start with retrieval for policies that change every week.',
        'Plan two weeks of data cleanup before any training run.',
      ],
      'qwen2.5': [
        'Retrieval is the cheaper half: keep documents in an index you can correct daily.',
        'Fine-tune only for tone, never for facts that expire every quarter.',
      ],
      mistral: [
        'Measure retrieval quality first, because bad chunks defeat any fine-tune.',
        'Keep a prompt-only baseline so the gain over it is provable.',
      ],
    },
  },
};

/** What the mock “summarising model” writes, per topic, for the models it knows. */
const SUMMARY_FACTS = {
  cats: {
    agreed: [
      'Latency matters more than raw quality in a chat pane.',
      'Watch the cost per token before you commit.',
    ],
    rows: [
      ['Cats', { 'llama3.2': 'independent and quiet, suits a small flat', 'qwen2.5': 'affectionate on their own terms', mistral: 'quiet and low-maintenance' }],
      ['Dogs', { 'llama3.2': 'need a walk every single day', 'qwen2.5': 'eager to please everyone in the house', mistral: 'happier with a garden' }],
    ],
  },
  rag: {
    agreed: [
      'RAG keeps the facts in an index you can refresh without retraining.',
      'Fine-tuning changes tone and format more reliably than retrieval does.',
    ],
    rows: [
      ['Retrieval', { 'llama3.2': 'start with it where policy changes weekly', 'qwen2.5': 'the cheaper half; correct documents daily', mistral: 'measure chunk quality before anything else' }],
      ['Fine-tuning', { 'llama3.2': 'plan two weeks of data cleanup first', 'qwen2.5': 'for tone only, never for facts', mistral: 'budget one GPU week for the first adapter' }],
    ],
  },
};

/** A summary prompt carries the original question inside the answers section. */
function summaryAnswerFor(promptText) {
  const head = promptText.match(/^\| Item \| (.+) \|$/m);
  const columns = head ? head[1].split(' | ').map((name) => name.trim()) : ['Model A', 'Model B'];
  const topic = /cats and dogs/i.test(promptText) ? SUMMARY_FACTS.cats : SUMMARY_FACTS.rag;

  const lines = ['### Agreed', ''];
  for (const point of topic.agreed) lines.push(`- ${point}`);
  lines.push('', '### Where they differ', '');
  lines.push(`| Item | ${columns.join(' | ')} |`);
  lines.push(`| --- | ${columns.map(() => '---').join(' | ')} |`);
  for (const [label, cells] of topic.rows) {
    const row = columns.map((name) => cells[name] || '—');
    lines.push(`| ${label} | ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

function answerFor(model, promptText) {
  const label = String(model || 'mock');
  // The summary request must be recognised before any topic branch: its prompt
  // quotes the original question, so the comparison fixtures would match too.
  if (/WHAT TO WRITE/.test(promptText) && /### Agreed/.test(promptText)) {
    return summaryAnswerFor(promptText);
  }
  if (label === 'slow-model') {
    return (
      `**Slow model** thinking about: ${promptText}\n\n` +
      'This answer is intentionally streamed very slowly so the Stop button can be tested. '.repeat(2)
    );
  }
  for (const topic of Object.values(COMPARISON)) {
    if (!topic.match.test(promptText)) continue;
    const own = topic.byModel[label];
    if (!own) continue;
    const lines = [...topic.shared, ...own];
    return `**${label}** — answer to: ${promptText}\n\n${lines.map((line) => `- ${line}`).join('\n')}`;
  }
  return (
    `**${label}** — answer to: ${promptText}\n\n` +
    '- bullet one\n' +
    '- bullet two\n\n' +
    '```js\nconsole.log("mock");\n```'
  );
}

export function startMockProvider({ port = MOCK_PORT } = {}) {
  const requests = [];

  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      response.end();
      return;
    }

    if (!request.url.startsWith('/v1/chat/completions')) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        payload = {};
      }
      const record = { ...payload, aborted: false };
      requests.push(record);

      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const promptText =
        typeof lastUser?.content === 'string'
          ? lastUser.content
          : (lastUser?.content || []).map((part) => part.text || '').join(' ');

      if (!payload.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
        return;
      }

      const answer = answerFor(payload.model, promptText);
      const slow = payload.model === 'slow-model';
      const delay = slow ? 150 : 20;
      const chunks = slow ? [...answer] : answer.match(/[\s\S]{1,22}/g) || [];

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      let closed = false;
      // NOTE: IncomingMessage 'close' fires after a normal request body end in
      // modern Node, so client disconnect must be detected on the response.
      response.on('close', () => {
        if (!response.writableEnded) {
          closed = true;
          record.aborted = true;
        }
      });

      let index = 0;
      const tick = () => {
        if (closed) return;
        if (index >= chunks.length) {
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[index] } }] })}\n\n`);
        index += 1;
        setTimeout(tick, delay);
      };
      tick();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        port,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
