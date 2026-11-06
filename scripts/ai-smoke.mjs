import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { io } from 'socket.io-client';

const serverPort = 35505;
const modelPort = 35506;
const base = `http://127.0.0.1:${serverPort}`;
let modelCalls = 0;
const modelServer = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const instructions = request.input[1].content;
  const count = Number(instructions.match(/Generate exactly (\d+)/)[1]);
  const topics = instructions.match(/Allowed topic IDs: ([^.]+)/)[1].split(',').map((t) => t.trim());
  modelCalls += 1;
  const questions = Array.from({ length: count }, (_, i) => ({
    topic: topics[i % topics.length], difficulty: 'medium',
    prompt: `For round ${modelCalls}, which answer matches trivia item number ${i + 1}?`,
    correctAnswer: `Correct ${modelCalls}-${i}`, incorrectAnswers: [`Wrong A-${i}`, `Wrong B-${i}`, `Wrong C-${i}`],
    explanation: `The correct answer is item ${i + 1} for this example.`,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ questions }) }] }] }));
});
await new Promise((resolve) => modelServer.listen(modelPort, '127.0.0.1', resolve));

const gameServer = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(serverPort), JOIN_BASE_URL: base, OPENAI_API_KEY: 'mock-test-only', OPENAI_API_URL: `http://127.0.0.1:${modelPort}/v1/responses` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const sockets = [];

function waitForState(socket, condition, label, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('game:state', onState); reject(new Error(`Timed out waiting for ${label}`)); }, timeout);
    function onState(state) {
      if (condition(state)) { clearTimeout(timer); socket.off('game:state', onState); resolve(state); }
    }
    socket.on('game:state', onState);
  });
}

function request(socket, event, data) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(event, data, (err, response) => err ? reject(err) : resolve(response)));
}

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 8000);
    gameServer.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Trivia Bingo is ready')) { clearTimeout(timer); resolve(); }
    });
    gameServer.stderr.on('data', (chunk) => process.stderr.write(chunk));
    gameServer.on('exit', (code) => reject(new Error(`Server exited ${code}`)));
  });

  const createdResponse = await fetch(`${base}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topics: ['science', 'general'], questionCount: 10, timerSeconds: 15, boardSize: 4, questionSource: 'ai', difficulty: 'medium' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const host = io(base, { transports: ['websocket'], reconnection: false });
  sockets.push(host);
  await new Promise((resolve) => host.once('connect', resolve));
  const initial = waitForState(host, (s) => s.phase === 'draft', 'draft');
  assert.equal((await request(host, 'host:attach', { code: created.code, token: created.hostToken })).ok, true);
  assert.equal((await initial).draftQuestions.length, 0);

  const player = io(base, { transports: ['websocket'], reconnection: false });
  sockets.push(player);
  await new Promise((resolve) => player.once('connect', resolve));
  assert.equal((await request(player, 'player:join', { code: created.code, name: 'Early Player' })).ok, false);
  assert.equal((await request(player, 'host:generate', {})).ok, false);

  const generatedPromise = waitForState(host, (s) => s.phase === 'draft' && s.draftQuestions?.length === 10, 'generated pack');
  assert.equal((await request(host, 'host:generate', {})).ok, true);
  const generated = await generatedPromise;
  assert.equal(generated.draftQuestions.length, 10);
  assert.equal(modelCalls, 1);

  const originalId = generated.draftQuestions[0].id;
  const replacedPromise = waitForState(host, (s) => s.draftQuestions?.[0]?.id !== originalId && s.draftQuestions?.length === 10, 'regeneration');
  // The five-second cooldown protects against accidental repeated cost-bearing calls.
  await new Promise((resolve) => setTimeout(resolve, 5100));
  assert.equal((await request(host, 'host:regenerateQuestion', { index: 0 })).ok, true);
  const regenerated = await replacedPromise;
  assert.equal(modelCalls, 2);

  const updatedPrompt = 'Which answer corresponds to the edited, reviewed trivia question?';
  const updatedPromise = waitForState(host, (s) => s.draftQuestions?.[0]?.prompt === updatedPrompt, 'edited question');
  assert.equal((await request(host, 'host:updateQuestion', { index: 0, question: { ...regenerated.draftQuestions[0], prompt: updatedPrompt } })).ok, true);
  await updatedPromise;

  const lobbyPromise = waitForState(host, (s) => s.phase === 'lobby', 'approved lobby');
  assert.equal((await request(host, 'host:approveQuestions', {})).ok, true);
  await lobbyPromise;
  const playerLobbyPromise = waitForState(player, (s) => s.phase === 'lobby', 'player join');
  assert.equal((await request(player, 'player:join', { code: created.code, name: 'Test Player' })).ok, true);
  await playerLobbyPromise;
  const questionPromise = waitForState(player, (s) => s.phase === 'question', 'first question');
  assert.equal((await request(host, 'host:start', {})).ok, true);
  const question = await questionPromise;
  assert.equal(question.question.correctIndex, undefined, 'Answer must remain secret during play');
  const answerIndex = question.question.options.findIndex((option) => option.startsWith('Correct'));
  assert.equal((await request(player, 'player:answer', { choice: answerIndex })).ok, true);
  const finished = waitForState(host, (s) => s.phase === 'finished', 'final awards');
  assert.equal((await request(host, 'host:end', {})).ok, true);
  assert.equal((await finished).leaderboard.accuracy[0].correct, 1);
  console.log('✓ AI generation, host-only access, preview, regeneration, editing, approval, joining, play and scoring passed.');
} finally {
  sockets.forEach((s) => s.disconnect());
  gameServer.kill('SIGTERM');
  await new Promise((resolve) => modelServer.close(resolve));
}
