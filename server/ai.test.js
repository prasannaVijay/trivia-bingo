import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateQuestions, validateEditableQuestion, validateQuestionPack } from './ai.js';

const sample = {
  topic: 'science', difficulty: 'easy', prompt: 'Which planet is called the Red Planet?',
  correctAnswer: 'Mars', incorrectAnswers: ['Venus', 'Jupiter', 'Mercury'],
  explanation: 'Mars appears red because of iron oxide on its surface.',
};

test('OpenAI request uses strict schema, returns valid shuffled questions without leaking keys', async () => {
  let captured;
  const generated = await generateQuestions({
    topics: ['science'], difficulty: 'easy', count: 1, apiKey: 'fake-test-key',
    fetchImpl: async (_url, options) => {
      captured = { auth: options.headers.Authorization, body: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ questions: [sample] }) }] }] }) };
    },
  });
  assert.equal(captured.auth, 'Bearer fake-test-key');
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(captured.body.store, false);
  assert.equal(generated.length, 1);
  assert.equal(generated[0].options[generated[0].correctIndex], 'Mars');
  assert.equal(generated[0].topic, 'science');
});

test('rejects repeated answer options and ambiguous editing', () => {
  assert.throws(() => validateEditableQuestion({
    prompt: sample.prompt, topic: 'science', difficulty: 'easy', explanation: sample.explanation,
    options: ['Mars', 'Mars', 'Venus', 'Jupiter'], correctIndex: 0,
  }, ['science']), /different/);
});

test('rejects duplicate questions before approval', () => {
  const q = validateEditableQuestion({
    prompt: sample.prompt, topic: 'science', difficulty: 'easy', explanation: sample.explanation,
    options: ['Mars', 'Venus', 'Jupiter', 'Mercury'], correctIndex: 0,
  }, ['science']);
  assert.throws(() => validateQuestionPack([q, q], ['science'], 2), /duplicates/);
});

test('handles missing API keys and quota errors without exposing server secrets', async () => {
  await assert.rejects(generateQuestions({ topics: ['science'], difficulty: 'easy', count: 1, apiKey: '' }), /API key is missing/);
  await assert.rejects(generateQuestions({ topics: ['science'], difficulty: 'easy', count: 1, apiKey: 'fake', fetchImpl: async () => ({ ok: false, status: 429 }) }), /quota/);
});
