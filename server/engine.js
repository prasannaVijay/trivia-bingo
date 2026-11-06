import { randomInt } from 'node:crypto';

export const ROUND_CONFIG = Object.freeze({ revealMs: 3500, markMs: 8000, intermissionMs: 2500 });

export function shuffle(values) {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function completeLines(marks, size) {
  const result = [];
  for (let r = 0; r < size; r++) {
    const line = Array.from({ length: size }, (_, c) => r * size + c);
    if (line.every((index) => marks[index])) result.push(line);
  }
  for (let c = 0; c < size; c++) {
    const line = Array.from({ length: size }, (_, r) => r * size + c);
    if (line.every((index) => marks[index])) result.push(line);
  }
  const diagonal = Array.from({ length: size }, (_, i) => i * size + i);
  const antiDiagonal = Array.from({ length: size }, (_, i) => i * size + (size - i - 1));
  if (diagonal.every((index) => marks[index])) result.push(diagonal);
  if (antiDiagonal.every((index) => marks[index])) result.push(antiDiagonal);
  return result;
}

export function candidateSquares(marks) {
  const available = marks.flatMap((marked, index) => (marked ? [] : [index]));
  return shuffle(available).slice(0, 2);
}

export function averageCorrectMs(player) {
  return player.correctCount ? player.correctTimeTotal / player.correctCount : null;
}

export function sortOverall(players, size) {
  return [...players].sort((a, b) => {
    const aLines = completeLines(a.marks, size).length;
    const bLines = completeLines(b.marks, size).length;
    if (aLines !== bLines) return bLines - aLines;
    if (a.correctCount !== b.correctCount) return b.correctCount - a.correctCount;
    const aTime = averageCorrectMs(a) ?? Number.POSITIVE_INFINITY;
    const bTime = averageCorrectMs(b) ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.name.localeCompare(b.name);
  });
}

export function createLeaderboards(players, size, questionCount) {
  const list = [...players];
  const overall = sortOverall(list, size);
  const accuracy = [...list].sort((a, b) => b.correctCount - a.correctCount ||
    (averageCorrectMs(a) ?? Infinity) - (averageCorrectMs(b) ?? Infinity) || a.name.localeCompare(b.name));
  const minimumCorrect = Math.ceil(questionCount * 0.5);
  const fastest = list.filter((p) => p.correctCount >= minimumCorrect)
    .sort((a, b) => averageCorrectMs(a) - averageCorrectMs(b) || b.correctCount - a.correctCount || a.name.localeCompare(b.name));
  const map = (p) => ({
    id: p.id,
    name: p.name,
    lines: completeLines(p.marks, size).length,
    correct: p.correctCount,
    averageMs: averageCorrectMs(p),
    marks: p.marks.filter(Boolean).length,
  });
  return { overall: overall.map(map), accuracy: accuracy.map(map), fastest: fastest.map(map) };
}

export function selectQuestions(bank, selectedTopics, count) {
  const categoryPiles = new Map(selectedTopics.map((topic) => [topic, shuffle(bank.filter((q) => q.topic === topic))]));
  const available = [...categoryPiles.values()].reduce((sum, pile) => sum + pile.length, 0);
  if (available < count) throw new Error(`Only ${available} questions are available for those topics. Select more topics or fewer questions.`);
  const result = [];
  let topics = shuffle(selectedTopics);
  while (result.length < count) {
    const next = topics.shift();
    if (!next) { topics = shuffle(selectedTopics.filter((topic) => categoryPiles.get(topic).length)); continue; }
    const question = categoryPiles.get(next)?.pop();
    if (question) result.push(question);
    if (!topics.length) topics = shuffle(selectedTopics.filter((topic) => categoryPiles.get(topic).length));
  }
  return result;
}
