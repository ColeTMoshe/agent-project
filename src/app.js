const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataDirectory = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDirectory, 'app.json');
const publicDirectory = path.join(__dirname, '..', 'public');
const sessions = new Map();
const streams = new Set();
const startedAt = Date.now();

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
  const expected = Buffer.from(user.passwordHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function tokenFor(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return token;
}

function authenticatedUser(request) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  const user = data.users.find((candidate) => candidate.id === session.userId);
  return user ? { user, token } : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1_000_000) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    request.on('error', reject);
  });
}

function broadcast(comment) {
  const message = `event: comment\ndata: ${JSON.stringify(publicComment(comment))}\n\n`;
  for (const response of streams) response.write(message);
}

function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url;
  const filename = path.normalize(path.join(publicDirectory, requested));
  if (!filename.startsWith(publicDirectory)) return sendJson(response, 403, { error: 'Forbidden' });
  fs.readFile(filename, (error, content) => {
    if (error) return sendJson(response, 404, { error: 'Not found' });
    const contentType = filename.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    response.writeHead(200, { 'content-type': contentType });
    response.end(content);
  });
}

function createApp() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok', uptime: process.uptime() });
      }

      if (url.pathname === '/api/signup' && request.method === 'POST') {
        const body = await readBody(request);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!/^[a-zA-Z0-9_]{3,24}$/.test(username) || password.length < 8) {
          return sendJson(response, 400, { error: 'Username must be 3-24 characters and password must be at least 8 characters.' });
        }
        if (data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
          return sendJson(response, 409, { error: 'Username is already taken.' });
        }
        const user = { id: crypto.randomUUID(), username, ...hashPassword(password) };
        data.users.push(user);
        saveData();
        return sendJson(response, 201, { user: publicUser(user), token: tokenFor(user) });
      }

      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await readBody(request);
        const user = data.users.find((candidate) => candidate.username.toLowerCase() === String(body.username || '').trim().toLowerCase());
        if (!user || !passwordsMatch(String(body.password || ''), user)) return sendJson(response, 401, { error: 'Invalid username or password.' });
        return sendJson(response, 200, { user: publicUser(user), token: tokenFor(user) });
      }

      if (url.pathname === '/api/comments/stream' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(': connected\n\n');
        streams.add(response);
        request.on('close', () => streams.delete(response));
        return;
      }

      if (url.pathname === '/api/comments' && request.method === 'GET') {
        return sendJson(response, 200, { comments: data.comments.map(publicComment) });
      }

      if (url.pathname === '/api/comments' && request.method === 'POST') {
        const session = authenticatedUser(request);
        if (!session) return sendJson(response, 401, { error: 'Log in to comment.' });
        const body = await readBody(request);
        const text = String(body.text || '').trim();
        const parentId = body.parentId ? String(body.parentId) : null;
        if (!text || text.length > 500) return sendJson(response, 400, { error: 'Comment must be 1-500 characters.' });
        if (parentId && !data.comments.some((comment) => comment.id === parentId)) return sendJson(response, 400, { error: 'Parent comment was not found.' });
        const comment = { id: crypto.randomUUID(), parentId, text, authorId: session.user.id, username: session.user.username, createdAt: new Date().toISOString() };
        data.comments.push(comment);
        saveData();
        broadcast(comment);
        return sendJson(response, 201, { comment: publicComment(comment) });
      }

      if (url.pathname === '/' || url.pathname.startsWith('/public/')) return serveStatic(request, response);
      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'Request failed.' });
    }
  });
  return { server, startedAt };
}

module.exports = { createApp };
