import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import qrcode from 'qrcode-generator';
import { TOPICS, QUESTION_BANK } from './questions.js';
import { ROUND_CONFIG, candidateSquares, completeLines, createLeaderboards, selectQuestions } from './engine.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 20_000 });
const games = new Map();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

function code() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value;
  do { value = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
  while (games.has(value));
  return value;
}

function getLanIp() {
  let interfaces;
  try { interfaces = os.networkInterfaces(); }
  catch { return 'localhost'; }
  const addresses = Object.values(interfaces).flatMap((nics) => nics ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal);
  return addresses.find((a) => /^192\.168\.|^10\./.test(a.address))?.address
    ?? addresses.find((a) => /^172\./.test(a.address))?.address
    ?? addresses[0]?.address ?? 'localhost';
}

function joinBaseUrl() {
  return (process.env.JOIN_BASE_URL || `http://${getLanIp()}:${PORT}`).replace(/\/$/, '');
}

function fail(ack, message) {
  if (typeof ack === 'function') ack({ ok: false, error: message });
}

function ok(ack, extra = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...extra });
}

function gameForSocket(socket, role) {
  const game = games.get(socket.data.gameCode);
  if (!game || socket.data.role !== role) return null;
  if (role === 'host' && socket.data.token !== game.hostToken) return null;
  if (role === 'player' && !game.players.has(socket.data.playerId)) return null;
  return game;
}

function questionView(game) {
  if (game.index < 0) return null;
  const q = game.questions[game.index];
  return {
    id: q.id, topic: q.topic, prompt: q.prompt, options: q.options,
    ...(game.phase !== 'question' ? { correctIndex: q.correctIndex, explanation: q.explanation } : {}),
  };
}

function viewFor(game, socket) {
  const players = [...game.players.values()];
  const myPlayer = socket.data.role === 'player' ? game.players.get(socket.data.playerId) : null;
  const answer = myPlayer?.answers[game.index];
  const lineCount = myPlayer ? completeLines(myPlayer.marks, game.config.boardSize).length : 0;
  return {
    code: game.code,
    phase: game.phase,
    deadline: game.deadline,
    index: game.index,
    questionCount: game.questions.length,
    config: game.config,
    question: questionView(game),
    playerCount: players.length,
    connectedCount: players.filter((p) => p.connected).length,
    answeredCount: players.filter((p) => Boolean(p.answers[game.index])).length,
    correctCount: game.phase !== 'question' ? players.filter((p) => p.answers[game.index]?.correct).length : null,
    leaderboard: game.publishedLeaderboard,
    role: socket.data.role,
    ...(socket.data.role === 'host' ? {
      players: players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
      qr: game.qr,
      joinUrl: game.joinUrl,
    } : {}),
    ...(myPlayer ? {
      me: {
        id: myPlayer.id,
        name: myPlayer.name,
        marks: myPlayer.marks,
        candidates: myPlayer.candidates,
        markedRound: myPlayer.markedRound,
        correctCount: myPlayer.correctCount,
        lineCount,
        completedLines: completeLines(myPlayer.marks, game.config.boardSize),
        rank: game.publishedLeaderboard.overall.findIndex((p) => p.id === myPlayer.id) + 1,
        answered: Boolean(answer),
        ...(game.phase !== 'question' && answer ? { answerCorrect: answer.correct, answerChoice: answer.choice, responseMs: answer.responseMs } : {}),
      },
    } : {}),
  };
}

function broadcast(game) {
  const room = io.sockets.adapter.rooms.get(game.code);
  for (const socketId of room ?? []) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.emit('game:state', viewFor(game, socket));
  }
}

function publishLeaderboard(game) {
  game.publishedLeaderboard = createLeaderboards([...game.players.values()], game.config.boardSize, game.questions.length);
}

function clearTimer(game) {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

function schedule(game, milliseconds, callback) {
  clearTimer(game);
  game.deadline = Date.now() + milliseconds;
  game.timer = setTimeout(() => {
    if (games.get(game.code) === game && game.phase !== 'finished') callback(game);
  }, milliseconds);
}

function startQuestion(game) {
  game.index += 1;
  if (game.index >= game.questions.length) return finishGame(game);
  game.phase = 'question';
  for (const player of game.players.values()) player.candidates = [];
  schedule(game, game.config.timerSeconds * 1000, showReveal);
  broadcast(game);
}

function showReveal(game) {
  game.phase = 'reveal';
  schedule(game, ROUND_CONFIG.revealMs, showMarking);
  broadcast(game);
}

function showMarking(game) {
  game.phase = 'mark';
  for (const player of game.players.values()) {
    player.candidates = player.answers[game.index]?.correct ? candidateSquares(player.marks) : [];
  }
  schedule(game, ROUND_CONFIG.markMs, finishMarking);
  broadcast(game);
}

function finishMarking(game) {
  for (const player of game.players.values()) {
    if (player.candidates.length && player.markedRound !== game.index) {
      player.marks[player.candidates[randomInt(player.candidates.length)]] = true;
      player.markedRound = game.index;
    }
    player.candidates = [];
  }
  publishLeaderboard(game);
  game.phase = 'intermission';
  schedule(game, ROUND_CONFIG.intermissionMs, startQuestion);
  broadcast(game);
}

function finishGame(game) {
  clearTimer(game);
  if (game.phase === 'mark') {
    for (const player of game.players.values()) {
      if (player.candidates.length && player.markedRound !== game.index) {
        player.marks[player.candidates[randomInt(player.candidates.length)]] = true;
        player.markedRound = game.index;
      }
      player.candidates = [];
    }
  }
  game.phase = 'finished';
  game.deadline = null;
  publishLeaderboard(game);
  broadcast(game);
  try {
    const dataDir = process.env.TRIVIA_DATA_DIR || path.resolve(__dirname, '../data');
    fs.mkdirSync(dataDir, { recursive: true });
    const summary = { gameCode: game.code, finishedAt: new Date().toISOString(), config: game.config, results: game.publishedLeaderboard };
    fs.writeFileSync(path.join(dataDir, `${game.code}-results.json`), JSON.stringify(summary, null, 2));
  } catch (err) {
    console.warn('Could not save finished game results:', err.message);
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, games: games.size }));
app.get('/api/topics', (_req, res) => res.json({ topics: TOPICS.map((topic) => ({
  ...topic, count: QUESTION_BANK.filter((q) => q.topic === topic.id).length,
})) }));

app.post('/api/games', async (req, res) => {
  const raw = req.body ?? {};
  const topics = [...new Set(Array.isArray(raw.topics) ? raw.topics : [])];
  const timerSeconds = Number(raw.timerSeconds);
  const questionCount = Number(raw.questionCount);
  const boardSize = Number(raw.boardSize);
  if (!topics.length || !topics.every((topic) => TOPICS.some((t) => t.id === topic)))
    return res.status(400).json({ error: 'Choose at least one valid topic.' });
  if (![15, 30, 45, 60].includes(timerSeconds))
    return res.status(400).json({ error: 'Timer must be 15, 30, 45 or 60 seconds.' });
  if (![4, 5].includes(boardSize) || ![10, 12, 15, 20].includes(questionCount) || (boardSize === 4 && questionCount > 15))
    return res.status(400).json({ error: 'Choose a valid board size and question count.' });
  let questions;
  try { questions = selectQuestions(QUESTION_BANK, topics, questionCount); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const roomCode = code();
  const joinUrl = `${joinBaseUrl()}/join/${roomCode}`;
  const qrGenerator = qrcode(0, 'M');
  qrGenerator.addData(joinUrl);
  qrGenerator.make();
  const qr = `data:image/svg+xml;base64,${Buffer.from(qrGenerator.createSvgTag({ cellSize: 6, margin: 2 })).toString('base64')}`;
  const game = {
    code: roomCode,
    hostToken: randomBytes(24).toString('base64url'),
    config: { topics, timerSeconds, questionCount, boardSize },
    questions, phase: 'lobby', index: -1, deadline: null, timer: null,
    players: new Map(), joinUrl, qr,
    publishedLeaderboard: { overall: [], accuracy: [], fastest: [] },
  };
  games.set(roomCode, game);
  res.status(201).json({ code: roomCode, hostToken: game.hostToken, joinUrl });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.send('Trivia Bingo server is running. Run npm run build, then npm start to load the app.'));
}

io.on('connection', (socket) => {
  const attach = (game, role, token, playerId) => {
    if (socket.data.gameCode) socket.leave(socket.data.gameCode);
    socket.data = { gameCode: game.code, role, token, playerId };
    socket.join(game.code);
  };

  socket.on('host:attach', ({ code: gameCode, token } = {}, ack) => {
    const game = games.get(String(gameCode ?? '').toUpperCase());
    if (!game || token !== game.hostToken) return fail(ack, 'Host session not found. Create a new game.');
    attach(game, 'host', token, null);
    ok(ack);
    broadcast(game);
  });

  socket.on('player:join', ({ code: gameCode, name, token } = {}, ack) => {
    const game = games.get(String(gameCode ?? '').toUpperCase());
    if (!game) return fail(ack, 'Game not found. Check the room code.');
    let player = token ? [...game.players.values()].find((p) => p.token === token) : null;
    if (!player) {
      if (game.phase !== 'lobby') return fail(ack, 'This game has already started.');
      const safeName = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 22);
      if (safeName.length < 2) return fail(ack, 'Enter a name with at least two characters.');
      if (game.players.size >= 120) return fail(ack, 'This room has reached its player limit.');
      if ([...game.players.values()].some((p) => p.name.toLowerCase() === safeName.toLowerCase()))
        return fail(ack, 'That name is taken. Add an initial or nickname.');
      player = {
        id: randomUUID(), token: randomBytes(24).toString('base64url'), name: safeName,
        connected: true, marks: Array(game.config.boardSize ** 2).fill(false),
        answers: {}, correctCount: 0, correctTimeTotal: 0, candidates: [], markedRound: -1,
      };
      game.players.set(player.id, player);
    }
    player.connected = true;
    attach(game, 'player', player.token, player.id);
    publishLeaderboard(game);
    ok(ack, { token: player.token, playerId: player.id, name: player.name });
    broadcast(game);
  });

  socket.on('host:start', (_, ack) => {
    const game = gameForSocket(socket, 'host');
    if (!game) return fail(ack, 'Not authorized as host.');
    if (game.phase !== 'lobby') return fail(ack, 'Game is already running.');
    if (!game.players.size) return fail(ack, 'Wait for at least one player to join.');
    publishLeaderboard(game);
    startQuestion(game);
    ok(ack);
  });

  socket.on('host:end', (_, ack) => {
    const game = gameForSocket(socket, 'host');
    if (!game) return fail(ack, 'Not authorized as host.');
    if (game.phase !== 'finished') finishGame(game);
    ok(ack);
  });

  socket.on('player:answer', ({ choice } = {}, ack) => {
    const game = gameForSocket(socket, 'player');
    if (!game) return fail(ack, 'Join the game first.');
    const player = game.players.get(socket.data.playerId);
    if (game.phase !== 'question' || Date.now() >= game.deadline)
      return fail(ack, 'The question is closed.');
    if (player.answers[game.index]) return fail(ack, 'Answer already submitted.');
    if (!Number.isInteger(choice) || choice < 0 || choice >= 4) return fail(ack, 'Invalid answer.');
    const correct = choice === game.questions[game.index].correctIndex;
    const responseMs = Math.max(0, game.config.timerSeconds * 1000 - (game.deadline - Date.now()));
    player.answers[game.index] = { choice, correct, responseMs };
    if (correct) { player.correctCount += 1; player.correctTimeTotal += responseMs; }
    ok(ack);
    broadcast(game);
  });

  socket.on('player:mark', ({ index } = {}, ack) => {
    const game = gameForSocket(socket, 'player');
    if (!game) return fail(ack, 'Join the game first.');
    const player = game.players.get(socket.data.playerId);
    if (game.phase !== 'mark' || player.markedRound === game.index || !player.answers[game.index]?.correct)
      return fail(ack, 'No Bingo mark is available right now.');
    if (!Number.isInteger(index) || !player.candidates.includes(index) || player.marks[index])
      return fail(ack, 'Choose one of your highlighted squares.');
    player.marks[index] = true;
    player.markedRound = game.index;
    player.candidates = [];
    ok(ack);
    broadcast(game);
  });

  socket.on('disconnect', () => {
    if (socket.data.role !== 'player') return;
    const game = games.get(socket.data.gameCode);
    const player = game?.players.get(socket.data.playerId);
    if (!player) return;
    player.connected = [...io.sockets.sockets.values()].some((s) =>
      s.connected && s.data.gameCode === game.code && s.data.role === 'player' && s.data.playerId === player.id);
    broadcast(game);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎉 Trivia Bingo is ready!`);
  console.log(`   Host:   http://localhost:${PORT}`);
  console.log(`   Wi-Fi:  ${joinBaseUrl()}`);
  console.log('   Everyone must be able to reach this computer on the local network.\n');
});
