const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDirectory = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDirectory, 'app.json');
const publicDirectory = path.join(__dirname, '..', 'public');
const streams = new Set();
const sockets = new Set();
const rateLimits = new Map();
const startedAt = Date.now();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {
    return { users: [], comments: [] };
  }
}

const data = loadData();
data.users ||= [];
data.comments ||= [];
data.sessions ||= [];
data.chaos ||= 0;
data.clicks ||= 0;
data.upgrades ||= { double: 0, auto: 0, boost: 0, rebirths: 0 };
data.boss ||= { activeMilestone: 0, clearedThrough: 0, hp: 0, maxHp: 0 };
data.boss.activeMilestone ||= 0;
data.boss.clearedThrough ||= 0;
data.boss.hp ||= 0;
data.boss.maxHp ||= 0;

function saveData() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, dataFile);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function rateLimit(request, response) {
  const key = request.headers['cf-connecting-ip'] || String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  if (current.count <= RATE_LIMIT_MAX) return true;
  const retryAfter = Math.ceil((current.resetAt - now) / 1000);
  response.setHeader('retry-after', retryAfter);
  sendJson(response, 429, { error: `Too many requests. Try again in ${retryAfter} seconds.`, retryAfter });
  return false;
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function publicComment(comment) {
  return {
    id: comment.id,
    parentId: comment.parentId,
    text: comment.text,
    createdAt: comment.createdAt,
    author: { id: comment.authorId, username: comment.username },
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function passwordsMatch(password, user) {
  const candidate = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.passwordHash || user.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function tokenFor(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  data.sessions = data.sessions.filter((session) => session.expiresAt > Date.now());
  data.sessions.push({ tokenHash: hashToken(token), userId: user.id, expiresAt });
  saveData();
  return token;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function authenticatedUser(request) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const tokenHash = hashToken(token);
  const session = data.sessions.find((candidate) => candidate.tokenHash === tokenHash);
  if (!session || session.expiresAt < Date.now()) return null;
  const user = data.users.find((candidate) => candidate.id === session.userId);
  return user ? { user, token, tokenHash } : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1_000_000) {
        reject(new Error('リクエスト本文が大きすぎます。'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('JSONが正しくありません。')); }
    });
    request.on('error', reject);
  });
}

function broadcast(comment) {
  const message = `event: comment\ndata: ${JSON.stringify(publicComment(comment))}\n\n`;
  for (const response of streams) response.write(message);
}

function broadcastChaos(storm) {
  const message = `event: chaos\ndata: ${JSON.stringify({ chaos: data.chaos, storm })}\n\n`;
  for (const response of streams) response.write(message);
}

function clickerState() {
  return { clicks: data.clicks, upgrades: data.upgrades, boss: data.boss };
}

function startNextBoss() {
  const eligibleMilestone = Math.floor(data.clicks / 1_000);
  if (data.boss.activeMilestone || eligibleMilestone <= data.boss.clearedThrough) return false;
  data.boss.activeMilestone = data.boss.clearedThrough + 1;
  data.boss.maxHp = 8 + data.boss.activeMilestone * 2;
  data.boss.hp = data.boss.maxHp;
  return true;
}

function webSocketFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  return Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]), payload]);
}

function broadcastClicks() {
  const message = `event: clicks\ndata: ${JSON.stringify({ clicks: data.clicks })}\n\n`;
  for (const response of streams) response.write(message);
  const frame = webSocketFrame({ type: 'clicks', ...clickerState() });
  for (const socket of sockets) socket.write(frame);
}

function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url;
  const filename = path.normalize(path.join(publicDirectory, requested));
  if (!filename.startsWith(publicDirectory)) return sendJson(response, 403, { error: 'アクセスは禁止されています。' });
  fs.readFile(filename, (error, content) => {
    if (error) return sendJson(response, 404, { error: '見つかりません。' });
    const contentType = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'image/jpeg' : 'text/plain; charset=utf-8';
    response.writeHead(200, { 'content-type': contentType });
    response.end(content);
  });
}

function createApp() {
  const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (!rateLimit(request, response)) return;
      if (url.pathname === '/healthz' && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok', uptime: process.uptime() });
      }

      if (url.pathname === '/api/signup' && request.method === 'POST') {
        const body = await readBody(request);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username) || password.length < 8) {
          return sendJson(response, 400, { error: 'ユーザー名は3〜24文字、パスワードは8文字以上にしてください。' });
        }
        if (data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
          return sendJson(response, 409, { error: 'そのユーザー名はすでに使われています。' });
        }
        const user = { id: crypto.randomUUID(), username, ...hashPassword(password) };
        data.users.push(user);
        saveData();
        return sendJson(response, 201, { user: publicUser(user), token: tokenFor(user) });
      }

      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await readBody(request);
        const user = data.users.find((candidate) => candidate.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
        if (!user || !passwordsMatch(String(body.password || ''), user)) return sendJson(response, 401, { error: 'ユーザー名またはパスワードが正しくありません。' });
        return sendJson(response, 200, { user: publicUser(user), token: tokenFor(user) });
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const session = authenticatedUser(request);
        return session ? sendJson(response, 200, { user: publicUser(session.user) }) : sendJson(response, 401, { error: 'ログインしていません。' });
      }

      if (url.pathname === '/api/logout' && request.method === 'POST') {
        const session = authenticatedUser(request);
        if (session) {
          data.sessions = data.sessions.filter((candidate) => candidate.tokenHash !== session.tokenHash);
          saveData();
        }
        return sendJson(response, 200, { ok: true });
      }

      if (url.pathname === '/api/comments/stream' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(': connected\n\n');
        streams.add(response);
        request.on('close', () => streams.delete(response));
        return;
      }

      if (url.pathname === '/api/comments' && request.method === 'GET') {
        const comments = [...data.comments].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        return sendJson(response, 200, { comments: comments.map(publicComment) });
      }

      if (url.pathname === '/api/chaos' && request.method === 'GET') {
        return sendJson(response, 200, { chaos: data.chaos });
      }

      if (url.pathname === '/api/chaos' && request.method === 'POST') {
        if (!authenticatedUser(request)) return sendJson(response, 401, { error: '混沌を増やすにはログインしてください。' });
        data.chaos += 1;
        saveData();
        const storm = ['🌀', '⚡', '🌈', '🧨', '👁'][Math.floor(Math.random() * 5)];
        broadcastChaos(storm);
        return sendJson(response, 200, { chaos: data.chaos, storm });
      }

      if (url.pathname === '/api/clicker' && request.method === 'GET') {
        if (startNextBoss()) saveData();
        return sendJson(response, 200, clickerState());
      }

      if (url.pathname === '/api/clicker' && request.method === 'POST') {
        data.clicks += 1 + data.upgrades.boost + data.upgrades.double;
        startNextBoss();
        saveData();
        broadcastClicks();
        return sendJson(response, 200, clickerState());
      }

      if (url.pathname === '/api/clicker/upgrade' && request.method === 'POST') {
        const { type } = await readBody(request); const base = { double: 15, auto: 50, boost: 600 }[type];
        if (!base) return sendJson(response, 400, { error: 'Invalid upgrade.' });
        const cost = Math.ceil(base * 1.5 ** data.upgrades[type]);
        if (data.clicks < cost) return sendJson(response, 400, { error: 'Not enough clicks.' });
        data.clicks -= cost; data.upgrades[type] += 1; saveData(); broadcastClicks(); return sendJson(response, 200, clickerState());
      }

      if (url.pathname === '/api/clicker/boss' && request.method === 'POST') {
        if (!data.boss.activeMilestone) return sendJson(response, 409, { error: 'Birdvirus is not attacking right now.' });
        data.boss.hp -= 1;
        if (data.boss.hp <= 0) {
          data.boss.clearedThrough = data.boss.activeMilestone;
          data.boss.activeMilestone = 0;
          data.boss.hp = 0;
          data.boss.maxHp = 0;
          startNextBoss();
        }
        saveData();
        broadcastClicks();
        return sendJson(response, 200, clickerState());
      }

      if (url.pathname === '/api/comments' && request.method === 'POST') {
        const session = authenticatedUser(request);
        if (!session) return sendJson(response, 401, { error: 'コメントするにはログインしてください。' });
        const body = await readBody(request);
        const text = String(body.text || '').trim();
        const parentId = body.parentId ? String(body.parentId) : null;
        if (!text || text.length > 500) return sendJson(response, 400, { error: 'コメントは1〜500文字にしてください。' });
        const normalizedText = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (normalizedText === 'imfuckingracist') return sendJson(response, 400, { error: 'コメントはモデレーションによりブロックされました。' });
        const now = Date.now();
        const recentComments = data.comments.filter((comment) => comment.authorId === session.user.id && now - Date.parse(comment.createdAt) < 60_000);
        if (recentComments.length >= 5) {
          response.setHeader('retry-after', '60');
          return sendJson(response, 429, { error: 'コメントの投稿上限に達しました。しばらくしてから再試行してください。' });
        }
        if (recentComments.some((comment) => comment.text === text && now - Date.parse(comment.createdAt) < 600_000)) {
          return sendJson(response, 409, { error: '重複したコメントはブロックされました。' });
        }
        if (parentId && !data.comments.some((comment) => comment.id === parentId)) return sendJson(response, 400, { error: '返信先のコメントが見つかりません。' });
        const comment = { id: crypto.randomUUID(), parentId, text, authorId: session.user.id, username: session.user.username, createdAt: new Date().toISOString() };
        data.comments.push(comment);
        saveData();
        broadcast(comment);
        return sendJson(response, 201, { comment: publicComment(comment) });
      }

      if (request.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(request, response);
      return sendJson(response, 404, { error: '見つかりません。' });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'リクエストに失敗しました。' });
    }
  });
  const autoClickTimer = setInterval(() => {
    if (!data.upgrades.auto) return;
    data.clicks += data.upgrades.auto;
    startNextBoss();
    saveData();
    broadcastClicks();
  }, 1_000);
  autoClickTimer.unref();
  server.once('close', () => clearInterval(autoClickTimer));
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/ws') return socket.destroy();
    const key = request.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  return { server, startedAt };
}

module.exports = { createApp };
