import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io, type Socket } from 'socket.io-client';
import {
  ArrowRight, Brain, Check, CheckCircle2, CircleHelp,
  Clock3, Copy, Crown, Expand, Flame, Gamepad2, Hash,
  PartyPopper, Play, Plus, Radio, RotateCcw, ScanLine, Settings2, ShieldCheck,
  Smartphone, Sparkles, Target, Trophy, Users, Wifi, WifiOff, X, Zap,
  BookOpen, Pencil, RefreshCw, Save, Loader2, AlertTriangle, WandSparkles,
} from 'lucide-react';
import './style.css';

type Topic = { id: string; label: string; emoji: string; count: number };
type Config = { topics: string[]; questionCount: number; timerSeconds: number; boardSize: 4 | 5; difficulty: 'easy' | 'medium' | 'hard' | 'mixed'; questionSource: 'ai' | 'curated' };
type Phase = 'draft' | 'lobby' | 'question' | 'reveal' | 'mark' | 'intermission' | 'finished';
type Score = { id: string; name: string; lines: number; correct: number; averageMs: number | null; marks: number };
type Leaderboards = { overall: Score[]; accuracy: Score[]; fastest: Score[] };
type Question = { id: string; topic: string; prompt: string; options: string[]; correctIndex?: number; explanation?: string };
type DraftQuestion = Question & { difficulty: 'easy' | 'medium' | 'hard'; correctIndex: number; explanation: string };
type PlayerView = {
  id: string; name: string; marks: boolean[]; candidates: number[]; markedRound: number;
  correctCount: number; lineCount: number; completedLines: number[][]; rank: number;
  answered: boolean; answerCorrect?: boolean; answerChoice?: number; responseMs?: number;
};
type GameState = {
  code: string; phase: Phase; deadline: number | null; index: number; questionCount: number;
  config: Config; question: Question | null; playerCount: number; connectedCount: number;
  answeredCount: number; correctCount: number | null; leaderboard: Leaderboards;
  role: 'host' | 'player'; me?: PlayerView;
  players?: { id: string; name: string; connected: boolean }[]; qr?: string; joinUrl?: string;
  draftQuestions?: DraftQuestion[]; generating?: boolean; regeneratingIndex?: number | null;
  generationError?: string | null; aiConfigured?: boolean;
};
type HostSession = { code: string; token: string };
type PlayerSession = { code: string; token: string; name: string };
type Ack = { ok: boolean; error?: string; token?: string; playerId?: string; name?: string };

const HOST_STORAGE = 'trivia-bingo:host';
const playerStorage = (code: string) => `trivia-bingo:player:${code}`;
const initialCode = window.location.pathname.match(/^\/join\/?([A-Za-z0-9]*)/i)?.[1]?.toUpperCase() ?? '';
const playerMode = window.location.pathname.startsWith('/join');

function readStorage<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) || 'null') as T; } catch { return null; }
}

function useClock(deadline: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [deadline]);
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

function formatTime(s: number) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function responseTime(ms: number | null) { return ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`; }

function App() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<GameState | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [hostSession, setHostSession] = useState<HostSession | null>(() => playerMode ? null : readStorage(HOST_STORAGE));
  const [playerSession, setPlayerSession] = useState<PlayerSession | null>(() => playerMode && initialCode ? readStorage(playerStorage(initialCode)) : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [codeInput, setCodeInput] = useState(initialCode);
  const [selectedChoice, setSelectedChoice] = useState<number | null>(null);
  const [config, setConfig] = useState<Config>({ topics: ['general', 'science', 'movies'], questionCount: 12, timerSeconds: 30, boardSize: 4, difficulty: 'mixed', questionSource: 'ai' });
  const hostRef = useRef(hostSession);
  const playerRef = useRef(playerSession);
  hostRef.current = hostSession;
  playerRef.current = playerSession;

  useEffect(() => {
    fetch('/api/topics').then((res) => res.json()).then((data) => setTopics(data.topics ?? [])).catch(() => setError('Cannot reach the local game server. Is it running?'));
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    const attach = () => {
      const host = hostRef.current;
      const player = playerRef.current;
      if (!playerMode && host) {
        socket.emit('host:attach', { code: host.code, token: host.token }, (ack: Ack) => {
          if (!ack.ok) { localStorage.removeItem(HOST_STORAGE); setHostSession(null); setState(null); setError(ack.error ?? 'Host session expired.'); }
        });
      }
      if (playerMode && player) {
        socket.emit('player:join', { code: player.code, token: player.token, name: player.name }, (ack: Ack) => {
          if (!ack.ok) { localStorage.removeItem(playerStorage(player.code)); setPlayerSession(null); setState(null); setError(ack.error ?? 'Your session expired.'); }
        });
      }
    };
    socket.on('connect', () => { setConnected(true); attach(); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('game:state', (game: GameState) => setState(game));
    socket.on('connect_error', () => setConnected(false));
    return () => { socket.removeAllListeners(); socket.disconnect(); socketRef.current = null; };
  }, []);

  useEffect(() => {
    setSelectedChoice(null);
  }, [state?.index]);

  const emit = useCallback((event: string, payload: object = {}): Promise<Ack> => new Promise((resolve) => {
    const socket = socketRef.current;
    if (!socket?.connected) return resolve({ ok: false, error: 'Not connected. Check your Wi-Fi and try again.' });
    socket.timeout(6000).emit(event, payload, (err: Error | null, answer: Ack) =>
      resolve(err ? { ok: false, error: 'Connection timed out. Try again.' } : answer));
  }), []);

  const createGame = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not create game.');
      const session = { code: data.code as string, token: data.hostToken as string };
      localStorage.setItem(HOST_STORAGE, JSON.stringify(session));
      setHostSession(session);
      setState(null);
      const ack = await emit('host:attach', { code: session.code, token: session.token });
      if (!ack.ok) throw new Error(ack.error);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create game.'); }
    finally { setBusy(false); }
  };

  const joinGame = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const roomCode = codeInput.trim().toUpperCase();
    const ack = await emit('player:join', { code: roomCode, name: name.trim() });
    if (ack.ok && ack.token) {
      const session = { code: roomCode, token: ack.token, name: ack.name ?? name.trim() };
      localStorage.setItem(playerStorage(roomCode), JSON.stringify(session));
      setPlayerSession(session);
      window.history.replaceState({}, '', `/join/${roomCode}`);
    } else setError(ack.error ?? 'Unable to join.');
    setBusy(false);
  };

  const perform = async (event: string, payload: object = {}) => {
    setError('');
    const ack = await emit(event, payload);
    if (!ack.ok) setError(ack.error ?? 'Something went wrong.');
    return ack.ok;
  };

  const leaveHost = () => { localStorage.removeItem(HOST_STORAGE); setHostSession(null); setState(null); setError(''); };
  const fullScreen = () => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.(); else void document.exitFullscreen?.(); };

  if (playerMode) {
    return <div className="app player-app">
      <Topbar connection={connected} player />
      {!playerSession || !state ? <main className="join-wrap">
        <div className="join-art"><div className="join-orb"><PartyPopper size={68} /></div></div>
        <div className="eyebrow"><span className="eyebrow-line" /> THE PARTY STARTS HERE</div>
        <h1 className="join-title">Ready to <span>play?</span></h1>
        <p className="muted center">Join the room, think fast, and make your Bingo.</p>
        <form className="join-form panel" onSubmit={joinGame}>
          <label>ROOM CODE<input autoCapitalize="characters" value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} placeholder="BINGO42" maxLength={8} required /></label>
          <label>YOUR NAME<input autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} placeholder="What should we call you?" maxLength={22} minLength={2} required /></label>
          <button className="btn primary large" disabled={busy || !connected} type="submit">{busy ? 'Joining...' : 'Join game'} <ArrowRight size={18} /></button>
          <p className="form-helper"><ShieldCheck size={15} /> No account needed. Just good vibes.</p>
        </form>
        {error && <ErrorBanner text={error} />}
      </main> : <main className="player-content">
        {state.phase === 'finished' ? <PlayerResults state={state} /> : <>
          <div className="player-game-title"><span className="room-chip"><Hash size={14}/>{state.code}</span><span className="muted small">Player: <strong>{state.me?.name}</strong></span></div>
          {state.phase === 'lobby' ? <PlayerWaiting state={state} /> : <>
            <PlayerQuestion state={state} selectedChoice={selectedChoice} choose={async (choice) => {
              const success = await perform('player:answer', { choice });
              if (success) setSelectedChoice(choice);
            }} />
            <PlayerBoard state={state} choose={async (index) => { await perform('player:mark', { index }); }} />
          </>}
          {error && <ErrorBanner text={error} />}
        </>}
      </main>}
    </div>;
  }

  return <div className="app host-app">
    <Topbar connection={connected} host onFullscreen={fullScreen} />
    {!hostSession || !state ? <main className="setup-wrap">
      <div className="setup-intro"><div className="eyebrow"><span className="eyebrow-line"/> GAME NIGHT, REINVENTED</div><h1>Trivia meets <span>Bingo.</span></h1>
        <p>Pick your topics. Invite your people. Let the competition begin.</p></div>
      <div className="setup-grid">
        <section className="panel setup-panel">
          <div className="section-title"><div className="icon-square violet"><Settings2 size={22}/></div><div><h2>Set up your game</h2><p>Make it yours in a few clicks.</p></div></div>
          <div className="field-block"><div className="field-heading"><h3>Choose trivia topics</h3><span className="tiny-pill">MULTI-SELECT</span></div><p className="hint">Mix categories for a game everyone can enjoy.</p>
            <div className="topic-grid">{topics.map((topic) => <button type="button" key={topic.id} className={`topic-tile ${config.topics.includes(topic.id) ? 'selected' : ''}`} onClick={() => setConfig((prev) => ({ ...prev, topics: prev.topics.includes(topic.id) ? prev.topics.length > 1 ? prev.topics.filter((t) => t !== topic.id) : prev.topics : [...prev.topics, topic.id] }))}>
              <span className="topic-emoji">{topic.emoji}</span><span className="topic-label">{topic.label}</span>{config.topics.includes(topic.id) && <CheckCircle2 className="topic-check" size={17}/>}</button>)}</div>
          </div>
          <div className="setup-options"><div className="field-block"><div className="field-heading"><h3>Number of questions</h3></div><div className="segmented">{[10,12,15,20].map((n) => <button type="button" key={n} disabled={n === 20 && config.boardSize === 4} className={config.questionCount === n ? 'active' : ''} onClick={() => setConfig((c) => ({ ...c, questionCount: n }))}>{n}</button>)}</div></div>
            <div className="field-block"><div className="field-heading"><h3>Time per question</h3></div><div className="segmented">{[15,30,45,60].map((n) => <button type="button" key={n} className={config.timerSeconds === n ? 'active' : ''} onClick={() => setConfig((c) => ({...c, timerSeconds: n}))}>{n}s</button>)}</div></div></div>
          <div className="field-block"><div className="field-heading"><h3>Trivia difficulty</h3><span className="tiny-pill"><Sparkles size={12}/> AI GENERATED</span></div><p className="hint">Choose how challenging the questions should be.</p><div className="segmented difficulty-options">{(['easy','medium','hard','mixed'] as const).map((level) => <button type="button" key={level} className={config.difficulty === level ? 'active' : ''} onClick={() => setConfig((c) => ({...c, difficulty: level}))}>{level.charAt(0).toUpperCase() + level.slice(1)}</button>)}</div></div>
          <div className="field-block"><div className="field-heading"><h3>Bingo board</h3></div><div className="segmented board-size"><button type="button" className={config.boardSize === 4 ? 'active' : ''} onClick={() => setConfig((c) => ({...c, boardSize: 4, questionCount: Math.min(c.questionCount, 15)}))}>4 × 4 <span>Quick play</span></button><button type="button" className={config.boardSize === 5 ? 'active' : ''} onClick={() => setConfig((c) => ({...c, boardSize: 5}))}>5 × 5 <span>Longer game</span></button></div></div>
          <button className="btn primary large create-btn" disabled={busy || !connected || !topics.length} onClick={createGame}>{busy ? 'Creating your room...' : 'Open AI Question Studio'} <WandSparkles size={20}/></button>
          {error && <ErrorBanner text={error} />}
        </section>
        <aside className="setup-aside"><div className="preview-glow"/><div className="preview-card"><div className="preview-header"><span className="preview-dot"/> LIVE EXPERIENCE</div><div className="preview-icon"><Gamepad2 size={49}/></div><h2>Big screens.<br/><span>Big energy.</span></h2><p>A game-show experience for the whole room.</p><div className="preview-features"><span><ScanLine size={18}/> QR code join</span><span><Radio size={18}/> Real-time rankings</span><span><Trophy size={18}/> Three award podiums</span><span><Wifi size={18}/> Local Wi-Fi play</span></div></div><div className="summary-strip"><Clock3 size={17}/> About {Math.ceil(config.questionCount * (config.timerSeconds + 14) / 60)} min <span>·</span> {config.topics.length} topics <span>·</span> {config.boardSize}×{config.boardSize} board</div></aside>
      </div>
    </main> : state.phase === 'draft' ? <QuestionStudio state={state} perform={perform} onNewGame={leaveHost} topics={topics}/> : state.phase === 'lobby' ? <main className="lobby-wrap">
      <div className="eyebrow">YOUR GAME IS READY</div><h1>Bring everyone <span>together.</span></h1><p className="muted">Scan, join, and get ready to win.</p>
      <div className="lobby-grid"><section className="panel qr-panel"><span className="micro-label">SCAN TO JOIN</span><div className="qr-frame"><img src={state.qr} alt="QR code to join the local Trivia Bingo room" /></div><div className="room-code">{state.code}</div><p>Or visit this address on the same Wi-Fi</p><div className="copy-url"><span>{state.joinUrl}</span><button aria-label="Copy link" onClick={() => { if (state.joinUrl) void navigator.clipboard.writeText(state.joinUrl); }}><Copy size={17}/></button></div></section>
        <section className="panel lobby-people"><div className="lobby-people-title"><div><h2>Players in the room</h2><p>Waiting for everyone to join</p></div><span className="players-count"><Users size={17}/>{state.playerCount}</span></div><div className="people-list">{state.players?.length ? state.players.map((p) => <div className="person-chip" key={p.id}><div className="avatar">{p.name.charAt(0).toUpperCase()}</div>{p.name}<span className={`online-dot ${p.connected ? '' : 'offline'}`}/></div>) : <div className="empty-people"><Users size={38}/><h3>It's quiet in here...</h3><p>Players appear here when they scan your code.</p></div>}</div><div className="lobby-bottom"><div className="game-meta"><span><Brain size={16}/>{state.config.topics.length} topics</span><span><CircleHelp size={16}/>{state.questionCount} questions</span><span><Clock3 size={16}/>{state.config.timerSeconds}s timer</span></div><button className="btn primary large" disabled={state.playerCount === 0} onClick={() => void perform('host:start')}><Play size={19} fill="currentColor"/> Start the game <ArrowRight size={18}/></button>{error && <ErrorBanner text={error}/>}</div></section></div>
    </main> : state.phase === 'finished' ? <HostResults state={state} onNewGame={leaveHost}/> : <main className="host-play-wrap">
      <div className="host-play-header"><div><span className="game-live"><span className="live-dot"/> LIVE GAME</span><span className="room-chip"><Hash size={14}/>{state.code}</span><span className="question-step">QUESTION {state.index + 1} / {state.questionCount}</span></div><button className="btn outline small" onClick={() => { if (window.confirm('End this game now and show the current awards?')) void perform('host:end'); }}>End game</button></div>
      <div className="host-play-grid"><HostQuestion state={state} topics={topics}/><Leaderboard state={state}/></div>
      {error && <ErrorBanner text={error} />}
    </main>}
    <footer className="host-footer"><span>TRIVIA <strong>BINGO</strong></span><span><Wifi size={13}/> Local multiplayer</span></footer>
  </div>;
}

function QuestionStudio({ state, perform, onNewGame, topics }: {
  state: GameState;
  perform: (event: string, payload?: object) => Promise<boolean>;
  onNewGame: () => void;
  topics: Topic[];
}) {
  const questions = state.draftQuestions ?? [];
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<DraftQuestion | null>(null);
  const busy = Boolean(state.generating || state.regeneratingIndex !== null && state.regeneratingIndex !== undefined);
  const startEditing = (question: DraftQuestion, index: number) => {
    setEditingIndex(index);
    setEditing({ ...question, options: [...question.options] });
  };
  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing || editingIndex === null) return;
    const success = await perform('host:updateQuestion', { index: editingIndex, question: editing });
    if (success) { setEditingIndex(null); setEditing(null); }
  };

  return <main className="studio-wrap">
    <div className="studio-top"><div><div className="eyebrow"><WandSparkles size={16}/> AI QUESTION STUDIO</div><h1>Make it a <span>great game.</span></h1><p>Generate fresh trivia, check the answers, then invite your players.</p></div><button className="btn outline small" onClick={onNewGame}><ArrowLeftIcon/> Game settings</button></div>
    <div className="studio-layout"><section className="studio-questions">
      <div className="panel studio-toolbar"><div><span className="micro-label">YOUR QUESTION PACK</span><h2>{questions.length} <span>/ {state.config.questionCount}</span> questions ready</h2><p>{state.config.topics.map((topic) => topics.find((t) => t.id === topic)?.label ?? topic).join(' · ')} · {state.config.difficulty} difficulty</p></div><div className="studio-controls"><button className="btn primary" disabled={!state.aiConfigured || busy} onClick={() => { if (questions.length && !window.confirm('Regenerate the entire pack? Your edits will be replaced.')) return; void perform('host:generate'); }}>
        {state.generating ? <Loader2 className="spin" size={17}/> : <WandSparkles size={17}/>} {state.generating ? 'Generating...' : questions.length ? 'Regenerate all' : 'Generate questions'}</button><button className="btn outline" disabled={busy} onClick={() => { if (questions.length && !window.confirm('Replace this pack with the built-in offline questions?')) return; void perform('host:useFallback'); }}><BookOpen size={17}/> Use offline questions</button></div></div>
      {!state.aiConfigured && <div className="studio-callout"><AlertTriangle size={19}/><span><strong>OpenAI API key not configured.</strong> Add <code>OPENAI_API_KEY</code> to the server's <code>.env</code> file and restart. You can still preview the built-in questions.</span></div>}
      {state.generationError && <ErrorBanner text={state.generationError}/>}
      {state.generating && <div className="studio-generating panel"><Loader2 size={44} className="spin"/><h3>Creating your trivia...</h3><p>We're generating {state.config.questionCount} questions across your chosen topics. This can take a little while.</p></div>}
      {!state.generating && !questions.length && <div className="studio-empty panel"><WandSparkles size={54}/><h3>Fresh questions, just for this game</h3><p>Generate your first set with OpenAI, or use the built-in questions while setting up your API key.</p></div>}
      {questions.map((question, index) => <article className="panel studio-question" key={question.id}>
        <div className="studio-question-top"><div className="studio-question-meta"><span>Q{String(index + 1).padStart(2, '0')}</span><span className="studio-topic">{topics.find((t) => t.id === question.topic)?.emoji ?? '✨'} {topics.find((t) => t.id === question.topic)?.label ?? question.topic}</span><span className={`studio-difficulty ${question.difficulty}`}>{question.difficulty}</span></div><div className="studio-actions"><button disabled={busy || !state.aiConfigured} title="Regenerate this question" onClick={() => void perform('host:regenerateQuestion', { index })}>{state.regeneratingIndex === index ? <Loader2 size={17} className="spin"/> : <RefreshCw size={17}/>}</button><button disabled={busy} title="Edit question" onClick={() => startEditing(question, index)}><Pencil size={17}/></button></div></div>
        {editingIndex === index && editing ? <form className="studio-edit-form" onSubmit={saveEdit}><label>Question<textarea value={editing.prompt} maxLength={260} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} rows={2} required/></label><div className="studio-edit-grid"><label>Topic<select value={editing.topic} onChange={(e) => setEditing({ ...editing, topic: e.target.value })}>{state.config.topics.map((topic) => <option key={topic} value={topic}>{topics.find((t) => t.id === topic)?.label ?? topic}</option>)}</select></label><label>Difficulty<select value={editing.difficulty} onChange={(e) => setEditing({ ...editing, difficulty: e.target.value as DraftQuestion['difficulty'] })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label></div><div className="studio-edit-options"><span>Answer choices, select the correct one:</span>{editing.options.map((option, i) => <div className="studio-edit-option" key={i}><input type="radio" aria-label={`Mark answer ${i + 1} as correct`} checked={editing.correctIndex === i} onChange={() => setEditing({ ...editing, correctIndex: i })}/><input aria-label={`Answer choice ${i + 1}`} value={option} maxLength={130} onChange={(e) => setEditing({ ...editing, options: editing.options.map((v, j) => i === j ? e.target.value : v) })} required/></div>)}</div><label>Explanation<textarea rows={2} maxLength={450} value={editing.explanation} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} required/></label><div className="studio-edit-buttons"><button type="button" className="btn outline" onClick={() => { setEditingIndex(null); setEditing(null); }}>Cancel</button><button type="submit" className="btn primary"><Save size={16}/> Save question</button></div></form> : <><h3>{question.prompt}</h3><div className="studio-options">{question.options.map((option, i) => <div key={i} className={`studio-option ${i === question.correctIndex ? 'right' : ''}`}><span>{'ABCD'[i]}</span>{option}{i === question.correctIndex && <CheckCircle2 size={16}/>}</div>)}</div><p className="studio-explanation"><CheckCircle2 size={16}/> {question.explanation}</p></>}
      </article>)}
    </section><aside className="studio-sidebar"><div className="panel studio-sidebar-inner"><div className="icon-square violet"><ShieldCheck size={23}/></div><h3>Ready to play?</h3><p>Review your questions before going live. Players won't see any questions or answers until the game starts.</p><div className="studio-checks"><span><CheckCircle2 size={17}/> {questions.length}/{state.config.questionCount} questions</span><span><CheckCircle2 size={17}/> Correct answers marked</span><span><CheckCircle2 size={17}/> Editable explanations</span></div><button className="btn primary large" disabled={busy || questions.length !== state.config.questionCount || editingIndex !== null} onClick={() => void perform('host:approveQuestions')}>Approve & open lobby <ArrowRight size={18}/></button><div className="studio-note"><ShieldCheck size={15}/> The API key stays on the host server, never in player browsers.</div></div></aside></div>
  </main>;
}

function ArrowLeftIcon() { return <ArrowRight size={16} className="flip-icon"/>; }

function Topbar({ connection, player, host, onFullscreen }: { connection: boolean; player?: boolean; host?: boolean; onFullscreen?: () => void }) {
  return <header className="topbar"><a className="brand" href={player ? '/join' : '/'}><span className="brand-icon"><Target size={23}/></span><span>trivia<span className="brand-accent">bingo</span><span className="brand-dot">.</span></span></a><div className="topbar-right"><span className={`connection ${connection ? '' : 'disconnected'}`}>{connection ? <Wifi size={15}/> : <WifiOff size={15}/>}<span>{connection ? 'Connected' : 'Connecting...'}</span></span>{host && <button className="top-icon-btn" title="Toggle fullscreen" aria-label="Toggle fullscreen" onClick={onFullscreen}><Expand size={18}/></button>}{player && <span className="topbar-pill"><Smartphone size={14}/> PLAYER MODE</span>}</div></header>;
}

function ErrorBanner({text}: {text: string}) { return <div className="error-banner"><X size={17}/>{text}</div>; }

function Countdown({ deadline, prominent = false }: { deadline: number | null; prominent?: boolean }) {
  const seconds = useClock(deadline);
  return <div className={`countdown ${prominent ? 'prominent' : ''} ${seconds <= 5 ? 'urgent' : ''}`}><Clock3 size={prominent ? 25 : 16}/><span>{formatTime(seconds)}</span></div>;
}

function HostQuestion({ state, topics }: { state: GameState; topics: Topic[] }) {
  const q = state.question;
  const [currentIndex, maxIndex] = [state.index + 1, state.questionCount];
  const topic = topics.find((t) => t.id === q?.topic);
  if (!q) return null;
  return <section className="host-question panel"><div className="question-top"><div className="question-category"><span>{topic?.emoji ?? '✨'}</span>{topic?.label ?? q.topic}</div><Countdown deadline={state.deadline} prominent/></div>
    <div className="question-center"><div className="big-question-number">QUESTION {String(currentIndex).padStart(2,'0')}</div><h1>{q.prompt}</h1><div className="answer-grid">{q.options.map((option, index) => <div key={index} className={`answer-block answer-${index} ${q.correctIndex !== undefined && q.correctIndex !== index ? 'dimmed' : ''} ${q.correctIndex === index ? 'correct-answer' : ''}`}><span className="answer-letter">{'ABCD'[index]}</span><span>{option}</span>{q.correctIndex === index && <CheckCircle2 className="answer-tick" size={24}/>}</div>)}</div>
      {state.phase === 'question' ? <div className="question-bottom-note"><Users size={18}/><strong>{state.answeredCount}</strong> of {state.playerCount} answered <span className="animated-dots"><i/><i/><i/></span></div> : state.phase === 'reveal' ? <div className="question-bottom-note reveal-note"><CheckCircle2 size={20}/> {state.correctCount} players answered correctly!</div> : state.phase === 'mark' ? <div className="question-bottom-note mark-note"><Target size={20}/> Correct players are choosing their Bingo squares</div> : <div className="question-bottom-note"><Sparkles size={20}/> Leaderboard updated. Next round coming up!</div>}
    </div><div className="question-progress"><div style={{ width: `${currentIndex / maxIndex * 100}%` }} /></div></section>;
}

function Leaderboard({ state }: { state: GameState }) {
  return <aside className="leaderboard panel"><div className="leaderboard-heading"><div className="leaderboard-title"><div className="icon-square gold"><Trophy size={21}/></div><div><h2>Leaderboard</h2><p>Live rankings</p></div></div><span className="live-badge"><Radio size={12}/> LIVE</span></div>
    <div className="rank-list">{state.leaderboard.overall.slice(0, 6).map((p, i) => <div className={`rank-item ${i === 0 ? 'leader' : ''}`} key={p.id}><span className={`rank-number rank-${i}`}>{i === 0 ? <Crown size={21}/> : `${i + 1}`}</span><div className="rank-avatar">{p.name.charAt(0).toUpperCase()}</div><div className="rank-person"><div>{p.name}</div><span>{p.correct} correct answers</span></div><div className="rank-lines"><strong>{p.lines}</strong><span>{p.lines === 1 ? 'line' : 'lines'}</span></div></div>)}</div>
    <div className="leaderboard-tip"><Flame size={17}/><span>Every line counts. Every answer matters.</span></div><div className="leaderboard-bottom"><Users size={15}/>{state.playerCount} players competing</div></aside>;
}

function PlayerWaiting({ state }: { state: GameState }) { return <div className="player-waiting"><div className="waiting-graphic"><div className="waiting-ring"><Gamepad2 size={62}/></div></div><span className="eyebrow">YOU'RE IN!</span><h1>Nice to meet you, <span>{state.me?.name}.</span></h1><p>You're on the guest list. Waiting for the host to start the game.</p><div className="waiting-status"><span className="live-dot"/>{state.playerCount} players joined</div><div className="how-to panel"><h3>Here's how to win</h3><div><CheckCircle2 size={19}/><span>Answer trivia questions correctly</span></div><div><Target size={19}/><span>Choose one of two random Bingo squares</span></div><div><Trophy size={19}/><span>Complete the most lines to take the crown</span></div></div></div>; }

function PlayerQuestion({ state, selectedChoice, choose }: { state: GameState; selectedChoice: number | null; choose: (choice: number) => void }) {
  const q = state.question;
  if (!q) return null;
  const reveal = state.phase !== 'question';
  return <div className="player-question panel"><div className="player-round-row"><span className="micro-label">QUESTION {state.index + 1} OF {state.questionCount}</span>{state.phase === 'question' ? <Countdown deadline={state.deadline}/> : <span className="phase-label">{state.phase === 'reveal' ? 'ANSWER REVEAL' : state.phase === 'mark' ? 'BINGO TIME!' : 'NEXT UP'}</span>}</div><div className="player-progress"><div style={{ width: `${(state.index + 1) / state.questionCount * 100}%`}}/></div><div className="player-question-category">{q.topic.replace(/\b\w/g, (c) => c.toUpperCase())}</div><h2>{q.prompt}</h2><div className="player-options">{q.options.map((option, i) => <button type="button" key={i} disabled={reveal || state.me?.answered} onClick={() => choose(i)} className={`player-option option-${i} ${reveal && q.correctIndex === i ? 'correct' : ''} ${reveal && state.me?.answerChoice === i && !state.me?.answerCorrect ? 'wrong' : ''} ${selectedChoice === i && !reveal ? 'chosen' : ''}`}><span>{'ABCD'[i]}</span><strong>{option}</strong>{reveal && q.correctIndex === i ? <Check size={20}/> : selectedChoice === i && !reveal ? <CheckCircle2 size={19}/> : null}</button>)}</div>
    {state.phase === 'question' ? <div className="answer-status">{state.me?.answered ? <><CheckCircle2 size={18}/> Answer locked! Waiting for the reveal.</> : <><Zap size={16}/> Pick the correct answer before time runs out.</>}</div> : state.me?.answerCorrect ? <div className="answer-status success"><CheckCircle2 size={18}/> That's right! You earned a Bingo mark.</div> : state.me?.answered ? <div className="answer-status failure"><X size={17}/> Not quite. You've got the next one!</div> : <div className="answer-status failure"><Clock3 size={17}/> Time's up. You'll get the next one.</div>}
  </div>;
}

function PlayerBoard({ state, choose }: { state: GameState; choose: (index: number) => void }) {
  const me = state.me;
  if (!me) return null;
  const lineCells = new Set(me.completedLines.flat());
  const mayChoose = state.phase === 'mark' && me.answerCorrect && me.candidates.length > 0;
  const doneMarking = state.phase === 'mark' && me.answerCorrect && me.markedRound === state.index;
  return <div className="player-board panel"><div className="board-heading"><div><div className="board-title"><Target size={20}/> My Bingo Board</div><p>{mayChoose ? 'Choose one of your two highlighted squares!' : doneMarking ? 'Mark placed. Nice move!' : state.phase === 'mark' && me.answerCorrect ? 'Your board is full!' : 'Correct answers earn a Bingo mark.'}</p></div><span className="board-badge">{me.lineCount} {me.lineCount === 1 ? 'LINE' : 'LINES'}</span></div><div className="board-wrap"><div className="board-grid" style={{ gridTemplateColumns: `repeat(${state.config.boardSize}, 1fr)` }}>{me.marks.map((marked, index) => <button key={index} type="button" disabled={!mayChoose || !me.candidates.includes(index)} onClick={() => choose(index)} className={`board-cell ${marked ? 'stamped' : ''} ${lineCells.has(index) ? 'line-cell' : ''} ${mayChoose && me.candidates.includes(index) ? 'candidate' : ''}`} aria-label={`Bingo square ${index + 1}${marked ? ', marked' : me.candidates.includes(index) ? ', available to choose' : ''}`}>{marked ? <Check size={state.config.boardSize === 4 ? 30 : 24} strokeWidth={3}/> : mayChoose && me.candidates.includes(index) ? <Plus size={24} strokeWidth={2.5}/> : <span className="cell-dot"/>}</button>)}</div></div><div className="board-stats"><div><strong>{me.marks.filter(Boolean).length}</strong><span>Marks earned</span></div><div><strong>{me.correctCount}</strong><span>Correct answers</span></div><div><strong>#{me.rank || '–'}</strong><span>Current rank</span></div></div></div>;
}

function Podium({ scores }: { scores: Score[] }) {
  const ranking = [scores[1], scores[0], scores[2]];
  return <div className="podium">{ranking.map((p, order) => { const placement = [2, 1, 3][order]; return <div className={`podium-place place-${placement}`} key={placement}><div className="podium-medal">{placement === 1 ? '🥇' : placement === 2 ? '🥈' : '🥉'}</div><div className="podium-avatar">{p?.name?.charAt(0).toUpperCase() ?? '–'}</div><div className="podium-name">{p?.name ?? '—'}</div><div className="podium-base"><strong>{placement}</strong><span>{p ? `${p.lines} ${p.lines === 1 ? 'line' : 'lines'}` : ''}</span></div></div>; })}</div>;
}

function AwardList({ icon, title, subtitle, scores, metric }: { icon: React.ReactNode; title: string; subtitle: string; scores: Score[]; metric: (p: Score) => string }) {
  return <div className="award-card panel"><div className="award-card-header"><div className="award-icon">{icon}</div><div><h3>{title}</h3><p>{subtitle}</p></div></div><div className="award-entries">{scores.slice(0,3).map((p, i) => <div className="award-entry" key={p.id}><span>{['🥇','🥈','🥉'][i]}</span><strong>{p.name}</strong><span>{metric(p)}</span></div>)}{scores.length === 0 && <p className="muted">No players qualified.</p>}</div></div>;
}

function Awards({ state }: { state: GameState }) {
  return <><div className="results-intro"><div className="winner-confetti">✦ &nbsp; ✺ &nbsp; ✦</div><span className="eyebrow">THAT'S A WRAP</span><h1>And the winners <span>are...</span></h1><p>What a game! Here's who brought their A-game.</p></div><section className="overall-awards panel"><div className="results-main-title"><Crown size={24}/><h2>Overall Champions</h2><span>MOST BINGO LINES</span></div><Podium scores={state.leaderboard.overall}/></section><div className="special-awards"><AwardList icon={<Brain size={24}/>} title="Trivia Masters" subtitle="Most correct answers" scores={state.leaderboard.accuracy} metric={(p) => `${p.correct} correct`} /><AwardList icon={<Zap size={24}/>} title="Fastest Fingers" subtitle="Fastest average correct response, 50% accuracy required" scores={state.leaderboard.fastest} metric={(p) => responseTime(p.averageMs)}/></div></>;
}

function HostResults({ state, onNewGame }: { state: GameState; onNewGame: () => void }) {
  return <main className="results-wrap"><Awards state={state}/><div className="results-actions"><button className="btn primary large" onClick={onNewGame}><RotateCcw size={18}/> Create a new game</button></div></main>;
}

function PlayerResults({ state }: { state: GameState }) {
  const me = state.me;
  return <main className="player-results"><div className="personal-result panel"><div className="result-emoji">{me?.rank === 1 ? '🏆' : '🎉'}</div><span className="eyebrow">GAME COMPLETE</span><h1>{me?.rank === 1 ? 'You won!' : 'Nice game!'}</h1><p>You finished in <strong>#{me?.rank}</strong> place.</p><div className="personal-stats"><div><strong>{me?.lineCount}</strong><span>Bingo lines</span></div><div><strong>{me?.correctCount}</strong><span>Correct answers</span></div></div></div><h2 className="mini-heading">Final Standings</h2><div className="player-final-list panel">{state.leaderboard.overall.slice(0, 3).map((p, index) => <div key={p.id} className="player-final-row"><span>{['🥇','🥈','🥉'][index]}</span><strong>{p.name}</strong><span>{p.lines} lines</span></div>)}</div><div className="player-award-notes"><div><Brain size={17}/> Trivia champion: <strong>{state.leaderboard.accuracy[0]?.name ?? '—'}</strong></div><div><Zap size={17}/> Fastest fingers: <strong>{state.leaderboard.fastest[0]?.name ?? '—'}</strong></div></div><p className="muted center">Thanks for playing Trivia Bingo!</p></main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
