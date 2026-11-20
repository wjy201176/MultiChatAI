/**
 * The question MultiChatAI asks one model: “here are the other answers, write the
 * comparison”.
 *
 * Pure text in → text out (no `chrome.*`, no DOM), so the exact prompt can be
 * pinned down in a unit test. The app renders whatever the model writes as
 * Markdown; this module only decides what it is asked and how much of each answer
 * it gets to see.
 */

/** How much of one answer is handed over. */
export const PER_ANSWER_LIMIT = 4000;
/** Upper bound for the whole answer section, so a long chat still fits. */
export const TOTAL_LIMIT = 32000;

const CUT = '\n… [answer cut here]';

function truncate(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return { text: value, truncated: false };
  const cut = value.slice(0, limit);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  const body = at > limit * 0.5 ? cut.slice(0, at + 1) : cut;
  return { text: `${body.trimEnd()}${CUT}`, truncated: true };
}

/**
 * Build the prompt.
 *
 * @param {{
 *   question?: string,           // the turn's own question (round scope)
 *   scope?: 'round'|'chat',
 *   sources?: Array<{key:string, name:string, text:string, modeLabel?:string}>,
 *   perAnswerLimit?: number,
 *   totalLimit?: number,
 * }} options
 * @returns {{prompt:string, models:Array<{key:string,name:string,chars:number,truncated:boolean,answered:boolean}>,
 *            answeredCount:number, totalChars:number, share:number}}
 */
export function buildSummaryPrompt({
  question = '',
  scope = 'round',
  sources = [],
  perAnswerLimit = PER_ANSWER_LIMIT,
  totalLimit = TOTAL_LIMIT,
} = {}) {
  const list = sources.map((source) => ({
    key: String(source.key || ''),
    name: String(source.name || 'Model'),
    text: String(source.text || '').trim(),
    modeLabel: String(source.modeLabel || ''),
  }));

  const answering = list.filter((source) => source.text);
  // Every answering model gets the same share, so one long answer cannot crowd
  // the others out of the comparison.
  const share = Math.max(
    400,
    Math.min(perAnswerLimit, Math.floor(totalLimit / Math.max(1, answering.length))),
  );

  const models = list.map((source) => {
    if (!source.text) return { key: source.key, name: source.name, chars: 0, truncated: false, answered: false };
    const cut = truncate(source.text, share);
    return {
      key: source.key,
      name: source.name,
      chars: cut.text.length,
      truncated: cut.truncated,
      answered: true,
    };
  });

  const blocks = list.map((source, index) => {
    const where = source.modeLabel ? `, ${source.modeLabel}` : '';
    const head = `=== ${index + 1}. ${source.name}${where} ===`;
    if (!source.text) return `${head}\n(no readable answer from this model on this question)`;
    return `${head}\n${truncate(source.text, share).text}`;
  });

  const names = list.map((source) => source.name);
  const exampleCells = names.map(() => '<that model’s position, under 20 words>');
  const tableHead = `| Item | ${names.join(' | ')} |`;
  const tableRule = `| --- | ${names.map(() => '---').join(' | ')} |`;
  const tableExample = `| <the item> | ${exampleCells.join(' | ')} |`;

  const intro =
    scope === 'chat'
      ? 'A person keeps several AI models side by side in one window and now wants the whole conversation summarised.'
      : 'A person keeps several AI models side by side in one window and asked them all the same question.';

  const subject = question
    ? `THE QUESTION\n${question}`
    : 'THE CONVERSATION\nSeveral questions in one thread. Each answer below is labelled with its turn (Q = question, A = that model’s answer).';

  const rules = [
    '- “Agreed” holds only points every answering model makes. If only some models make a point, or they disagree, it belongs in the table instead.',
    '- One row per item where the answers disagree, or where only some models address it.',
    `- One column per model, in this order: ${names.join(', ')}. Write — in a cell when that model does not mention the item.`,
    '- Keep every cell under 20 words and factual. Quote numbers and names exactly as the answers give them.',
    '- Do not add a preamble, a closing remark, sources or links: the window adds those itself.',
  ];
  const missing = models.filter((model) => !model.answered).map((model) => model.name);
  if (missing.length) {
    rules.push(
      `- ${missing.join(', ')} produced no readable answer: leave that column out of the comparison, keep the other columns in the order above.`,
    );
  }

  const prompt = [
    intro,
    '',
    subject,
    '',
    'THE ANSWERS',
    blocks.join('\n\n'),
    '',
    'WHAT TO WRITE',
    'Reply with Markdown in exactly this shape, and nothing else:',
    '',
    '### Agreed',
    '- <a point that every answer makes, one short line each>',
    '',
    '### Where they differ',
    '',
    tableHead,
    tableRule,
    tableExample,
    '',
    'RULES',
    ...rules,
  ].join('\n');

  return {
    prompt,
    models,
    answeredCount: models.filter((model) => model.answered).length,
    totalChars: models.reduce((sum, model) => sum + model.chars, 0),
    share,
  };
}

/** The “each model's own chat” links, as Markdown (used by Copy). */
export function summaryLinksMarkdown(models = []) {
  const lines = ['### Each model’s own chat', ''];
  for (const model of models) {
    lines.push(
      model && model.threadUrl
        ? `- ${model.name}: ${model.threadUrl}`
        : `- ${model && model.name ? model.name : 'Model'}: no saved link`,
    );
  }
  return lines.join('\n');
}

/**
 * Markdown for the Copy button: the model's own summary, then the links this
 * window knows and the model could not.
 */
export function summaryCopyText({ text = '', modelName = 'a model', models = [] } = {}) {
  const body = String(text || '').trim();
  return [`## Summary by ${modelName}`, '', body, '', summaryLinksMarkdown(models)].join('\n');
}
