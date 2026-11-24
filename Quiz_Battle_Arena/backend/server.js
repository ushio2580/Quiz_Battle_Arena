import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import { CHARACTERS, validateQuestion, validateQuiz, pairPlayers, comparePlayers, publicQuestion } from './core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.resolve(process.env.DATABASE_PATH || path.join(root, 'data/qba.sqlite'));
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
for(const migration of fs.readdirSync(path.join(root,'db/migrations')).filter(file=>file.endsWith('.sql')).sort()){
  const version=migration.replace(/\.sql$/,'');
  if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version))continue;
  db.exec(fs.readFileSync(path.join(root,'db/migrations',migration),'utf8'));
  db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
}
db.prepare("UPDATE tournaments SET status='interrupted' WHERE status IN ('lobby','active','paused')").run();
const seedTemplate = JSON.parse(fs.readFileSync(path.join(root, 'db/seed-data.json'), 'utf8'));
db.prepare('INSERT OR IGNORE INTO quiz_templates (id,title,description,questions_json) VALUES (?,?,?,?)')
  .run(seedTemplate.id, seedTemplate.title, seedTemplate.description, JSON.stringify(seedTemplate.questions));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: (origin,callback)=>callback(null,originAllowed(origin)), credentials:true }, pingInterval: 25000, pingTimeout: 20000, maxHttpBufferSize: 1.5e6 });
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const COOKIE = 'qba_session';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-qba-session-secret-change-me';
if(process.env.NODE_ENV==='production'&&SESSION_SECRET.length<32)throw new Error('Set SESSION_SECRET to at least 32 characters in production.');
const tournaments = new Map();
const playerTokenIndex = new Map();
const socketInputTimes = new Map();

const sha = value => createHmac('sha256',SESSION_SECRET).update(value).digest('hex');
const parseCookies = request => Object.fromEntries((request.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
  const i = s.indexOf('='); return [decodeURIComponent(s.slice(0, i)), decodeURIComponent(s.slice(i + 1))];
}));
const now = () => Date.now();
const safeInt = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '1.2mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/join', rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: 'draft-7', legacyHeaders: false }));

function currentHost(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT h.id,h.email,h.display_name FROM sessions s JOIN hosts h ON h.id=s.host_id WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token), now());
  return row || null;
}
function requireHost(req, res, next) {
  const host = currentHost(req);
  if (!host) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.host = host;
  next();
}
function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== req.get('host') && !originAllowed(origin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
    } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  next();
}
function originAllowed(origin){
  if(!origin)return true;
  try{
    const parsed=new URL(origin);const configured=process.env.PUBLIC_BASE_URL?new URL(process.env.PUBLIC_BASE_URL).origin:null;
    if(configured&&parsed.origin===configured)return true;
    if(process.env.NODE_ENV==='production')return false;
    if(parsed.port!=='5173'&&parsed.port!=='5174')return false;
    return parsed.hostname==='localhost'||parsed.hostname==='127.0.0.1'||parsed.hostname==='::1'||/^10\./.test(parsed.hostname)||/^192\.168\./.test(parsed.hostname)||/^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname);
  }catch{return false;}
}
app.use('/api', sameOrigin);

function decodeQuiz(quizId, hostId) {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=? AND host_id=? AND archived=0').get(quizId, hostId);
  if (!quiz) return null;
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(quizId).map(q => ({
    id: q.id, question: q.question, answers: JSON.parse(q.answers_json), correctAnswerIndex: q.correct_index,
    explanation: q.explanation, timeLimit: q.time_limit, difficulty: q.difficulty,
    wrongAnswerDamage: q.wrong_damage, correctAnswerReward: q.correct_reward, image: q.image
  }));
  return { ...quiz, questions };
}
function insertQuiz(hostId, normalized, id = randomUUID()) {
  const insert = db.transaction(() => {
    db.prepare('INSERT INTO quizzes (id,host_id,title,description) VALUES (?,?,?,?)').run(id, hostId, normalized.title, normalized.description);
    const put = db.prepare(`INSERT INTO questions (id,quiz_id,position,question,answers_json,correct_index,explanation,time_limit,difficulty,wrong_damage,correct_reward,image)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    normalized.questions.forEach((q, i) => put.run(randomUUID(), id, i, q.question, JSON.stringify(q.answers), q.correctAnswerIndex,
      q.explanation, q.timeLimit, q.difficulty, q.wrongAnswerDamage, q.correctAnswerReward, q.image));
  });
  insert();
  return id;
}
function copyTemplates(hostId) {
  const templates = db.prepare('SELECT * FROM quiz_templates').all();
  const exists = db.prepare('SELECT COUNT(*) AS n FROM quizzes WHERE host_id=?').get(hostId).n;
  if (exists || !templates.length) return;
  const add = db.transaction(() => templates.forEach(template => {
    const data = JSON.parse(template.questions_json);
    const checked = validateQuiz({ title: template.title, description: template.description, questions: data });
    if (!checked.errors.length) insertQuiz(hostId, checked.value);
  }));
  add();
}
function setSessionCookie(res, token) {
  const prod = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${prod ? '; Secure' : ''}`);
}
function issueSession(hostId, res) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash,host_id,expires_at,created_at) VALUES (?,?,?,?)').run(sha(token), hostId, now() + SESSION_MS, now());
  setSessionCookie(res, token);
}
const defaultSettings = {
  mode: 'survival', rulePreset: 'educational', maxPlayers: 32, questionsPerMatch: 3,
  readingSeconds: 3, answerSeconds: 25, feedbackSeconds: 5, startingHp: 100,
  correctHealing: 10, wrongDamage: 25, unansweredDamage: 20, enemyDamage: 5,
  enemySpawnMs: 3800, antiCopy: true, allowSpectators: true, restSeconds: 5,
  randomQuestions: true, randomAnswers: true, sound: true,
  timeMode: 'question', damageMode: 'question', rewardMode: 'question'
};
function normalizeSettings(input = {}) {
  return {
    ...defaultSettings,
      mode: 'survival',
    rulePreset: input.rulePreset === 'arcade' ? 'arcade' : 'educational',
    maxPlayers: safeInt(input.maxPlayers, 32, 2, 100),
    questionsPerMatch: safeInt(input.questionsPerMatch, 3, 1, 30),
    readingSeconds: safeInt(input.readingSeconds, 3, 0, 15),
    answerSeconds: safeInt(input.answerSeconds, 25, 5, 120),
    feedbackSeconds: safeInt(input.feedbackSeconds, 5, 2, 20),
    startingHp: safeInt(input.startingHp, 100, 20, 300),
    correctHealing: safeInt(input.correctHealing, 10, 0, 100),
    wrongDamage: safeInt(input.wrongDamage, 25, 0, 100),
    unansweredDamage: safeInt(input.unansweredDamage, 20, 0, 100),
    enemyDamage: safeInt(input.enemyDamage, 5, 0, 40),
    enemySpawnMs: safeInt(input.enemySpawnMs, 3800, 1000, 15000),
    antiCopy: input.antiCopy !== false,
    allowSpectators: input.allowSpectators !== false,
    restSeconds: safeInt(input.restSeconds, 5, 2, 30),
    randomQuestions: input.randomQuestions !== false,
    randomAnswers: input.randomAnswers !== false,
    timeMode: input.timeMode === 'match' ? 'match' : 'question',
    damageMode: input.damageMode === 'match' ? 'match' : 'question',
    rewardMode: input.rewardMode === 'match' ? 'match' : 'question',
    sound: input.sound !== false
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'qba', activeTournaments: tournaments.size }));
app.post('/api/auth/register', (req, res) => {
  const { email, password, displayName } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (String(password || '').length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  if (process.env.ALLOW_REGISTRATION === 'false' && db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n > 0) return res.status(403).json({ error: 'New host registration is disabled.' });
  const name = String(displayName || '').trim().slice(0, 60) || normalizedEmail.split('@')[0];
  const id = randomUUID();
  try {
    db.prepare('INSERT INTO hosts (id,email,password_hash,display_name) VALUES (?,?,?,?)').run(id, normalizedEmail, bcrypt.hashSync(String(password), 12), name);
    copyTemplates(id);
    issueSession(id, res);
    res.status(201).json({ id, email: normalizedEmail, displayName: name });
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT') && /UNIQUE constraint failed: hosts\.email/i.test(String(e.message))) return res.status(409).json({ error: 'An account with that email already exists.' });
    throw e;
  }
});
app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const host = db.prepare('SELECT * FROM hosts WHERE email=?').get(email);
  if (!host || !bcrypt.compareSync(String(req.body?.password || ''), host.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
  issueSession(host.id, res);
  res.json({ id: host.id, email: host.email, displayName: host.display_name });
});
app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.get('/api/me', requireHost, (req, res) => res.json({ host: req.host }));

app.get('/api/quizzes', requireHost, (req, res) => {
  const rows = db.prepare('SELECT q.*, (SELECT COUNT(*) FROM questions x WHERE x.quiz_id=q.id) question_count FROM quizzes q WHERE host_id=? AND archived=0 ORDER BY updated_at DESC').all(req.host.id);
  res.json(rows);
});
app.post('/api/quizzes', requireHost, (req, res) => {
  const checked = validateQuiz(req.body);
  if (checked.errors.length) return res.status(400).json({ error: 'Please fix the quiz before saving.', details: checked.errors });
  const id = insertQuiz(req.host.id, checked.value);
  res.status(201).json(decodeQuiz(id, req.host.id));
});
app.get('/api/quizzes/:id', requireHost, (req, res) => {
  const quiz = decodeQuiz(req.params.id, req.host.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  res.json(quiz);
});
app.put('/api/quizzes/:id', requireHost, (req, res) => {
  const checked = validateQuiz(req.body);
  if (checked.errors.length) return res.status(400).json({ error: 'Please fix the quiz before saving.', details: checked.errors });
  const existing = db.prepare('SELECT id FROM quizzes WHERE id=? AND host_id=? AND archived=0').get(req.params.id, req.host.id);
  if (!existing) return res.status(404).json({ error: 'Quiz not found.' });
  const update = db.transaction(() => {
    db.prepare('UPDATE quizzes SET title=?,description=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(checked.value.title, checked.value.description, req.params.id);
    db.prepare('DELETE FROM questions WHERE quiz_id=?').run(req.params.id);
    const put = db.prepare(`INSERT INTO questions (id,quiz_id,position,question,answers_json,correct_index,explanation,time_limit,difficulty,wrong_damage,correct_reward,image)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    checked.value.questions.forEach((q, i) => put.run(randomUUID(), req.params.id, i, q.question, JSON.stringify(q.answers), q.correctAnswerIndex,
      q.explanation, q.timeLimit, q.difficulty, q.wrongAnswerDamage, q.correctAnswerReward, q.image));
  });
  update();
  res.json(decodeQuiz(req.params.id, req.host.id));
});
app.post('/api/quizzes/:id/duplicate', requireHost, (req, res) => {
  const quiz = decodeQuiz(req.params.id, req.host.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  quiz.title = `${quiz.title} (copy)`;
  quiz.questions = quiz.questions.map(q => ({ ...q, id: randomUUID() }));
  const checked = validateQuiz(quiz);
  const id = insertQuiz(req.host.id, checked.value);
  res.status(201).json(decodeQuiz(id, req.host.id));
});
app.delete('/api/quizzes/:id', requireHost, (req, res) => {
  const row = db.prepare('SELECT id FROM quizzes WHERE id=? AND host_id=? AND archived=0').get(req.params.id, req.host.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const inUse = db.prepare("SELECT COUNT(*) AS n FROM tournaments WHERE quiz_id=? AND status IN ('lobby','active','paused')").get(row.id).n;
  if (inUse) return res.status(409).json({ error: 'This quiz is attached to an open room. Finish or close the room before deleting it.' });
  const historicalUse = db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE quiz_id=?').get(row.id).n;
  if (historicalUse) {
    db.prepare('UPDATE quizzes SET archived=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
    db.prepare('DELETE FROM questions WHERE quiz_id=?').run(row.id);
  } else db.prepare('DELETE FROM quizzes WHERE id=?').run(row.id);
  res.json({ ok: true });
});

app.get('/api/tournaments', requireHost, (req, res) => {
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const rooms = [...tournaments.values()]
    .filter(t => t.hostId === req.host.id && ['lobby', 'active', 'paused'].includes(t.status))
    .sort((a,b) => b.createdAt - a.createdAt)
    .map(t => ({ ...lobbyView(t), joinUrl: `${base}/join/${t.publicId}` }));
  res.json(rooms);
});
app.post('/api/tournaments', requireHost, (req, res) => {
  const quiz = decodeQuiz(String(req.body?.quizId || ''), req.host.id);
  if (!quiz) return res.status(404).json({ error: 'Choose one of your saved quizzes.' });
  const settings = normalizeSettings(req.body?.settings);
  if (quiz.questions.length < settings.questionsPerMatch) return res.status(400).json({ error: `This quiz has ${quiz.questions.length} questions; ${settings.questionsPerMatch} are configured per match.` });
  const id = randomUUID();
  const publicId = randomBytes(7).toString('base64url');
  let roomCode;
  for (let i = 0; i < 10; i++) {
    roomCode = String(Math.floor(100000 + Math.random() * 900000));
    if (!db.prepare('SELECT 1 FROM tournaments WHERE room_code=?').get(roomCode)) break;
  }
  db.prepare('INSERT INTO tournaments (id,host_id,quiz_id,room_code,public_id,status,settings_json) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.host.id, quiz.id, roomCode, publicId, 'lobby', JSON.stringify(settings));
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const tournament = { id, publicId, roomCode, hostId: req.host.id, quizId: quiz.id, quizTitle: quiz.title, settings, createdAt: now(), players: new Map(), tokens: new Map(), matches: [], usedQuestionIds: new Set(), round: 0, status: 'lobby', paused: false, hostSocket: null, snapshot: null, timer: null, matchById: new Map() };
  tournaments.set(publicId, tournament);
  res.status(201).json({ id, publicId, roomCode, quizTitle: quiz.title, joinUrl: `${base}/join/${publicId}`, settings });
});
app.get('/api/tournaments/:publicId/qr', requireHost, async (req, res) => {
  const t = tournaments.get(req.params.publicId);
  if (!t || t.hostId !== req.host.id) return res.status(404).json({ error: 'Room not found.' });
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const joinUrl = `${base}/join/${t.publicId}`;
  res.json({ joinUrl, dataUrl: await QRCode.toDataURL(joinUrl, { width: 340, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#10152b', light: '#ffffff' } }) });
});
app.get('/api/tournaments/:publicId', requireHost, (req, res) => {
  const t = tournaments.get(req.params.publicId);
  if (!t || t.hostId !== req.host.id) return res.status(404).json({ error: 'Room not found or its server session has expired.' });
  res.json(lobbyView(t));
});
app.post('/api/tournaments/:publicId/lock', requireHost, (req, res) => {
  const t = ownedTournament(req, res);
  if (!t) return;
  t.locked = req.body?.locked !== false;
  broadcastLobby(t);
  res.json({ locked: t.locked });
});
app.delete('/api/tournaments/:publicId/players/:playerId', requireHost, (req, res) => {
  const t = ownedTournament(req, res);
  if (!t) return;
  if (t.status !== 'lobby') return res.status(409).json({ error: 'The roster is locked after tournament start.' });
  const player = t.players.get(req.params.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (player.socketId) {
    const connection = io.sockets.sockets.get(player.socketId);
    if (connection) {
      connection.emit('room:removed', { reason: 'The host removed you from this room.' });
      connection.leave(t.id);
      connection.disconnect(true);
    }
  }
  t.players.delete(player.id); t.tokens.delete(player.tokenHash); playerTokenIndex.delete(player.tokenHash);
  broadcastLobby(t);
  res.json({ ok: true });
});
function ownedTournament(req, res) {
  const t = tournaments.get(req.params.publicId);
  if (!t || t.hostId !== req.host.id) { res.status(404).json({ error: 'Room not found.' }); return null; }
  return t;
}
app.post('/api/join', (req, res) => {
  const code = String(req.body?.roomCode || '').trim();
  const publicIdIn = String(req.body?.publicId || '').trim();
  let t = publicIdIn ? tournaments.get(publicIdIn) : [...tournaments.values()].find(x => x.roomCode === code);
  if (!t || t.status !== 'lobby') return res.status(404).json({ error: 'Room code was not found or the tournament has already started.' });
  if (t.locked) return res.status(423).json({ error: 'This room is locked by the host.' });
  const nickname = String(req.body?.nickname || '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 24);
  if (nickname.length < 2) return res.status(400).json({ error: 'Nickname must be at least 2 characters.' });
  if (![...t.players.values()].some(p => p.nickname.toLocaleLowerCase() === nickname.toLocaleLowerCase())) {
    if (t.players.size >= t.settings.maxPlayers) return res.status(409).json({ error: 'This room has reached its player limit.' });
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha(token);
    const player = { id, nickname, character: CHARACTERS.includes(req.body?.character) ? req.body.character : 'bot', token, tokenHash, socketId: null, connected: false, hp: t.settings.startingHp, correct: 0, incorrect: 0, unanswered: 0, responseTotal: 0, streak: 0, damageTaken: 0, attempts: [], disconnectedAt: null };
    t.players.set(id, player); t.tokens.set(tokenHash, id); playerTokenIndex.set(tokenHash, { publicId: t.publicId, playerId: id });
    db.prepare('INSERT INTO tournament_players (id,tournament_id,nickname,character) VALUES (?,?,?,?)').run(id, t.id, nickname, player.character);
    return res.status(201).json({ token, playerId: id, nickname, publicId: t.publicId, roomCode: t.roomCode });
  }
  return res.status(409).json({ error: 'That nickname is already in use in this room.' });
});
app.get('/api/public-room/:publicId', (req, res) => {
  const t = tournaments.get(req.params.publicId) || [...tournaments.values()].find(x => x.roomCode === req.params.publicId);
  if (!t || t.status === 'complete' || t.status === 'closed') return res.status(404).json({ error: 'This room is no longer available.' });
  res.json({ publicId: t.publicId, roomCode: t.roomCode, status: t.status, locked: Boolean(t.locked), quizTitle: t.quizTitle, count: t.players.size, maxPlayers: t.settings.maxPlayers });
});
app.get('/api/results', requireHost, (req, res) => {
  const tournamentsFound = db.prepare('SELECT t.id,t.room_code,t.status,t.created_at,t.completed_at,q.title quiz_title,t.results_json FROM tournaments t JOIN quizzes q ON q.id=t.quiz_id WHERE t.host_id=? AND t.status IN (\'complete\',\'active\',\'paused\',\'closed\',\'interrupted\') ORDER BY t.created_at DESC LIMIT 200').all(req.host.id);
  const result = tournamentsFound.map(t => ({ ...t, results: t.results_json ? JSON.parse(t.results_json) : null, players: db.prepare('SELECT tp.id,tp.nickname,tp.character,tp.placement,tp.stats_json FROM tournament_players tp WHERE tournament_id=? ORDER BY placement').all(t.id).map(p => ({ ...p, stats: JSON.parse(p.stats_json) })) }));
  res.json(result);
});
app.get('/api/analytics', requireHost, (req, res) => {
  const tournamentsRows = db.prepare('SELECT id,room_code,quiz_snapshot_json,created_at FROM tournaments WHERE host_id=?').all(req.host.id);
  const tourMap = new Map(tournamentsRows.map(t => [t.id, t]));
  const attempts = db.prepare(`SELECT qa.tournament_id,qa.player_id,qa.question_id,qa.correct,qa.answered,qa.response_ms,qa.round_number,tp.nickname
    FROM question_attempts qa JOIN tournaments t ON t.id=qa.tournament_id JOIN tournament_players tp ON tp.id=qa.player_id
    WHERE t.host_id=? ORDER BY qa.rowid`).all(req.host.id).map(a => {
      const snapshot = JSON.parse(tourMap.get(a.tournament_id)?.quiz_snapshot_json || '[]');
      const q = snapshot.find(x => x.id === a.question_id);
      return { ...a, roomCode: tourMap.get(a.tournament_id)?.room_code, question: q?.question || 'Question from saved tournament snapshot', answers: q?.answers || [], correctAnswerIndex: q?.correctAnswerIndex ?? null };
    });
  const byQuestion = new Map();
  for (const a of attempts) {
    const row = byQuestion.get(`${a.tournament_id}:${a.question_id}`) || { tournamentId:a.tournament_id,roomCode:a.roomCode,questionId:a.question_id,question:a.question,total:0,correct:0,unanswered:0,responseTotal:0,responseCount:0 };
    row.total++; row.correct += a.correct ? 1 : 0; row.unanswered += a.answered ? 0 : 1; if (a.response_ms != null) { row.responseTotal += a.response_ms; row.responseCount++; }
    byQuestion.set(`${a.tournament_id}:${a.question_id}`,row);
  }
  const questionStats = [...byQuestion.values()].map(q => ({...q,accuracy:q.total?Math.round(100*q.correct/q.total):0,averageResponseMs:q.responseCount?Math.round(q.responseTotal/q.responseCount):null})).sort((a,b)=>a.accuracy-b.accuracy||b.total-a.total);
  const students = db.prepare(`SELECT tp.id,tp.nickname,tp.placement,tp.stats_json,t.room_code FROM tournament_players tp JOIN tournaments t ON t.id=tp.tournament_id WHERE t.host_id=? AND t.status IN ('complete','active','paused','interrupted') ORDER BY t.created_at DESC`).all(req.host.id).map(p=>({...p,stats:JSON.parse(p.stats_json)}));
  const total=attempts.length, correct=attempts.filter(a=>a.correct).length;
  res.json({totalAttempts:total,correct,accuracy:total?Math.round(100*correct/total):0,averageResponseMs:attempts.filter(a=>a.response_ms!=null).length?Math.round(attempts.reduce((n,a)=>n+(a.response_ms||0),0)/attempts.filter(a=>a.response_ms!=null).length):null,questionStats,students,attempts});
});
app.get('/api/results/:tournamentId/export.csv', requireHost, (req, res) => {
  const tour = db.prepare('SELECT * FROM tournaments WHERE id=? AND host_id=?').get(req.params.tournamentId, req.host.id);
  if (!tour) return res.status(404).json({ error: 'Tournament results not found.' });
  const rows = db.prepare(`SELECT tp.nickname,tp.placement,qa.question_id,qa.correct,qa.response_ms,qa.round_number
    FROM tournament_players tp LEFT JOIN question_attempts qa ON qa.player_id=tp.id AND qa.tournament_id=tp.tournament_id
    WHERE tp.tournament_id=? ORDER BY tp.placement,qa.round_number`).all(tour.id);
  const csvCell = value => {
    let text = String(value ?? '');
    if (/^[=+@\t\r]/.test(text) || /^-\D/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  const csv = ['nickname,placement,question_id,correct,response_ms,round', ...rows.map(r => [r.nickname,r.placement ?? '',r.question_id ?? '',r.correct ?? '',r.response_ms ?? '',r.round_number ?? ''].map(csvCell).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="qba-results-${tour.room_code}.csv"`); res.send(csv);
});

function lobbyView(t) {
  return { id: t.id, publicId: t.publicId, roomCode: t.roomCode, quizTitle: t.quizTitle, status: t.status, paused: !!t.paused, locked: !!t.locked,
    settings: t.settings, playerCount: t.players.size, connectedCount: [...t.players.values()].filter(p=>p.connected).length, players: [...t.players.values()].map(p => ({ id: p.id, nickname: p.nickname, character: p.character, connected: p.connected })),
    round: t.round, bracket: t.bracket || [] };
}
function broadcastLobby(t) { io.to(t.id).emit('room:lobby', lobbyView(t)); }

const socketCookieHost = socket => {
  const token = parseCookies({ headers: { cookie: socket.handshake.headers.cookie || '' } })[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT h.id,h.email,h.display_name FROM sessions s JOIN hosts h ON h.id=s.host_id WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token), now());
  return row || null;
};
io.on('connection', socket => {
  socket.on('host:attach', ({ publicId } = {}) => {
    const host = socketCookieHost(socket);
    const t = tournaments.get(String(publicId || ''));
    if (!host || !t || t.hostId !== host.id) return socket.emit('room:error', { error: 'Host authorization failed.' });
    socket.data.role = 'host'; socket.data.publicId = t.publicId; socket.data.hostId = host.id;
    t.hostSocket = socket.id; socket.join(t.id);
    socket.emit('room:lobby', lobbyView(t));
    socket.emit('tournament:state', bracketView(t));
    emitHostSnapshots(t, socket);
  });
  socket.on('player:attach', ({ token } = {}) => {
    const record = playerTokenIndex.get(sha(String(token || '')));
    const t = record && tournaments.get(record.publicId);
    const player = t?.players.get(record.playerId);
    if (!player) return socket.emit('room:error', { error: 'Player session expired. Rejoin from the room link.' });
    if (player.reconnectTimer) clearTimeout(player.reconnectTimer);
    if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
    player.socketId = socket.id; player.connected = true; player.disconnectedAt = null; player.lastInputSeq = 0; player.input={x:0,y:0};
    socket.data.role = 'player'; socket.data.publicId = t.publicId; socket.data.playerId = player.id; socket.join(t.id);
    socket.emit('player:ready', { playerId: player.id, nickname: player.nickname, status: t.status });
    broadcastLobby(t);
    if (t.status !== 'lobby') sendPlayerGameState(t, player);
    io.to(t.id).emit('player:connection', { playerId: player.id, connected: true });
  });
  socket.on('spectator:attach', ({ publicId } = {}) => {
    const t = tournaments.get(String(publicId || ''));
    if (!t || !t.settings.allowSpectators) return socket.emit('room:error', { error: 'Spectating is not enabled for this room.' });
    if(t.hostSocket===socket.id)t.hostSocket=null;
    socket.data.role = 'spectator'; socket.data.publicId = t.publicId; socket.join(t.id);
    socket.emit('room:lobby', lobbyView(t)); socket.emit('tournament:state', bracketView(t)); emitHostSnapshots(t, socket);
  });
  socket.on('game:input', input => {
    const d = socket.data;
    if (d.role !== 'player') return;
    const t = tournaments.get(d.publicId);
    const player = t?.players.get(d.playerId);
    const game = t?.matchById.get(player?.matchId);
    if (!player || !game || game.status !== 'active' || game.phase !== 'ACTIVE') return;
    const stamp = socketInputTimes.get(socket.id) || [];
    const cutoff = now() - 1000;
    const recent = stamp.filter(x => x > cutoff);
    if (recent.length >= 30) return;
    recent.push(now()); socketInputTimes.set(socket.id, recent);
    const x = Number(input?.x), y = Number(input?.y), seq = safeInt(input?.seq, 0, 0, 1e9);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (seq <= (player.lastInputSeq || 0)) return;
    player.lastInputSeq = seq;
    player.input = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)), dash: input?.dash === true, ability: input?.ability === true, seq };
  });
  socket.on('host:start', () => {
    const d = socket.data, t = tournaments.get(d.publicId);
    if (!t || d.role !== 'host' || t.hostId !== d.hostId) return socket.emit('room:error', { error: 'Host authorization failed.' });
    if (t.status !== 'lobby') return socket.emit('room:error', { error: 'Tournament already started.' });
    const players = [...t.players.values()];
    if (players.filter(player=>player.connected).length < 2) return socket.emit('room:error', { error: 'At least two connected players are needed to start.' });
    if (players.length > t.settings.maxPlayers) return socket.emit('room:error', { error: 'Player limit exceeded.' });
    const source = decodeQuiz(t.quizId, t.hostId);
    if (!source || source.questions.length < t.settings.questionsPerMatch) return socket.emit('room:error', { error: 'The quiz no longer has enough questions.' });
    // Frozen copies isolate a running tournament from later quiz edits.
    t.snapshot = source.questions.map(q=>({...structuredClone(q),
      timeLimit:t.settings.timeMode==='match'?t.settings.answerSeconds:q.timeLimit,
      wrongAnswerDamage:t.settings.damageMode==='match'?t.settings.wrongDamage:q.wrongAnswerDamage,
      correctAnswerReward:t.settings.rewardMode==='match'?t.settings.correctHealing:q.correctAnswerReward
    }));
    t.status = 'active'; t.startedAt = now(); t.round = 0;
    db.prepare("UPDATE tournaments SET status='active',quiz_snapshot_json=? WHERE id=?").run(JSON.stringify(t.snapshot), t.id);
    startRound(t, players.map(p => p.id));
    broadcastLobby(t); io.to(t.id).emit('tournament:state', bracketView(t));
  });
  socket.on('host:pause', () => {
    const t = tournaments.get(socket.data.publicId);
    if (!t || socket.data.role !== 'host' || t.hostId !== socket.data.hostId || t.status !== 'active') return;
    if (!t.paused) { t.paused = true; t.status = 'paused'; t.pauseAt = now(); db.prepare("UPDATE tournaments SET status='paused' WHERE id=?").run(t.id); }
    io.to(t.id).emit('tournament:paused', { paused: true });
    broadcastLobby(t);
  });
  socket.on('host:resume', () => {
    const t = tournaments.get(socket.data.publicId);
    if (!t || socket.data.role !== 'host' || t.hostId !== socket.data.hostId || !t.paused) return;
    const delta = now() - t.pauseAt;
    for (const g of t.matchById.values()) if (g.endsAt) g.endsAt += delta;
    for (const g of t.matchById.values()) {
      if(g.answerStartedAt)g.answerStartedAt+=delta;
      if(g.nextEnemyAt)g.nextEnemyAt+=delta;
      for(const h of g.hazards){h.epoch+=delta;for(const key of Object.keys(h.hitAt))h.hitAt[key]+=delta;}
      for(const state of g.players.values())for(const key of ['nextDamageAt','invulnerableUntil','dashUntil','dashActiveUntil','abilityCooldownUntil','shieldUntil','speedUntil'])if(state[key])state[key]+=delta;
    }
    for (const g of t.matchById.values()) for (const e of g.enemies) if (e.attackAt) e.attackAt += delta;
    t.paused = false; t.pauseAt = null; t.status = 'active'; db.prepare("UPDATE tournaments SET status='active' WHERE id=?").run(t.id);
    io.to(t.id).emit('tournament:paused', { paused: false });
    broadcastLobby(t);
  });
  socket.on('host:close', () => {
    const t = tournaments.get(socket.data.publicId);
    if (!t || socket.data.role !== 'host' || t.hostId !== socket.data.hostId || t.status === 'complete') return;
    closeTournament(t);
  });
  socket.on('disconnect', () => {
    socketInputTimes.delete(socket.id);
    const d = socket.data;
    const t = tournaments.get(d.publicId);
    if (d.role === 'host' && t?.hostSocket === socket.id) t.hostSocket = null;
    if (d.role === 'player' && t) {
      const p = t.players.get(d.playerId);
      if (p?.socketId === socket.id) {
        p.socketId = null; p.connected = false; p.disconnectedAt = now(); p.input={x:0,y:0};
        broadcastLobby(t);
        io.to(t.id).emit('player:connection', { playerId: p.id, connected: false });
        if (t.status === 'active' || t.status === 'paused') p.reconnectTimer = setTimeout(() => forfeitDisconnected(t, p), 30000);
      }
    }
  });
});

function makeBracketRound(t, pairs, byes) {
  const rows = [];
  for (const id of byes) {
    const p = t.players.get(id); if (p) rows.push({ id: randomUUID(), round: t.round, players: [id], winnerId: id, status: 'bye' });
  }
  for (const pair of pairs) rows.push({ id: randomUUID(), round: t.round, players: pair, winnerId: null, status: 'active' });
  t.bracket ||= []; t.bracket.push(...rows);
  const insert = db.prepare('INSERT INTO matches (id,tournament_id,round_number,player_a_id,player_b_id,winner_id,status) VALUES (?,?,?,?,?,?,?)');
  for (const row of rows) insert.run(row.id, t.id, t.round, row.players[0], row.players[1] || null, row.winnerId, row.status);
  const questionSet = pickRoundQuestions(t);
  t.currentRoundQuestionIds = questionSet.map(q => q.id);
  for (const row of rows.filter(x => x.status === 'active')) {
    const game = newGame(t, row, questionSet);
    t.matchById.set(game.id, game); t.matches.push(game);
    for (const pid of game.playerIds) {
      const p = t.players.get(pid); if (p) { p.matchId = game.id; p.hp = t.settings.startingHp; p.input = { x: 0, y: 0 }; if(!p.connected)p.reconnectTimer=setTimeout(()=>forfeitDisconnected(t,p),30000); }
    }
    io.to(t.id).emit('match:started', { matchId: game.id, round: t.round, players: row.players.map(id => ({ id, nickname: t.players.get(id)?.nickname })) });
  }
  const winners = byes.slice();
  if (rows.every(row => row.status === 'bye')) return completeTournament(t, winners);
  broadcastLobby(t); io.to(t.id).emit('tournament:state', bracketView(t));
}
function startRound(t, ids) {
  if (!ids.length) return completeTournament(t, []);
  if (ids.length === 1) return completeTournament(t, ids);
  t.round += 1;
  const { pairs, byes } = pairPlayers(ids);
  makeBracketRound(t, pairs, byes);
}
function pickRoundQuestions(t) {
  const pool = [...t.snapshot].filter(q => !t.usedQuestionIds.has(q.id));
  if (pool.length < t.settings.questionsPerMatch) t.usedQuestionIds.clear();
  let available = [...t.snapshot].filter(q => !t.usedQuestionIds.has(q.id));
  if (t.settings.randomQuestions) available.sort(() => Math.random() - 0.5);
  const selected = available.slice(0, t.settings.questionsPerMatch).map(question=>{
    if(!t.settings.randomAnswers)return structuredClone(question);
    const positions=question.answers.map((_a,i)=>i).sort(()=>Math.random()-.5);
    const answers=positions.map(i=>question.answers[i]);
    return {...question,answers,correctAnswerIndex:positions.indexOf(question.correctAnswerIndex)};
  });
  for (const q of selected) t.usedQuestionIds.add(q.id);
  return selected;
}
function newGame(t, bracketMatch, questions) {
  const [left, right] = bracketMatch.players;
  const game = {
    id: bracketMatch.id, bracketId: bracketMatch.id, round: bracketMatch.round, playerIds: [left,right], status: 'active',
    phase: 'PREPARE', phaseNumber: 0, endsAt: now() + 1200, questions, questionIndex: 0,
    players: new Map(), enemies: [], hazards: [], zoneMap:new Map(), nextEnemyAt: now() + t.settings.enemySpawnMs, nextSnapshotAt: 0,
    settings: t.settings, feedback: null, suddenDeaths: 0
  };
  const starts = [{ x: 250, y: 270 }, { x: 710, y: 270 }];
  for (let i = 0; i < 2; i++) {
    const p = t.players.get(game.playerIds[i]);
    game.players.set(p.id, { x: starts[i].x, y: starts[i].y, hp: t.settings.startingHp, maxHp: t.settings.startingHp, correct: 0, incorrect: 0, unanswered: 0, responseTotal: 0, streak: 0, damageTaken: 0, alive: true, zoneSince: null, lockedAnswer: null, invulnerableUntil: 0, nextDamageAt: 0, dashUntil: 0, abilityCooldownUntil: 0, shieldUntil: 0, speedUntil: 0 });
  }
  return game;
}
function setQuestion(game, t) {
  const q = game.questions[game.questionIndex % game.questions.length];
  game.question = q; game.phase = 'READING'; game.phaseNumber += 1;
  game.answerStartedAt = 0; game.endsAt = now() + t.settings.readingSeconds * 1000;
  game.zoneMap = new Map();
  game.hazards = [{x:150,y:150},{x:810,y:390},{x:150,y:390},{x:810,y:150}].map((h,i)=>({...h,id:`spike-${i}`,epoch:now()+t.settings.readingSeconds*1000+800,hitAt:{}}));
  for (const playerId of game.playerIds) {
    const angles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5].sort(() => Math.random() - 0.5);
    const centerX=game.players.get(playerId).x;
    const map = q.answers.map((_a, i) => ({ x: Math.round(centerX + Math.cos(angles[i]) * 165), y: Math.round(270 + Math.sin(angles[i]) * 145), letter: 'ABCD'[i], index: i }));
    game.zoneMap.set(playerId, map);
    const state = game.players.get(playerId); state.lockedAnswer = null; state.zoneSince = null;
    const player = t.players.get(playerId); if (player) player.input = { x: 0, y: 0, dash: false, ability: false };
  }
  for (const pid of game.playerIds) {
    const p = t.players.get(pid);
    if (p?.socketId) io.to(p.socketId).emit('game:question', publicQuestion(q, t.settings, game.questionIndex + 1, game.questions.length, (game.zoneMap.get(pid) || []).map(z => ({ letter: z.letter, x: z.x, y: z.y }))));
  }
  publishGame(t, game);
}
function transitionPhase(t, game, phase, duration, extra = {}) {
  game.phase = phase; game.endsAt = now() + duration;
  const payload={ matchId: game.id, phase, endsAt: game.endsAt, ...extra };
  for(const id of game.playerIds){const player=t.players.get(id);if(player?.socketId)io.to(player.socketId).emit('game:phase',payload);}
  if(t.hostSocket)io.to(t.hostSocket).emit('game:phase',{matchId:game.id,phase,endsAt:game.endsAt});
  publishGame(t, game);
}
function tickGame(t, game, dt) {
  if (game.status !== 'active') return;
  const current = now();
  if (game.phase === 'PREPARE' && current >= game.endsAt) return setQuestion(game, t);
  if (game.phase === 'READING' && current >= game.endsAt) {
    game.answerStartedAt = current;
    game.phase = 'ACTIVE'; game.endsAt = current + (game.question?.timeLimit || t.settings.answerSeconds) * 1000;
    game.nextEnemyAt = current + 1000;
    io.to(t.id).emit('game:phase', { matchId: game.id, phase: game.phase, endsAt: game.endsAt });
    publishGame(t, game);
  }
  if (game.phase === 'ACTIVE') {
    movePlayers(t, game, dt, current);
    moveHazards(t, game, current);
    moveEnemies(t, game, dt, current);
    if (game.playerIds.every(id => game.players.get(id)?.lockedAnswer !== null) && game.phase === 'ACTIVE') {
      game.phase = 'ANSWER_LOCK'; game.endsAt = current + 350;
      io.to(t.id).emit('game:phase', { matchId: game.id, phase: game.phase, endsAt: game.endsAt });
    }
    if (current >= game.endsAt && game.phase === 'ACTIVE') {
      game.phase = 'ANSWER_LOCK'; game.endsAt = current + 250;
      io.to(t.id).emit('game:phase', { matchId: game.id, phase: game.phase, endsAt: game.endsAt });
    }
  }
  if (game.phase === 'ANSWER_LOCK' && current >= game.endsAt) resolveQuestion(t, game);
  if (game.phase === 'FEEDBACK' && current >= game.endsAt) continueAfterFeedback(t, game);
  if (current >= game.nextSnapshotAt && game.status === 'active') { game.nextSnapshotAt = current + 50; publishGame(t, game); }
}
function movePlayers(t, game, dt, current) {
  for (const [id, s] of game.players) {
    if (!s.alive || s.lockedAnswer !== null) continue;
    const p = t.players.get(id); const input = p?.input || { x: 0, y: 0 };
    if (input.dash && current >= s.dashUntil) { s.dashUntil = current + 2200; s.dashActiveUntil = current + 220; }
    if (input.ability && current >= s.abilityCooldownUntil) { s.abilityCooldownUntil = current + 6000; s.shieldUntil = current + 4500; }
    const mag = Math.hypot(input.x, input.y) || 1;
    const dash = current < s.dashActiveUntil;
    const boost = current < s.speedUntil;
    const speed = (dash ? 500 : boost ? 250 : 190) * Math.min(1, mag);
    s.x = Math.max(26, Math.min(934, s.x + input.x / mag * speed * dt));
    s.y = Math.max(26, Math.min(514, s.y + input.y / mag * speed * dt));
    const zones = game.zoneMap.get(id) || [];
    const found = zones.find(z => Math.hypot(z.x - s.x, z.y - s.y) < 40);
    if (found) {
      if (s.zoneSince?.index !== found.index) s.zoneSince = { index: found.index, at: current };
      else if (current - s.zoneSince.at >= 750) {
        s.lockedAnswer = found.index; s.lockedAt = current; s.invulnerableUntil = current + Math.max(0, game.endsAt - current) + 1000;
        p.answerTiming = current - game.answerStartedAt;
        io.to(p.socketId || '').emit('game:locked', { matchId: game.id });
      }
    } else s.zoneSince = null;
  }
}
function moveHazards(t, game, current) {
  for(const hazard of game.hazards){
    const cycle=(current-hazard.epoch+6500)%6500;const active=cycle>=1200&&cycle<3100;
    if(!active)continue;
    for(const [id,state] of game.players){
      if(!state.alive||state.lockedAnswer!==null||Math.hypot(state.x-hazard.x,state.y-hazard.y)>32||current<(hazard.hitAt[id]||0)||current<state.invulnerableUntil||current<state.shieldUntil)continue;
      const damage=10;state.hp=Math.max(game.settings.rulePreset==='educational'?1:0,state.hp-damage);state.damageTaken+=damage;state.invulnerableUntil=current+1200;hazard.hitAt[id]=current+1400;
      const player=t.players.get(id);if(player){player.hp=state.hp;player.damageTaken=(player.damageTaken||0)+damage;}
      if(state.hp<=0)state.alive=false;
      if(player?.socketId)io.to(player.socketId).emit('game:damage',{amount:damage,hp:state.hp,hazard:'spike'});
    }
  }
}
function moveEnemies(t, game, dt, current) {
  if (current >= game.nextEnemyAt && game.enemies.length < 14) {
    let spawn=null;
    for(let attempt=0;attempt<18&&!spawn;attempt++){
      const angle=Math.random()*Math.PI*2;const candidate={x:Math.max(40,Math.min(920,480+Math.cos(angle)*390)),y:Math.max(40,Math.min(500,270+Math.sin(angle)*190))};
      const nearPlayer=[...game.players.values()].some(p=>Math.hypot(p.x-candidate.x,p.y-candidate.y)<90);
      const nearZone=[...game.zoneMap.values()].flat().some(z=>Math.hypot(z.x-candidate.x,z.y-candidate.y)<75);
      if(!nearPlayer&&!nearZone)spawn=candidate;
    }
    if(spawn)game.enemies.push({ id: randomUUID(), ...spawn, hp: 1, speed: 45 + Math.random() * 22, attackAt: 0 });
    game.nextEnemyAt = current + game.settings.enemySpawnMs;
  }
  for (const enemy of game.enemies) {
    const targets = [...game.players.entries()].filter(([,p]) => p.alive && p.lockedAnswer === null);
    if (!targets.length) break;
    targets.sort((a,b) => Math.hypot(a[1].x-enemy.x,a[1].y-enemy.y) - Math.hypot(b[1].x-enemy.x,b[1].y-enemy.y));
    const [id, target] = targets[0];
    const dx = target.x - enemy.x, dy = target.y - enemy.y, dist = Math.hypot(dx,dy) || 1;
    if (dist > 28) { enemy.x += dx / dist * enemy.speed * dt; enemy.y += dy / dist * enemy.speed * dt; }
    else if (current >= enemy.attackAt && current >= target.nextDamageAt && current >= target.invulnerableUntil && current >= target.shieldUntil) {
      const damage = game.settings.enemyDamage; target.hp = Math.max(game.settings.rulePreset === 'educational' ? 1 : 0, target.hp - damage); target.damageTaken += damage;
      const playerRecord=t.players.get(id); if(playerRecord){playerRecord.hp=target.hp;playerRecord.damageTaken=(playerRecord.damageTaken||0)+damage;}
      target.nextDamageAt = current + 1100; target.invulnerableUntil = current + 800; enemy.attackAt = current + 1100;
      if (target.hp <= 0) target.alive = false;
      io.to(id === game.playerIds[0] ? t.players.get(id)?.socketId || '' : t.players.get(id)?.socketId || '').emit('game:damage', { amount: damage, hp: target.hp, environmental: true });
    }
  }
}
function resolveQuestion(t, game) {
  const q = game.question;
  const outcome = [];
  for (const id of game.playerIds) {
    const s = game.players.get(id), p = t.players.get(id);
    if (!s || !p) continue;
    const selected = s.lockedAnswer;
    const answered = selected !== null;
    const correct = answered && selected === q.correctAnswerIndex;
    const responseMs = answered ? Math.max(0, s.lockedAt - game.answerStartedAt) : null;
    if (correct) { s.correct++; s.streak++; s.hp = Math.min(s.maxHp, s.hp + q.correctAnswerReward); s.shieldUntil = now() + 900; p.correct++; p.streak++; p.answerTiming = responseMs; p.responseTotal += responseMs; }
    else if (answered) { s.incorrect++; s.streak = 0; s.hp = Math.max(0, s.hp - (q.wrongAnswerDamage ?? game.settings.wrongDamage)); p.incorrect++; }
    else { s.unanswered++; s.streak = 0; s.hp = Math.max(0, s.hp - game.settings.unansweredDamage); p.unanswered++; }
    p.hp = s.hp; p.damageTaken = (p.damageTaken || 0) + Math.max(0, (p.hpBeforeQuestion ?? game.settings.startingHp) - s.hp); p.hpBeforeQuestion = s.hp;
    if (s.hp <= 0) s.alive = false;
    const record = { questionId: q.id, correct: Boolean(correct), responseMs, round: game.round };
    p.attempts.push(record);
    db.prepare('INSERT INTO question_attempts (id,tournament_id,player_id,question_id,correct,answered,response_ms,round_number) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), t.id, id, q.id, correct ? 1 : 0, answered ? 1 : 0, responseMs, game.round);
    outcome.push({ playerId: id, correct: Boolean(correct), answered, hp: s.hp, correctCount: s.correct, selected: game.settings.antiCopy ? undefined : selected });
  }
  game.feedback = { questionId: q.id, correctAnswerIndex: q.correctAnswerIndex, explanation: q.explanation, outcome };
  transitionPhase(t, game, 'FEEDBACK', game.settings.feedbackSeconds * 1000, { result: game.feedback });
}
function continueAfterFeedback(t, game) {
  const [a,b] = game.playerIds.map(id => game.players.get(id));
  const contender = [a,b].filter(Boolean);
  if (contender.some(p => !p.alive) || game.questionIndex + 1 >= game.questions.length) {
    let cmp = comparePlayers(a, b);
    if (cmp === 0 && (a.alive === false || b.alive === false)) cmp = a.alive ? 1 : -1;
    if (cmp !== 0) return endMatch(t, game, cmp > 0 ? game.playerIds[0] : game.playerIds[1]);
    if (game.suddenDeaths >= 3) {
      const pa = t.players.get(game.playerIds[0]), pb = t.players.get(game.playerIds[1]);
      const winner = pa.nickname.localeCompare(pb.nickname, undefined, { sensitivity: 'base' }) <= 0 ? pa.id : pb.id;
      return endMatch(t, game, winner, 'sudden-death tie resolved by nickname order');
    }
    game.suddenDeaths++; game.questionIndex++;
    const remaining = t.snapshot.filter(q => q.id !== game.question?.id);
    game.questions.push(remaining[Math.floor(Math.random() * Math.max(remaining.length, 1))] || game.question);
  } else game.questionIndex++;
  game.phase = 'PREPARE'; game.endsAt = now() + 900; game.feedback = null;
  publishGame(t, game);
}
function endMatch(t, game, winnerId, note = '') {
  if (game.status !== 'active') return;
  game.status = 'complete'; game.phase = 'COMPLETE'; game.winnerId = winnerId; game.endsAt = now();
  const stats = Object.fromEntries(game.playerIds.map(id => [id, { ...game.players.get(id), nickname: t.players.get(id)?.nickname }]));
  db.prepare("UPDATE matches SET winner_id=?,status='complete',stats_json=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(winnerId, JSON.stringify(stats), game.id);
  const row = t.bracket.find(x => x.id === game.bracketId); if (row) { row.winnerId = winnerId; row.status = 'complete'; }
  for (const id of game.playerIds) {
    const p = t.players.get(id); if (p) p.matchId = null;
  }
  io.to(t.id).emit('match:result', { matchId: game.id, winnerId, players: game.playerIds.map(id => {
    const p = t.players.get(id), s = game.players.get(id); return { id, nickname: p?.nickname, correct: s?.correct, hp: s?.hp, alive: s?.alive, accuracy: s?.correct + s?.incorrect + s?.unanswered ? Math.round(s.correct / (s.correct + s.incorrect + s.unanswered) * 100) : 0 };
  }), note });
  publishGame(t, game);
  io.to(t.id).emit('tournament:state', bracketView(t));
  maybeAdvance(t);
}
function maybeAdvance(t) {
  const roundRows = (t.bracket || []).filter(row => row.round === t.round);
  if (!roundRows.length || roundRows.some(row => row.status === 'active')) return;
  const winners = roundRows.map(row => row.winnerId).filter(Boolean);
  if (winners.length <= 1) return completeTournament(t, winners);
  setTimeout(() => { if ((t.status === 'active' || t.status === 'paused') && t.round === roundRows[0].round) startRound(t, winners); }, t.settings.restSeconds * 1000);
}
function completeTournament(t, winners) {
  if (t.status === 'complete') return;
  t.status = 'complete';
  const champion = winners[0] || null;
  const academic = [...t.players.values()].sort((a,b) => b.correct - a.correct || a.responseTotal - b.responseTotal || b.hp - a.hp);
  const eliminationRound=new Map();
  for(const match of t.bracket||[])for(const pid of match.players)if(match.winnerId!==pid)eliminationRound.set(pid,Math.max(eliminationRound.get(pid)||0,match.round));
  const gameRanked=[...t.players.values()].sort((a,b)=>{
    if(a.id===champion)return -1;if(b.id===champion)return 1;
    return (eliminationRound.get(b.id)||0)-(eliminationRound.get(a.id)||0)||b.hp-a.hp||b.correct-a.correct||a.responseTotal-b.responseTotal;
  });
  gameRanked.forEach((p,i) => {
    const placement = i+1;
    db.prepare('UPDATE tournament_players SET placement=?,stats_json=? WHERE id=?').run(placement, JSON.stringify({ correct:p.correct,incorrect:p.incorrect,unanswered:p.unanswered,accuracy:p.correct + p.incorrect ? Math.round(p.correct/(p.correct+p.incorrect+p.unanswered)*100) : 0,responseTotal:p.responseTotal,damageTaken:p.damageTaken }), p.id);
  });
  const results = { champion: champion ? { id: champion, nickname: t.players.get(champion)?.nickname } : null,
    educationalRanking: academic.map((p,i) => ({ id:p.id,nickname:p.nickname,rank:i+1,correct:p.correct,incorrect:p.incorrect,unanswered:p.unanswered,accuracy:p.correct+p.incorrect+p.unanswered?Math.round(p.correct/(p.correct+p.incorrect+p.unanswered)*100):0,responseTotal:p.responseTotal })),
    gamingRanking: gameRanked.map((p,i)=>({id:p.id,nickname:p.nickname,placement:i+1,hp:p.hp})) };
  db.prepare("UPDATE tournaments SET status='complete',results_json=?,completed_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(results), t.id);
  io.to(t.id).emit('tournament:complete', results); io.to(t.id).emit('tournament:state', bracketView(t));
  if (t.timer) clearInterval(t.timer);
}
function closeTournament(t) {
  t.status = 'closed'; if (t.timer) clearInterval(t.timer);
  db.prepare("UPDATE tournaments SET status='closed' WHERE id=?").run(t.id);
  io.to(t.id).emit('tournament:closed', { message: 'The host closed this tournament.' });
}
function forfeitDisconnected(t, player) {
  if (player.connected || !player.matchId || !['active','paused'].includes(t.status)) return;
  if (t.paused) { player.reconnectTimer=setTimeout(()=>forfeitDisconnected(t,player),1000); return; }
  const game = t.matchById.get(player.matchId);
  if (!game || game.status !== 'active') return;
  const opponent = game.playerIds.find(id => id !== player.id);
  const state = game.players.get(player.id); if (state) { state.alive = false; state.hp = 0; }
  endMatch(t, game, opponent, 'player did not reconnect within 30 seconds');
}
function sendPlayerGameState(t, player) {
  const game = t.matchById.get(player.matchId);
  if (game) { socketEmitPlayer(player, 'game:question', game); publishOne(t, game, player); }
  else if (t.status === 'active') io.to(player.socketId).emit('player:waiting', { round: t.round, bracket: bracketView(t) });
}
function socketEmitPlayer(player, event, game) {
  if (!player.socketId) return;
  if (event === 'game:question' && game.question) {
    const t = [...tournaments.values()].find(x => x.players.get(player.id) === player);
    if (t) io.to(player.socketId).emit(event, publicQuestion(game.question, t.settings, game.questionIndex + 1, game.questions.length, (game.zoneMap.get(player.id) || []).map(z => ({ letter:z.letter,x:z.x,y:z.y }))));
  }
}
function gamePublicState(t, game, forPlayerId = null) {
  const self = game.players.get(forPlayerId);
  const players = game.playerIds.map(id => {
    const p = t.players.get(id), s = game.players.get(id);
    const hidden = forPlayerId && id !== forPlayerId && t.settings.antiCopy && ['ACTIVE','ANSWER_LOCK'].includes(game.phase);
    return { id, nickname:p?.nickname, x:hidden?null:s?.x, y:hidden?null:s?.y, hp:s?.hp, maxHp:s?.maxHp, correct:s?.correct, alive:s?.alive, locked:s?.lockedAnswer!==null };
  });
  const zones = forPlayerId ? (game.zoneMap.get(forPlayerId) || []) : [];
  const hazards=game.hazards.map(h=>{const phase=(now()-h.epoch+6500)%6500;return{id:h.id,x:h.x,y:h.y,warning:phase<1200,active:phase>=1200&&phase<3100};});
  return { matchId:game.id,round:game.round,phase:game.phase,endsAt:game.endsAt,questionNumber:game.questionIndex+1,total:game.questions.length,
    world:{width:960,height:540},players,enemies:game.enemies.map(e => ({id:e.id,x:Math.round(e.x),y:Math.round(e.y)})),hazards,zones,
    feedback:game.feedback,question:game.question ? {question:game.question.question,answers:[...game.question.answers],timeLimit:game.question.timeLimit} : null,
    self:{id:forPlayerId,x:self?.x,y:self?.y,hp:self?.hp,maxHp:self?.maxHp,correct:self?.correct,locked:self?.lockedAnswer!==null,alive:self?.alive,dashReady:now()>=(self?.dashUntil||0)} };
}
function publishOne(t, game, player) { if (player.socketId) io.to(player.socketId).emit('game:state', gamePublicState(t,game,player.id)); }
function publishGame(t, game) {
  for (const id of game.playerIds) { const p=t.players.get(id); if (p?.socketId) publishOne(t,game,p); }
  if (now() >= (game.nextPreviewAt || 0)) {
    game.nextPreviewAt = now() + 500;
    const preview = { matchId:game.id,round:game.round,phase:game.phase,endsAt:game.endsAt,question:game.question?.question||null,players:game.playerIds.map(id=>{const p=t.players.get(id),s=game.players.get(id);return{id,nickname:p?.nickname,hp:s?.hp,maxHp:s?.maxHp,x:s?.x,y:s?.y,alive:s?.alive,correct:s?.correct};}),enemies:game.enemies.map(e=>({x:e.x,y:e.y})) };
    if (t.hostSocket) io.to(t.hostSocket).emit('battle:preview', preview);
    for (const spectator of io.sockets.sockets.values()) if (spectator.data.role === 'spectator' && spectator.data.publicId === t.publicId) spectator.emit('battle:preview', preview);
  }
}
function emitHostSnapshots(t, targetSocket = null) {
  const games=[...t.matchById.values()].filter(g=>g.status==='active');
  const payload=games.map(g=>({matchId:g.id,round:g.round,phase:g.phase,endsAt:g.endsAt,question:g.question?.question||null,players:g.playerIds.map(id=>{const p=t.players.get(id),s=g.players.get(id);return{id,nickname:p?.nickname,x:s?.x,y:s?.y,hp:s?.hp,maxHp:s?.maxHp,correct:s?.correct};}),enemies:g.enemies.map(e=>({x:e.x,y:e.y}))}));
  if (targetSocket) targetSocket.emit('spectator:snapshots',payload); else if(t.hostSocket)io.to(t.hostSocket).emit('spectator:snapshots',payload);
}
function bracketView(t) {
  return { status:t.status,round:t.round,paused:t.paused,champion:t.status==='complete' ? t.bracket?.flatMap(r=>r.winnerId?[r.winnerId]:[]).at(-1) : null,
    players:[...t.players.values()].map(p=>({id:p.id,nickname:p.nickname,connected:p.connected,correct:p.correct})),
    rounds:(t.bracket||[]).reduce((a,r)=>{(a[r.round] ||= []).push({id:r.id,round:r.round,players:r.players.map(id=>({id,nickname:t.players.get(id)?.nickname})),winner:r.winnerId?{id:r.winnerId,nickname:t.players.get(r.winnerId)?.nickname}:null,status:r.status});return a;},[]) };
}

setInterval(() => {
  for (const t of tournaments.values()) {
    for (const [hash, id] of t.tokens) if (!t.players.has(id)) { t.tokens.delete(hash); playerTokenIndex.delete(hash); }
    if (t.status !== 'active' || t.paused) continue;
    for (const game of t.matchById.values()) if (game.status === 'active') tickGame(t, game, 0.05);
  }
}, 50).unref();
setInterval(()=>{
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
  const expired=[];
  for(const [publicId,t] of tournaments){
    const age=now()-t.createdAt;
    if((t.status==='lobby'&&age>24*60*60*1000)||(['complete','closed'].includes(t.status)&&age>7*24*60*60*1000))expired.push([publicId,t]);
  }
  for(const [publicId,t] of expired){for(const p of t.players.values())if(p.reconnectTimer)clearTimeout(p.reconnectTimer);for(const hash of t.tokens.keys())playerTokenIndex.delete(hash);tournaments.delete(publicId);}
},60*60*1000).unref();

const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('*', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(dist, 'index.html')));
} else {
  app.get('/', (_req,res)=>res.status(503).send('QBA frontend is not built. Run npm run build first.'));
  app.get('/join/:publicId', (_req,res)=>res.status(503).send('QBA frontend is not built. Run npm run build first.'));
}
app.use((err, req, res, _next) => {
  const errorId = randomUUID();
  console.error(`[${errorId}] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: 'Something went wrong. Please try again.', errorId });
});

server.listen(PORT, HOST, () => console.log(`QBA listening on http://${HOST}:${PORT}`));
function shutdown() {
  for (const t of tournaments.values()) if (t.timer) clearInterval(t.timer);
  io.close(() => { if(db.open)db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
