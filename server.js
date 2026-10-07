import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
const dbFile = path.join(dataDir, 'chat.db');
const legacyMessagesFile = path.join(dataDir, 'messages.json');
const maxUploadBytes = 25 * 1024 * 1024;
const maxRequestBytes = maxUploadBytes + 1024 * 1024;
const recentLimit = 200;
const clients = new Set();

fs.mkdirSync(uploadDir, { recursive: true });
const db = new DatabaseSync(dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('text', 'file')),
    name TEXT NOT NULL,
    text TEXT,
    filename TEXT,
    size INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_type_seq ON messages (type, seq);
`);

const columns = '(id, type, name, text, filename, size, created_at) VALUES (:id, :type, :name, :text, :filename, :size, :createdAt)';
const insertMessage = db.prepare(`INSERT INTO messages ${columns}`);
const selectRecent = db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq');
const selectFiles = db.prepare("SELECT * FROM messages WHERE type = 'file' ORDER BY seq");
const selectFile = db.prepare("SELECT * FROM messages WHERE id = ? AND type = 'file'");

function messageParams(message) {
  return { text: null, filename: null, size: null, ...message };
}

function toMessage(row) {
  const message = { id: row.id, type: row.type, name: row.name };
  if (row.type === 'text') message.text = row.text;
  else Object.assign(message, { filename: row.filename, size: row.size });
  message.createdAt = row.created_at;
  return message;
}

// 예전 버전이 쓰던 messages.json이 있으면 DB로 옮기고, 원본은 .migrated로 이름을 바꿔 백업으로 남긴다.
if (fs.existsSync(legacyMessagesFile)) {
  const legacy = JSON.parse(fs.readFileSync(legacyMessagesFile, 'utf8'));
  if (!Array.isArray(legacy)) throw new Error('Invalid messages store');
  const insertLegacy = db.prepare(`INSERT OR IGNORE INTO messages ${columns}`);
  db.exec('BEGIN');
  try {
    for (const message of legacy) insertLegacy.run(messageParams(message));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  fs.renameSync(legacyMessagesFile, `${legacyMessagesFile}.migrated`);
  console.error(`messages.json의 메시지 ${legacy.length}개를 chat.db로 옮겼습니다.`);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function fail(res, status, error) {
  sendJson(res, status, { error });
}

function publish(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) client.write(payload);
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 24) || '익명';
}

function defaultHost() {
  const interfaces = Object.entries(os.networkInterfaces());
  interfaces.sort(([left], [right]) => {
    const rank = name => name === 'en0' || name === 'eth0' ? 0 : /^(en|eth|wlan)/.test(name) ? 1 : 2;
    return rank(left) - rank(right);
  });
  for (const [, entries] of interfaces) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [a, b] = entry.address.split('.').map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return entry.address;
    }
  }
  return '127.0.0.1';
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      const error = new Error('request_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeFilename(value) {
  return path.basename(String(value || 'file')).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) || 'file';
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'POST' && req.headers.origin) {
    let originHost;
    try { originHost = new URL(req.headers.origin).host; }
    catch { return fail(res, 403, '이 주소에서 보낸 요청만 허용됩니다.'); }
    if (originHost !== req.headers.host) return fail(res, 403, '이 주소에서 보낸 요청만 허용됩니다.');
  }

  if (req.method === 'GET' && pathname === '/api/messages') {
    return sendJson(res, 200, { messages: selectRecent.all(recentLimit).map(toMessage) });
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    return sendJson(res, 200, { files: selectFiles.all().map(toMessage) });
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/messages') {
    let input;
    try { input = JSON.parse((await readBody(req)).toString('utf8')); }
    catch (error) { if (error.status) throw error; return fail(res, 400, '메시지 형식이 올바르지 않습니다.'); }
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (!text || text.length > 4000) return fail(res, 400, '메시지는 1~4000자로 입력해 주세요.');
    const message = { id: randomUUID(), type: 'text', name: cleanName(input.name), text, createdAt: new Date().toISOString() };
    insertMessage.run(messageParams(message));
    publish(message);
    return sendJson(res, 201, { message });
  }

  if (req.method === 'POST' && pathname === '/api/files') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data;')) return fail(res, 415, '파일 업로드 형식이 올바르지 않습니다.');
    const body = await readBody(req);
    const form = await new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return fail(res, 400, '파일을 선택해 주세요.');
    if (file.size === 0 || file.size > maxUploadBytes) return fail(res, 413, '파일 크기는 25MB 이하여야 합니다.');
    const name = safeFilename(file.name);
    const id = randomUUID();
    fs.writeFileSync(path.join(uploadDir, id), Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
    const message = { id, type: 'file', name: cleanName(form.get('name')), filename: name, size: file.size, createdAt: new Date().toISOString() };
    try { insertMessage.run(messageParams(message)); }
    catch (error) { fs.unlinkSync(path.join(uploadDir, id)); throw error; }
    publish(message);
    return sendJson(res, 201, { message });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/files/')) {
    const id = pathname.slice('/api/files/'.length);
    const row = selectFile.get(id);
    if (!row) return fail(res, 404, '파일을 찾을 수 없습니다.');
    const message = toMessage(row);
    const filename = path.join(uploadDir, id);
    if (!fs.existsSync(filename)) return fail(res, 404, '파일을 찾을 수 없습니다.');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': message.size,
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(message.filename)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    return fs.createReadStream(filename).pipe(res);
  }

  if (req.method !== 'GET') return fail(res, 404, '요청한 주소를 찾을 수 없습니다.');
  const asset = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(publicDir, `.${asset}`);
  if (!file.startsWith(`${publicDir}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, '요청한 주소를 찾을 수 없습니다.');
  res.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      console.error(error);
      if (!res.headersSent) fail(res, error.status || 500, error.status === 413 ? '요청 크기가 너무 큽니다.' : '잠시 후 다시 시도해 주세요.');
      else res.end();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || defaultHost();
  const server = createServer();
  server.listen(port, host, () => console.log(`10km Chat: http://${host}:${server.address().port}`));
}
