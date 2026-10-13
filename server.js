import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
const dbFile = path.join(dataDir, 'chat.db');
const legacyMessagesFile = path.join(dataDir, 'messages.json');
// 파일 업로드는 크기 제한 없이 디스크로 바로 흘려 쓰고, 이 제한은 JSON 메시지 요청에만 적용한다.
const maxJsonBytes = 1024 * 1024;
const recentLimit = 200;
const cleanupIntervalMs = 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const clients = new Set();

// 보관 기간(일). 비워 두거나 0이면 지우지 않는다. 파일 메시지는 둘 중 짧은 기간이 적용된다.
function retentionDays(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return 0;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) throw new Error(`${name}는 0 이상의 숫자(일)여야 합니다: ${value}`);
  return days;
}
const messageRetentionDays = retentionDays('RETENTION_DAYS');
const fileRetentionDays = retentionDays('FILE_RETENTION_DAYS');

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
  CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at);
`);
// content_type은 업로드할 때 파일 앞부분으로 판별한 형식이다. NULL은 아직 판별하지 않은 예전 파일.
// batch_id는 한 번에 함께 올린 파일을 묶는 값으로, 화면에서 한 메시지로 모아 보여 줄 때 쓴다.
const existingColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(column => column.name));
if (!existingColumns.has('content_type')) db.exec('ALTER TABLE messages ADD COLUMN content_type TEXT');
if (!existingColumns.has('batch_id')) db.exec('ALTER TABLE messages ADD COLUMN batch_id TEXT');

const columns = '(id, type, name, text, filename, size, created_at, content_type, batch_id) VALUES (:id, :type, :name, :text, :filename, :size, :createdAt, :contentType, :batch)';
const insertMessage = db.prepare(`INSERT INTO messages ${columns}`);
const selectRecent = db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT ?) ORDER BY seq');
const selectFiles = db.prepare("SELECT * FROM messages WHERE type = 'file' ORDER BY seq");
const selectFile = db.prepare("SELECT * FROM messages WHERE id = ? AND type = 'file'");
const selectExpired = db.prepare("SELECT id, type FROM messages WHERE created_at < :messageCutoff OR (type = 'file' AND created_at < :fileCutoff)");
const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?');

// 브라우저에서 바로 보여 줄 형식만 이미지로 취급한다. SVG처럼 스크립트를 품을 수 있는 형식은 제외.
const genericType = 'application/octet-stream';
function sniffImageType(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return genericType;
}

function messageParams(message) {
  const { imageType, ...rest } = message;
  return { text: null, filename: null, size: null, batch: null, contentType: imageType || null, ...rest };
}

function toMessage(row) {
  const message = { id: row.id, type: row.type, name: row.name };
  if (row.type === 'text') message.text = row.text;
  else {
    Object.assign(message, { filename: row.filename, size: row.size });
    if (row.content_type?.startsWith('image/')) message.imageType = row.content_type;
  }
  if (row.batch_id) message.batch = row.batch_id;
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

// 형식을 모르는 예전 파일은 한 번만 앞부분을 읽어 판별해 둔다.
const unsniffed = db.prepare("SELECT id FROM messages WHERE type = 'file' AND content_type IS NULL").all();
if (unsniffed.length) {
  const setContentType = db.prepare('UPDATE messages SET content_type = ? WHERE id = ?');
  for (const { id } of unsniffed) {
    const head = Buffer.alloc(16);
    let length = 0;
    try {
      const fd = fs.openSync(path.join(uploadDir, id), 'r');
      try { length = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    setContentType.run(sniffImageType(head.subarray(0, length)), id);
  }
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

function publish(message, event) {
  const payload = `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) client.write(payload);
}

// 보관 기간이 지난 메시지를 지우고, 파일 메시지면 올린 파일도 함께 지운다.
export function cleanupExpired(now = Date.now()) {
  if (!messageRetentionDays && !fileRetentionDays) return [];
  // ISO 문자열끼리 비교한다. 기간이 없으면 어떤 created_at보다도 앞서는 빈 문자열을 기준으로 둔다.
  const cutoff = days => days ? new Date(now - days * dayMs).toISOString() : '';
  const expired = selectExpired.all({ messageCutoff: cutoff(messageRetentionDays), fileCutoff: cutoff(fileRetentionDays) });
  if (!expired.length) return [];
  db.exec('BEGIN');
  try {
    for (const { id } of expired) deleteMessage.run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  for (const { id, type } of expired) {
    if (type !== 'file') continue;
    try { fs.rmSync(path.join(uploadDir, id), { force: true }); }
    catch (error) { console.error(`업로드 파일 ${id}를 지우지 못했습니다.`, error); }
  }
  const ids = expired.map(row => row.id);
  publish({ ids }, 'removed');
  return ids;
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
    if (size > maxJsonBytes) {
      const error = new Error('request_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 함께 보낸 파일·메시지를 묶는 값. 형식이 이상하면 묶지 않는다.
function cleanBatch(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : undefined;
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
    return sendJson(res, 200, {
      messages: selectRecent.all(recentLimit).map(toMessage),
      retention: { messageDays: messageRetentionDays, fileDays: fileRetentionDays },
    });
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
    const batch = cleanBatch(input.batch);
    if (batch) message.batch = batch;
    insertMessage.run(messageParams(message));
    publish(message);
    return sendJson(res, 201, { message });
  }

  if (req.method === 'POST' && pathname === '/api/files') {
    // 본문은 파일 그대로(application/octet-stream), 파일명과 보낸 사람은 쿼리로 받는다.
    if (req.headers['content-type'] !== 'application/octet-stream') return fail(res, 415, '파일 업로드 형식이 올바르지 않습니다.');
    const id = randomUUID();
    const target = path.join(uploadDir, id);
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      await pipeline(req, async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
          yield chunk;
        }
      }, fs.createWriteStream(target, { flags: 'wx' }));
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw error;
    }
    if (size === 0) {
      fs.rmSync(target, { force: true });
      return fail(res, 400, '빈 파일은 올릴 수 없습니다.');
    }
    const message = { id, type: 'file', name: cleanName(url.searchParams.get('name')), filename: safeFilename(url.searchParams.get('filename')), size, createdAt: new Date().toISOString() };
    const contentType = sniffImageType(head);
    if (contentType !== genericType) message.imageType = contentType;
    const batch = cleanBatch(url.searchParams.get('batch'));
    if (batch) message.batch = batch;
    try { insertMessage.run({ ...messageParams(message), contentType }); }
    catch (error) { fs.rmSync(target, { force: true }); throw error; }
    publish(message);
    return sendJson(res, 201, { message });
  }

  // /api/files/:id는 다운로드, /api/files/:id/image는 채팅 화면에 바로 보여 줄 이미지.
  const fileRoute = req.method === 'GET' && pathname.match(/^\/api\/files\/([^/]+)(\/image)?$/);
  if (fileRoute) {
    const [, id, inline] = fileRoute;
    const row = selectFile.get(id);
    if (!row) return fail(res, 404, '파일을 찾을 수 없습니다.');
    const message = toMessage(row);
    if (inline && !message.imageType) return fail(res, 404, '이미지 파일이 아닙니다.');
    const filename = path.join(uploadDir, id);
    if (!fs.existsSync(filename)) return fail(res, 404, '파일을 찾을 수 없습니다.');
    const disposition = `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(message.filename)}`;
    res.writeHead(200, {
      'Content-Type': inline ? message.imageType : 'application/octet-stream',
      'Content-Length': message.size,
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      ...(inline && {
        // 올린 파일은 id별로 내용이 바뀌지 않으므로 오래 캐시해 대화를 다시 그릴 때 깜빡이지 않게 한다.
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      }),
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  // 큰 파일 업로드가 Node 기본값(5분)에 끊기지 않도록 요청 시간 제한을 끈다.
  return http.createServer({ requestTimeout: 0 }, (req, res) => {
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
  if (messageRetentionDays || fileRetentionDays) {
    const removed = cleanupExpired();
    if (removed.length) console.error(`보관 기간이 지난 메시지 ${removed.length}개를 정리했습니다.`);
    setInterval(() => {
      try { cleanupExpired(); } catch (error) { console.error('오래된 메시지를 정리하지 못했습니다.', error); }
    }, cleanupIntervalMs).unref();
  }
  server.listen(port, host, () => console.log(`10km Chat: http://${host}:${server.address().port}`));
}
