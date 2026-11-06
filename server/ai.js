import { randomUUID } from 'node:crypto';
import { shuffle } from './engine.js';

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'];

const tidy = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const normalized = (value) => tidy(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function validateEditableQuestion(raw, allowedTopics) {
  if (!raw || typeof raw !== 'object') throw new Error('Question is missing.');
  const prompt = tidy(raw.prompt);
  const options = Array.isArray(raw.options) ? raw.options.map(tidy) : [];
  const topic = tidy(raw.topic);
  const difficulty = tidy(raw.difficulty);
  const explanation = tidy(raw.explanation);
  if (prompt.length < 12 || prompt.length > 260) throw new Error('Question must be between 12 and 260 characters.');
  if (!allowedTopics.includes(topic)) throw new Error('Question has an invalid topic.');
  if (!['easy', 'medium', 'hard'].includes(difficulty)) throw new Error('Question difficulty must be easy, medium, or hard.');
  if (options.length !== 4 || options.some((option) => option.length < 1 || option.length > 130))
    throw new Error('Every question needs four non-empty answer choices.');
  if (new Set(options.map(normalized)).size !== 4) throw new Error('All four answers must be different.');
  if (!Number.isInteger(raw.correctIndex) || raw.correctIndex < 0 || raw.correctIndex > 3)
    throw new Error('Select exactly one correct answer.');
  if (explanation.length < 8 || explanation.length > 450) throw new Error('Add a brief explanation (8–450 characters).');
  return { id: typeof raw.id === 'string' ? raw.id : randomUUID(), topic, difficulty, prompt, options, correctIndex: raw.correctIndex, explanation };
}

function convertGeneratedQuestion(raw, allowedTopics) {
  if (!Array.isArray(raw?.incorrectAnswers) || raw.incorrectAnswers.length !== 3)
    throw new Error('AI produced a question without three distractors.');
  const correct = tidy(raw.correctAnswer);
  const options = shuffle([correct, ...raw.incorrectAnswers.map(tidy)]);
  return validateEditableQuestion({
    id: randomUUID(), topic: raw.topic, difficulty: raw.difficulty,
    prompt: raw.prompt, options, correctIndex: options.indexOf(correct), explanation: raw.explanation,
  }, allowedTopics);
}

export function validateQuestionPack(questions, allowedTopics, expectedCount) {
  if (!Array.isArray(questions) || questions.length !== expectedCount)
    throw new Error(`Expected ${expectedCount} questions, received ${Array.isArray(questions) ? questions.length : 'an invalid response'}.`);
  const list = questions.map((q) => validateEditableQuestion(q, allowedTopics));
  if (new Set(list.map((q) => normalized(q.prompt))).size !== list.length)
    throw new Error('Question pack contains duplicates. Regenerate or edit the repeated questions.');
  return list;
}

function schema(topics) {
  return {
    type: 'object', additionalProperties: false, required: ['questions'],
    properties: { questions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['topic', 'difficulty', 'prompt', 'correctAnswer', 'incorrectAnswers', 'explanation'],
        properties: {
          topic: { type: 'string', enum: topics },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
          prompt: { type: 'string' },
          correctAnswer: { type: 'string' },
          incorrectAnswers: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
        },
      },
    } },
  };
}

export async function generateQuestions({ topics, difficulty, count, excludePrompts = [],
  apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  endpoint = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses', fetchImpl = fetch }) {
  if (!apiKey) throw new Error('OpenAI API key is missing. Add OPENAI_API_KEY to the server .env file and restart.');
  if (!Array.isArray(topics) || !topics.length || topics.some((topic) => typeof topic !== 'string'))
    throw new Error('Choose at least one topic.');
  if (!DIFFICULTIES.includes(difficulty) || !Number.isInteger(count) || count < 1 || count > 20)
    throw new Error('Invalid difficulty or question count.');

  const difficultyInstruction = difficulty === 'mixed'
    ? 'Use a balanced mix: roughly 30% easy, 50% medium, 20% hard.'
    : `Every question must be ${difficulty} difficulty.`;
  const avoid = excludePrompts.slice(0, 30).map((prompt) => `- ${tidy(prompt).slice(0, 220)}`).join('\n');
  const instructions = [
    `Generate exactly ${count} unique, family-friendly, four-option trivia questions.`,
    `Allowed topic IDs: ${topics.join(', ')}. Use only these exact IDs; balance questions across them.`,
    difficultyInstruction,
    'Easy means widely familiar facts. Medium means informed general knowledge. Hard means challenging but fair facts.',
    'Each question must have precisely one unambiguously correct answer and three credible but clearly incorrect distractors.',
    'Avoid time-sensitive records, disputed facts, trick questions, giveaways in answer wording, and near-duplicate questions.',
    'Make prompts concise and screen-readable. Explanations must be one short factual sentence.',
    'Answer choices should have similar style and length. The correct answer should not always be the longest.',
    avoid ? `Do not reuse or closely paraphrase these questions:\n${avoid}` : '',
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        input: [
          { role: 'system', content: 'You create accurate, fun trivia for live group games. Respond with the specified structured data.' },
          { role: 'user', content: instructions },
        ],
        max_output_tokens: Math.min(9000, 900 + count * 400),
        text: { format: { type: 'json_schema', name: 'trivia_question_pack', strict: true, schema: schema(topics) } },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error('Question generation timed out. Please retry.');
    throw new Error('Cannot reach OpenAI. Check your internet connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('OpenAI rejected the API key. Check OPENAI_API_KEY in .env.');
    if (response.status === 429) throw new Error('OpenAI rate limit or quota reached. Try again later.');
    throw new Error(`OpenAI question generation failed (HTTP ${response.status}).`);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('OpenAI returned an unreadable response.'); }
  const outputText = typeof result.output_text === 'string' ? result.output_text :
    result.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text).join('');
  if (!outputText) throw new Error('OpenAI returned no questions. Retry the generation.');
  let parsed;
  try { parsed = JSON.parse(outputText); }
  catch { throw new Error('OpenAI returned invalid structured question data. Retry the generation.'); }
  if (!Array.isArray(parsed.questions)) throw new Error('OpenAI response is missing its question list.');
  const questions = parsed.questions.map((q) => convertGeneratedQuestion(q, topics));
  return validateQuestionPack(questions, topics, count);
}
