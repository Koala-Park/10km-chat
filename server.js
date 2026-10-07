import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadDir = path.join(dataDir, 'uploads');
const messagesFile = path.join(dataDir, 'messages.json');
const maxUploadBytes = 25 * 1024 * 1024;
const maxRequestBytes = maxUploadBytes + 1024 * 1024;
const clients = new Set();

fs.mkdirSync(uploadDir, { recursive: true });
let messages = [];
if (fs.existsSync(messagesFile)) {
  messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
  if (!Array.isArray(messages)) throw new Error('Invalid messages store');
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

function saveMessages() {
  const temp = `${messagesFile}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(messages));
  fs.renameSync(temp, messagesFile);
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
    return sendJson(res, 200, { messages: messages.slice(-200) });
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    return sendJson(res, 200, { files: messages.filter(item => item.type === 'file') });
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
    messages.push(message);
    saveMessages();
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
    try { messages.push(message); saveMessages(); }
    catch (error) { messages.pop(); fs.unlinkSync(path.join(uploadDir, id)); throw error; }
    publish(message);
    return sendJson(res, 201, { message });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/files/')) {
    const id = pathname.slice('/api/files/'.length);
    const message = messages.find(item => item.id === id && item.type === 'file');
    if (!message) return fail(res, 404, '파일을 찾을 수 없습니다.');
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
