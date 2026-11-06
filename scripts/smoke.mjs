import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { QUESTION_BANK } from '../server/questions.js';

const port = 35505;
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'trivia-bingo-smoke-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), JOIN_BASE_URL: base, TRIVIA_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const sockets = [];

const waitForReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Server did not start')), 8000);
  server.stdout.on('data', (buf) => {
    if (String(buf).includes('Trivia Bingo is ready')) { clearTimeout(timer); resolve(); }
  });
  server.stderr.on('data', (buf) => process.stderr.write(buf));
  server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited with code ${code}`)); });
});

function connect() {
  const socket = io(base, { transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err, response) => err ? reject(err) : resolve(response));
  });
}

function waitForPhase(socket, phase, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('game:state', handler); reject(new Error(`Timed out waiting for phase ${phase}`)); }, timeoutMs);
    function handler(state) {
      if (state.phase === phase) { clearTimeout(timer); socket.off('game:state', handler); resolve(state); }
    }
    socket.on('game:state', handler);
  });
}

try {
  await waitForReady;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  const response = await fetch(`${base}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topics: ['science', 'general'], timerSeconds: 15, questionCount: 10, boardSize: 4 }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  const host = await connect();
  const hostLobbyPromise = waitForPhase(host, 'lobby');
  assert.equal((await request(host, 'host:attach', { code: created.code, token: created.hostToken })).ok, true);
  const hostLobby = await hostLobbyPromise;
  assert.match(hostLobby.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal(hostLobby.joinUrl, `${base}/join/${created.code}`);

  const player = await connect();
  const playerLobbyPromise = waitForPhase(player, 'lobby');
  const join = await request(player, 'player:join', { code: created.code, name: 'Test Player' });
  assert.equal(join.ok, true);
  await playerLobbyPromise;
  const hostQuestionPromise = waitForPhase(host, 'question');
  const playerQuestionPromise = waitForPhase(player, 'question');
  assert.equal((await request(host, 'host:start', {})).ok, true);
  const hostQuestion = await hostQuestionPromise;
  const playerQuestion = await playerQuestionPromise;
  assert.equal(playerQuestion.question.correctIndex, undefined, 'Correct answers must not leak before reveal');
  assert.equal(hostQuestion.question.correctIndex, undefined, 'Host screen must not leak correct answers');

  const originalQuestion = QUESTION_BANK.find((q) => q.id === playerQuestion.question.id);
  const correctIndex = playerQuestion.question.options.indexOf(originalQuestion.options[originalQuestion.correctIndex]);
  assert.equal((await request(player, 'player:answer', { choice: correctIndex })).ok, true);
  assert.equal((await request(player, 'player:answer', { choice: correctIndex })).ok, false, 'Duplicate answers must be rejected');

  const markedPhase = await waitForPhase(player, 'mark', 24000);
  assert.equal(markedPhase.me.answerCorrect, true);
  assert.equal(markedPhase.me.candidates.length, 2);
  const markIndex = markedPhase.me.candidates[0];
  assert.equal((await request(player, 'player:mark', { index: markIndex })).ok, true);
  assert.equal((await request(player, 'player:mark', { index: markIndex })).ok, false, 'Duplicate marks must be rejected');
  const hostFinishedPromise = waitForPhase(host, 'finished');
  const playerFinishedPromise = waitForPhase(player, 'finished');
  assert.equal((await request(host, 'host:end', {})).ok, true);
  const finalHost = await hostFinishedPromise;
  const finalPlayer = await playerFinishedPromise;
  assert.equal(finalPlayer.me.marks.filter(Boolean).length, 1);
  assert.equal(finalHost.leaderboard.accuracy[0].correct, 1);
  assert.equal(finalHost.leaderboard.overall[0].name, 'Test Player');
  console.log('✓ Local server, room creation, QR, join, question, answer, anti-cheat, marking, and awards all passed.');
} finally {
  for (const socket of sockets) socket.disconnect();
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}
