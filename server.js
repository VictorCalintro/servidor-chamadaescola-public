'use strict';

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'infancia-feliz.sqlite');
const HTML_FILE = path.join(__dirname, 'infancia-feliz-v27.html');
const NODE_ENV = process.env.NODE_ENV || 'production';
const APP_NAME = 'Infancia Feliz';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const COLLAB_USER = process.env.COLLAB_USER || 'colaborador';
const COLLAB_PASSWORD = process.env.COLLAB_PASSWORD || '';
const TABLET_USER = process.env.TABLET_USER || 'tablet';
const TABLET_PASSWORD = process.env.TABLET_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000);
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 500_000);
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES || 64_000);
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const API_LIMIT = Number(process.env.API_RATE_LIMIT || 100);
const API_WINDOW_MS = Number(process.env.API_RATE_WINDOW_MS || 60_000);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA busy_timeout = 5000');
});

function requireSecurityConfig() {
  const missing = [];
  if (!ADMIN_USER) missing.push('ADMIN_USER');
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) missing.push('ADMIN_PASSWORD com 12+ caracteres');
  if (!TABLET_PASSWORD || TABLET_PASSWORD.length < 12) missing.push('TABLET_PASSWORD com 12+ caracteres');
  if (!COLLAB_PASSWORD || COLLAB_PASSWORD.length < 12) missing.push('COLLAB_PASSWORD com 12+ caracteres');
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) missing.push('SESSION_SECRET com 32+ caracteres');
  if (!CORS_ORIGINS.length) missing.push('CORS_ORIGINS');
  if (CORS_ORIGINS.includes('*')) missing.push('CORS_ORIGINS sem *');
  if (missing.length) {
    throw new Error(`Configuracao de seguranca ausente: ${missing.join(', ')}`);
  }
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function tipoToPeriodo(tipo) {
  if (tipo === 'M') return 'Meio Período';
  if (tipo === 'In') return 'Intermediário';
  return 'Integral';
}

function periodoToTipo(periodo) {
  const raw = String(periodo || '').trim().toLowerCase();
  if (raw.includes('inter')) return 'In';
  if (raw.includes('meio')) return 'M';
  return normalizeTipo(periodo);
}

function salaId(nome) {
  const slug = String(nome || 'sala')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 28);
  return slug || `sala${Date.now()}`;
}

function emojiForName(nome) {
  const sum = [...String(nome || '')].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return sum % 2 ? '👧' : '👦';
}

function normalizeTipo(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (raw === 'In' || lower.includes('inter')) return 'In';
  if (raw === 'I' || lower.includes('integral')) return 'I';
  if (raw === 'M' || lower.includes('meio')) return 'M';
  return 'I';
}

function cleanText(value, max = 120) {
  return String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const TURMA_ORDER = [
  'Berçário',
  'Infantil 1A', 'Infantil 1B', 'Infantil 1C',
  'Infantil 2A', 'Infantil 2B', 'Infantil 2C', 'Infantil 2D',
  'Infantil 3A', 'Infantil 3B', 'Infantil 3C',
  'Infantil 4A', 'Infantil 4B', 'Infantil 4C',
  'Infantil 5A', 'Infantil 5B',
  '1º Ano A', '1º Ano B', '1º Ano C',
  '2º Ano A', '2º Ano B',
  '3º Ano A', '3º Ano B',
  '4º Ano',
  '5º Ano',
];

function normalizeTurmaOrderName(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/º/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TURMA_ORDER_INDEX = new Map(TURMA_ORDER.map((nome, index) => [normalizeTurmaOrderName(nome), index]));

function turmaOrderIndex(nome) {
  const normalized = normalizeTurmaOrderName(nome);
  if (TURMA_ORDER_INDEX.has(normalized)) return TURMA_ORDER_INDEX.get(normalized);
  if (normalized === 'bercario') return 0;
  const infantil = normalized.match(/^infantil\s+(\d+)\s*([a-z])?$/);
  if (infantil) return 1 + (Number(infantil[1]) - 1) * 4 + (infantil[2] ? infantil[2].charCodeAt(0) - 97 : 0);
  const ano = normalized.match(/^(\d+)\s*ano\s*([a-z])?$/);
  if (ano) return 100 + (Number(ano[1]) - 1) * 4 + (ano[2] ? ano[2].charCodeAt(0) - 97 : 0);
  return 1000;
}

function compareTurmaNames(a, b) {
  const orderDiff = turmaOrderIndex(a) - turmaOrderIndex(b);
  return orderDiff || String(a || '').localeCompare(String(b || ''), 'pt-BR', { numeric: true, sensitivity: 'base' });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        if (idx === -1) return [part, ''];
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      }),
  );
}

function signSession(role, expires) {
  const data = `${role}.${expires}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function sessionRole(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [subject, expiresRaw, sig] = parts;
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  let role = ['admin', 'colaborador', 'tablet'].includes(subject) ? subject : null;
  if (!role && ADMIN_USER && safeEqual(subject, ADMIN_USER)) role = 'admin';
  if (!role) return null;
  const expected = signSession(subject, expires).split('.').at(-1);
  return safeEqual(sig, expected) ? role : null;
}

function validSession(token) {
  return Boolean(sessionRole(token));
}

function basicCredentials(header = '') {
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function roleForCredentials(credentials) {
  if (!credentials) return false;
  const adminOk = ADMIN_USER && ADMIN_PASSWORD
    && safeEqual(credentials.user, ADMIN_USER)
    && safeEqual(credentials.password, ADMIN_PASSWORD);
  if (adminOk) return 'admin';
  const collabOk = COLLAB_USER && COLLAB_PASSWORD
    && safeEqual(credentials.user, COLLAB_USER)
    && safeEqual(credentials.password, COLLAB_PASSWORD);
  if (collabOk) return 'colaborador';
  const tabletOk = TABLET_USER && TABLET_PASSWORD
    && safeEqual(credentials.user, TABLET_USER)
    && safeEqual(credentials.password, TABLET_PASSWORD);
  if (tabletOk) return 'tablet';
  return null;
}

function validBasicCredentials(credentials) {
  return Boolean(roleForCredentials(credentials));
}

function isLoopback(address = '') {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return Boolean(req.socket.encrypted) || (isLoopback(req.socket.remoteAddress) && forwardedProto === 'https');
}

function cookieOptions(req, role = 'admin') {
  return `if_session=${signSession(role, Date.now() + SESSION_TTL_MS)}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function requestAuthRole(req) {
  const credentials = basicCredentials(req.headers.authorization || '');
  const basicRole = roleForCredentials(credentials);
  if (basicRole) return basicRole;
  const cookies = parseCookies(req.headers.cookie);
  return sessionRole(cookies.if_session);
}

function isAuthenticated(req, res) {
  const credentials = basicCredentials(req.headers.authorization || '');
  const role = roleForCredentials(credentials);
  if (role) {
    res.setHeader('Set-Cookie', cookieOptions(req, role));
    return true;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (sessionRole(cookies.if_session)) return true;

  return false;
}

function hasValidAuth(req) {
  return Boolean(requestAuthRole(req));
}

function requireAuth(req, res, challenge = true) {
  if (isAuthenticated(req, res)) return true;
  if (challenge) res.setHeader('WWW-Authenticate', `Basic realm="${APP_NAME}", charset="UTF-8"`);
  sendJson(res, 401, { ok: false, erro: 'Autenticacao obrigatoria' });
  return false;
}

function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return origin;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : '';
}

function authPublicInfo(role) {
  return {
    ok: Boolean(role),
    role: role || null,
    canAdmin: role === 'admin',
    canTablet: role === 'admin' || role === 'tablet',
    canColaborador: role === 'admin' || role === 'colaborador',
  };
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || CORS_ORIGINS.includes(origin);
}

async function migrate() {
  await run(`CREATE TABLE IF NOT EXISTS turmas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    professora TEXT NOT NULL DEFAULT '',
    auxiliar TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS alunos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    turma_id INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('M','I','In')),
    nascimento TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (turma_id) REFERENCES turmas(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS chamados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pessoa TEXT NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('aluno','professora','auxiliar')),
    turma_id INTEGER NOT NULL,
    motivo TEXT,
    status TEXT NOT NULL DEFAULT 'aberto',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (turma_id) REFERENCES turmas(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS app_state (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  )`);
}

async function listTurmas() {
  const turmas = await all(`SELECT t.*,
      COUNT(a.id) AS total,
      SUM(CASE WHEN a.tipo = 'M' THEN 1 ELSE 0 END) AS total_m,
      SUM(CASE WHEN a.tipo = 'I' THEN 1 ELSE 0 END) AS total_i,
      SUM(CASE WHEN a.tipo = 'In' THEN 1 ELSE 0 END) AS total_in
    FROM turmas t
    LEFT JOIN alunos a ON a.turma_id = t.id
    GROUP BY t.id`);
  return turmas.sort((a, b) => compareTurmaNames(a.nome, b.nome));
}

async function listAlunos(query = {}) {
  const where = [];
  const params = [];
  if (query.turma_id) {
    where.push('a.turma_id = ?');
    params.push(Number(query.turma_id));
  }
  if (query.tipo) {
    where.push('a.tipo = ?');
    params.push(normalizeTipo(query.tipo));
  }
  if (query.q) {
    where.push('a.nome LIKE ?');
    params.push(`%${cleanText(query.q, 80)}%`);
  }
  const alunos = await all(`SELECT a.*, t.nome AS turma_nome, t.professora, t.auxiliar
    FROM alunos a
    JOIN turmas t ON t.id = a.turma_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  return alunos.sort((a, b) => compareTurmaNames(a.turma_nome, b.turma_nome) || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' }));
}

async function getState() {
  const rows = await all('SELECT chave, valor FROM app_state');
  const state = {};
  for (const row of rows) {
    try {
      state[row.chave] = JSON.parse(row.valor);
    } catch {
      state[row.chave] = row.valor;
    }
  }
  return state;
}

async function setState(chave, valor) {
  await run(
    `INSERT INTO app_state (chave, valor)
     VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`,
    [chave, JSON.stringify(valor ?? null)],
  );
}

async function getOrCreateTurma(nome, professora = '', auxiliar = '') {
  const turmaNome = cleanText(nome || 'Sem turma');
  let turma = await get('SELECT * FROM turmas WHERE nome = ?', [turmaNome]);
  if (!turma) {
    const result = await run(
      'INSERT INTO turmas (nome, professora, auxiliar) VALUES (?, ?, ?)',
      [turmaNome, cleanText(professora), cleanText(auxiliar)],
    );
    turma = await get('SELECT * FROM turmas WHERE id = ?', [result.lastID]);
  } else {
    await run(
      `UPDATE turmas
       SET professora = COALESCE(NULLIF(?, ''), professora),
           auxiliar = COALESCE(NULLIF(?, ''), auxiliar),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cleanText(professora), cleanText(auxiliar), turma.id],
    );
    turma = await get('SELECT * FROM turmas WHERE id = ?', [turma.id]);
  }
  return turma;
}

async function syncPayloadToSqlite(payload) {
  if (Array.isArray(payload.salas)) {
    for (const sala of payload.salas) {
      await getOrCreateTurma(sala.nome, sala.prof, sala.auxiliar || sala.aux || '');
    }
  }

  if (Array.isArray(payload.alunos)) {
    for (const aluno of payload.alunos) {
      const nome = cleanText(aluno.nome);
      if (!nome) continue;
      const salaInfo = Array.isArray(payload.salas)
        ? payload.salas.find((s) => s.nome === aluno.turma || s.nome === aluno.sala)
        : null;
      const turma = await getOrCreateTurma(
        aluno.turma || aluno.sala || 'Sem turma',
        salaInfo?.prof || '',
        salaInfo?.auxiliar || salaInfo?.aux || '',
      );
      const tipo = aluno.tipo ? normalizeTipo(aluno.tipo) : periodoToTipo(aluno.periodo);
      const existente = await get('SELECT id FROM alunos WHERE nome = ? AND turma_id = ?', [nome, turma.id]);
      if (existente) {
        await run(
          'UPDATE alunos SET tipo = ?, nascimento = COALESCE(NULLIF(?, \'\'), nascimento), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [tipo, cleanText(aluno.nascimento, 20), existente.id],
        );
      } else {
        await run(
          'INSERT INTO alunos (nome, turma_id, tipo, nascimento) VALUES (?, ?, ?, ?)',
          [nome, turma.id, tipo, cleanText(aluno.nascimento, 20)],
        );
      }
    }
  }
}

async function buildDadosPayload() {
  const state = await getState();
  const turmas = await listTurmas();
  const alunos = await listAlunos();
  const storedSalas = new Map((state.salas || []).map((s) => [s.nome, s]));
  const storedAlunos = new Map((state.alunos || []).map((a) => [`${a.nome}|${a.turma}`, a]));

  const salas = turmas.map((turma, index) => {
    const stored = storedSalas.get(turma.nome) || {};
    return {
      id: stored.id || salaId(turma.nome),
      nome: turma.nome,
      cor: stored.cor || `sala-cor-${(index % 10) + 1}`,
      prof: turma.professora || stored.prof || '',
      auxiliar: turma.auxiliar || stored.auxiliar || '',
    };
  });

  const alunosCompat = alunos.map((aluno) => {
    const stored = storedAlunos.get(`${aluno.nome}|${aluno.turma_nome}`) || {};
    return {
      ...stored,
      id: aluno.id,
      nome: aluno.nome,
      emoji: stored.emoji || emojiForName(aluno.nome),
      turma: aluno.turma_nome,
      sala: stored.sala || aluno.turma_nome,
      periodo: tipoToPeriodo(aluno.tipo),
      tipo: aluno.tipo,
      nascimento: aluno.nascimento || stored.nascimento || '',
    };
  });

  return {
    chamados: state.chamados || [],
    horarios: state.horarios || {},
    historico: state.historico || [],
    statusAlunos: state.statusAlunos || {},
    alunos: alunosCompat,
    salas,
    diario: state.diario || {},
    salasFechadas: state.salasFechadas || {},
  };
}

function colaboradorDadosPayload() {
  return {
    chamados: [],
    horarios: {},
    historico: [],
    statusAlunos: {},
    alunos: [],
    salas: [],
    diario: {},
    salasFechadas: {},
  };
}

function securityHeaders(req, res) {
  const origin = req.headers.origin;
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
  if (NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  if (!origin || CORS_ORIGINS.includes(origin)) {
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  return headers;
}

const buckets = new Map();
function rateLimit(req, res, pathname) {
  if (!pathname.startsWith('/api/') && pathname !== '/login') return false;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'local';
  const now = Date.now();
  const bucket = buckets.get(ip) || { start: now, count: 0 };
  if (now - bucket.start > API_WINDOW_MS) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  buckets.set(ip, bucket);
  if (bucket.count > API_LIMIT) {
    sendJson(res, 429, { ok: false, erro: 'Limite de requisicoes excedido' });
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_LIMIT_BYTES) {
        req.destroy();
        reject(new Error('Payload muito grande'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON invalido'));
      }
    });
  });
}

function staticFile(pathname) {
  const map = {
    '/': HTML_FILE,
    '/index.html': HTML_FILE,
    '/app.js': path.join(__dirname, 'app.js'),
    '/sw.js': path.join(__dirname, 'sw.js'),
    '/manifest.json': path.join(__dirname, 'manifest.json'),
    '/icon-192.png': path.join(__dirname, 'icon-192.png'),
    '/icon-512.png': path.join(__dirname, 'icon-512.png'),
  };
  return map[pathname];
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

async function handleApi(req, res, pathname, searchParams, authRole = 'admin') {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/ping') {
    sendJson(res, 200, { status: 'ok', uptime: Math.round(process.uptime()) });
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    try {
      await get('SELECT 1 AS ok');
      sendJson(res, 200, { status: 'ok', sqlite: true });
    } catch (err) {
      sendJson(res, 503, { status: 'erro', sqlite: false, erro: err.message });
    }
    return;
  }

  if (rateLimit(req, res, pathname)) return;

  if (pathname === '/api/session') {
    sendJson(res, 200, authPublicInfo(authRole));
    return;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const credentials = basicCredentials(req.headers.authorization || '');
    const role = roleForCredentials(credentials);
    if (!role) {
      sendJson(res, 401, { ok: false, erro: 'Usuario ou senha invalidos' });
      return;
    }
    res.setHeader('Set-Cookie', cookieOptions(req, role));
    sendJson(res, 200, authPublicInfo(role));
    return;
  }

  if (authRole !== 'admin' && pathname.startsWith('/api/')) {
    if (authRole === 'colaborador' && req.method === 'GET' && pathname === '/api/dados') {
      sendJson(res, 200, colaboradorDadosPayload());
      return;
    }
    if (authRole === 'tablet' && ['GET', 'POST'].includes(req.method) && pathname === '/api/dados') {
      if (req.method === 'GET') {
        sendJson(res, 200, await buildDadosPayload());
        return;
      }
      const body = await readBody(req);
      await syncPayloadToSqlite(body);
      await setState('chamados', Array.isArray(body.chamados) ? body.chamados : []);
      await setState('horarios', body.horarios || {});
      await setState('historico', Array.isArray(body.historico) ? body.historico : []);
      await setState('statusAlunos', body.statusAlunos || {});
      await setState('alunos', Array.isArray(body.alunos) ? body.alunos : []);
      await setState('salas', Array.isArray(body.salas) ? body.salas : []);
      await setState('diario', body.diario || {});
      await setState('salasFechadas', body.salasFechadas || {});
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 403, { ok: false, erro: 'Acesso exclusivo do admin' });
    return;
  }

  if (pathname === '/api/dados') {
    if (req.method === 'GET') {
      sendJson(res, 200, await buildDadosPayload());
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      await syncPayloadToSqlite(body);
      await setState('chamados', Array.isArray(body.chamados) ? body.chamados : []);
      await setState('horarios', body.horarios || {});
      await setState('historico', Array.isArray(body.historico) ? body.historico : []);
      await setState('statusAlunos', body.statusAlunos || {});
      await setState('alunos', Array.isArray(body.alunos) ? body.alunos : []);
      await setState('salas', Array.isArray(body.salas) ? body.salas : []);
      await setState('diario', body.diario || {});
      await setState('salasFechadas', body.salasFechadas || {});
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/api/backup') {
    const payload = await buildDadosPayload();
    const filename = `infancia-feliz-backup-${new Date().toISOString().slice(0, 10)}.json`;
    sendJson(res, 200, payload, {
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/limpar-historico') {
    await setState('historico', []);
    broadcastTodos({ tipo: 'reload' });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/turmas') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listTurmas());
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const nome = cleanText(body.nome);
      if (!nome) return sendJson(res, 400, { ok: false, erro: 'Nome da turma e obrigatorio' });
      const result = await run(
        'INSERT INTO turmas (nome, professora, auxiliar) VALUES (?, ?, ?)',
        [nome, cleanText(body.professora), cleanText(body.auxiliar)],
      );
      sendJson(res, 201, await get('SELECT * FROM turmas WHERE id = ?', [result.lastID]));
      broadcastTodos({ tipo: 'sync' });
      return;
    }
  }

  const turmaMatch = pathname.match(/^\/api\/turmas\/(\d+)$/);
  if (turmaMatch) {
    const id = Number(turmaMatch[1]);
    if (req.method === 'GET') return sendJson(res, 200, await get('SELECT * FROM turmas WHERE id = ?', [id]));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      await run(
        'UPDATE turmas SET nome = ?, professora = ?, auxiliar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [cleanText(body.nome), cleanText(body.professora), cleanText(body.auxiliar), id],
      );
      broadcastTodos({ tipo: 'sync' });
      return sendJson(res, 200, await get('SELECT * FROM turmas WHERE id = ?', [id]));
    }
    if (req.method === 'DELETE') {
      await run('DELETE FROM turmas WHERE id = ?', [id]);
      broadcastTodos({ tipo: 'sync' });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/alunos') {
    if (req.method === 'GET') {
      sendJson(res, 200, await listAlunos({
        turma_id: searchParams.get('turma_id'),
        tipo: searchParams.get('tipo'),
        q: searchParams.get('q'),
      }));
      return;
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const nome = cleanText(body.nome);
      const turmaId = Number(body.turma_id);
      if (!nome || !turmaId) return sendJson(res, 400, { ok: false, erro: 'Nome e turma sao obrigatorios' });
      const result = await run(
        'INSERT INTO alunos (nome, turma_id, tipo, nascimento) VALUES (?, ?, ?, ?)',
        [nome, turmaId, normalizeTipo(body.tipo), cleanText(body.nascimento, 20)],
      );
      broadcastTodos({ tipo: 'sync' });
      return sendJson(res, 201, await get('SELECT * FROM alunos WHERE id = ?', [result.lastID]));
    }
  }

  const alunoMatch = pathname.match(/^\/api\/alunos\/(\d+)$/);
  if (alunoMatch) {
    const id = Number(alunoMatch[1]);
    if (req.method === 'GET') return sendJson(res, 200, await get('SELECT * FROM alunos WHERE id = ?', [id]));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      await run(
        'UPDATE alunos SET nome = ?, turma_id = ?, tipo = ?, nascimento = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [cleanText(body.nome), Number(body.turma_id), normalizeTipo(body.tipo), cleanText(body.nascimento, 20), id],
      );
      broadcastTodos({ tipo: 'sync' });
      return sendJson(res, 200, await get('SELECT * FROM alunos WHERE id = ?', [id]));
    }
    if (req.method === 'DELETE') {
      await run('DELETE FROM alunos WHERE id = ?', [id]);
      broadcastTodos({ tipo: 'sync' });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname === '/api/chamados' && req.method === 'POST') {
    const body = await readBody(req);
    const turmaId = Number(body.turma_id);
    const pessoa = cleanText(body.pessoa);
    const papel = ['aluno', 'professora', 'auxiliar'].includes(body.papel) ? body.papel : 'aluno';
    if (!turmaId || !pessoa) return sendJson(res, 400, { ok: false, erro: 'Pessoa e turma sao obrigatorias' });
    const result = await run(
      'INSERT INTO chamados (pessoa, papel, turma_id, motivo) VALUES (?, ?, ?, ?)',
      [pessoa, papel, turmaId, cleanText(body.motivo, 240)],
    );
    const chamado = await get(`SELECT c.*, t.nome AS turma_nome FROM chamados c JOIN turmas t ON t.id = c.turma_id WHERE c.id = ?`, [result.lastID]);
    broadcastTodos({ tipo: 'chamado', chamado });
    return sendJson(res, 201, chamado);
  }

  sendJson(res, 404, { ok: false, erro: 'Rota nao encontrada' });
}

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsed.pathname);

  try {
    if (!isAllowedOrigin(req)) {
      sendJson(res, 403, { ok: false, erro: 'Origem nao permitida' });
      return;
    }

    if (!['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)) {
      sendJson(res, 405, { ok: false, erro: 'Metodo nao permitido' });
      return;
    }

    if (NODE_ENV === 'production' && !['/ping', '/health'].includes(pathname) && !isSecureRequest(req)) {
      sendJson(res, 426, { ok: false, erro: 'HTTPS obrigatorio' });
      return;
    }

    if (pathname === '/api/session' && !hasValidAuth(req)) {
      sendJson(res, 200, authPublicInfo(null));
      return;
    }

    if (pathname.startsWith('/api/') && pathname !== '/api/login' && !requireAuth(req, res, false)) return;
    const authRole = requestAuthRole(req) || 'admin';

    if (pathname === '/ping' || pathname === '/health' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, parsed.searchParams, authRole);
      return;
    }

    if (!requireAuth(req, res)) return;

    const file = staticFile(pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - Nao encontrado');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Arquivo nao encontrado');
        return;
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    sendJson(res, err.message === 'JSON invalido' ? 400 : 500, { ok: false, erro: err.message });
  }
});

const wss = new WebSocket.Server({
  server,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  verifyClient: ({ req }, done) => {
    const authRole = requestAuthRole(req);
    req.authRole = authRole || '';
    done(isAllowedOrigin(req) && Boolean(authRole), 401, 'Unauthorized');
  },
});
const clientes = new Map();

function clientPublicInfo(ws, now = Date.now()) {
  const meta = clientes.get(ws) || {};
  return {
    id: meta.id || '',
    sala: meta.sala || 'nao identificado',
    perfil: meta.perfil || (meta.sala === 'secretaria' ? 'admin' : 'tablet'),
    online: ws.readyState === WebSocket.OPEN,
    conectadoEm: meta.connectedAt || null,
    ultimoPing: meta.lastSeen || null,
    segundosSemPing: meta.lastSeen ? Math.round((now - meta.lastSeen) / 1000) : null,
  };
}

function deviceStatusPayload() {
  const now = Date.now();
  return {
    tipo: 'dispositivos',
    dispositivos: [...clientes.keys()]
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => clientPublicInfo(ws, now))
      .sort((a, b) => compareTurmaNames(a.sala, b.sala)),
  };
}

function broadcastTodos(msg, remetente) {
  const data = JSON.stringify(msg);
  for (const ws of clientes.keys()) {
    if (ws !== remetente && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function enviarParaClientes(predicate, msg, remetente) {
  const data = JSON.stringify(msg);
  let enviados = 0;
  for (const [ws, meta] of clientes.entries()) {
    if (ws !== remetente && ws.readyState === WebSocket.OPEN && predicate(meta, ws)) {
      ws.send(data);
      enviados += 1;
    }
  }
  return enviados;
}

wss.on('connection', (ws, req) => {
  clientes.set(ws, {
    id: crypto.randomUUID(),
    sala: 'nao identificado',
    perfil: 'desconhecido',
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',
    authRole: req.authRole || requestAuthRole(req) || 'desconhecido',
  });

  ws.on('message', async (raw) => {
    try {
      if (String(raw).length > WS_MAX_PAYLOAD_BYTES) {
        ws.close(1009, 'Mensagem muito grande');
        return;
      }
      const msg = JSON.parse(raw);
      const meta = clientes.get(ws) || {};
      meta.lastSeen = Date.now();

      if (msg.tipo === 'registrar') {
        const authRole = meta.authRole || requestAuthRole(req) || 'desconhecido';
        if (authRole === 'colaborador') {
          meta.sala = 'colaborador';
          meta.perfil = 'colaborador';
        } else {
          meta.sala = cleanText(msg.sala || 'nao identificado', 80);
          const perfil = cleanText(msg.perfil || '', 40);
          meta.perfil = ['admin', 'tablet', 'colaborador'].includes(perfil)
            ? perfil
            : (meta.sala === 'secretaria' ? 'admin' : 'tablet');
        }
        meta.authRole = authRole;
        meta.ua = cleanText(req.headers['user-agent'] || '', 180);
        clientes.set(ws, meta);
        ws.send(JSON.stringify({ tipo: 'registrado', sala: meta.sala, id: meta.id, servidorHora: new Date().toISOString() }));
        const snapshot = meta.perfil === 'colaborador' ? colaboradorDadosPayload() : await buildDadosPayload();
        ws.send(JSON.stringify({ tipo: 'snapshot', dados: snapshot, servidorHora: new Date().toISOString() }));
        broadcastTodos(deviceStatusPayload());
        return;
      }

      if (msg.tipo === 'ping_back') {
        ws.send(JSON.stringify({ tipo: 'pong_back', servidorHora: new Date().toISOString() }));
        broadcastTodos(deviceStatusPayload());
        return;
      }

      if (msg.tipo === 'chamar_colaborador') {
        if (meta.authRole !== 'admin' || meta.perfil !== 'admin') {
          ws.send(JSON.stringify({ tipo: 'erro', erro: 'Somente admin pode chamar colaboradores' }));
          return;
        }
        const payload = {
          tipo: 'chamar_colaborador',
          nome: cleanText(msg.nome || 'Colaborador', 100),
          motivo: cleanText(msg.motivo || 'Solicitado pela secretaria', 240),
          hora: cleanText(msg.hora || '', 20),
          data: cleanText(msg.data || '', 20),
          sala: cleanText(msg.sala || meta.sala || 'secretaria', 80),
          _sid: msg._sid,
        };
        const enviados = enviarParaClientes((client) => client.perfil === 'colaborador', payload, ws);
        ws.send(JSON.stringify({ tipo: 'colaborador_chamado_ack', enviados, nome: payload.nome }));
        return;
      }

      broadcastTodos(msg, ws);
    } catch {
      ws.send(JSON.stringify({ tipo: 'erro', erro: 'Mensagem invalida' }));
    }
  });
  ws.on('close', () => {
    clientes.delete(ws);
    broadcastTodos(deviceStatusPayload());
  });
  ws.on('error', () => {
    clientes.delete(ws);
    broadcastTodos(deviceStatusPayload());
  });
});

setInterval(() => {
  broadcastTodos(deviceStatusPayload());
}, 10_000);

requireSecurityConfig();

migrate()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Infancia Feliz rodando em http://localhost:${PORT}`);
      console.log(`SQLite: ${DB_PATH}`);
    });
  })
  .catch((err) => {
    console.error('Falha ao iniciar:', err);
    process.exit(1);
  });

process.on('SIGTERM', () => {
  server.close(() => db.close(() => process.exit(0)));
});

process.on('SIGINT', () => {
  server.close(() => db.close(() => process.exit(0)));
});
