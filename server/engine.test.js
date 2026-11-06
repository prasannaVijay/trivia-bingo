import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateSquares, completeLines, createLeaderboards, selectQuestions } from './engine.js';

test('counts all rows, columns and diagonals without double counting', () => {
  const filled = Array(16).fill(true);
  assert.equal(completeLines(filled, 4).length, 10);
  const top = Array(16).fill(false);
  for (const i of [0, 1, 2, 3]) top[i] = true;
  assert.equal(completeLines(top, 4).length, 1);
});

test('candidates only select unique unmarked cells, including near-full board', () => {
  const almostFull = Array(16).fill(true);
  almostFull[3] = false;
  assert.deepEqual(candidateSquares(almostFull), [3]);
  assert.deepEqual(candidateSquares(Array(16).fill(true)), []);
  const two = candidateSquares(Array(16).fill(false));
  assert.equal(new Set(two).size, 2);
});

test('overall awards prioritize lines, then correctness, then speed', () => {
  const p = (id, marks, correctCount, correctTimeTotal) => ({ id, name: id, marks, correctCount, correctTimeTotal });
  const firstLine = [true, true, true, true, ...Array(12).fill(false)];
  const oneShort = [true, true, true, false, ...Array(12).fill(false)];
  const board = createLeaderboards([
    p('many-correct', oneShort, 12, 24000),
    p('line', firstLine, 7, 35000),
    p('fast', oneShort, 12, 12000),
  ], 4, 12);
  assert.deepEqual(board.overall.map((r) => r.id), ['line', 'fast', 'many-correct']);
  assert.deepEqual(board.fastest.map((r) => r.id), ['fast', 'many-correct', 'line']);
});

test('question selection is unique and rejects insufficient pool', () => {
  const bank = [{ id: 'a', topic: 'x' }, { id: 'b', topic: 'y' }, { id: 'c', topic: 'x' }];
  const chosen = selectQuestions(bank, ['x', 'y'], 3);
  assert.equal(new Set(chosen.map((q) => q.id)).size, 3);
  assert.throws(() => selectQuestions(bank, ['y'], 2), /Only 1/);
});
