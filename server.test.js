import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-chat-test-'));
let child;
let base;

async function start(dir = dataDir, extraEnv = {}) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // PORT=0 is useful for an ephemeral test port; server writes its chosen port below.
  const [chunk] = await once(child.stdout, 'data');
  const match = String(chunk).match(/:(\d+)\s*$/);
  assert.ok(match, `Unexpected server output: ${chunk}`);
  base = `http://127.0.0.1:${match[1]}`;
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit');
}

function upload(name, filename, body, extra = {}) {
  const params = new URLSearchParams({ name, filename, ...extra });
  return fetch(`${base}/api/files?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
}

test('messages and files are shared and persist after restart', async () => {
  try {
    await start();
    const empty = await (await fetch(`${base}/api/messages`)).json();
    assert.deepEqual(empty.messages, []);

    const posted = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '민지', text: '안녕하세요' }),
    });
    assert.equal(posted.status, 201);
    const message = (await posted.json()).message;
    assert.equal(message.name, '민지');
    assert.equal(message.text, '안녕하세요');

    const uploaded = await upload('준호', 'meeting.txt', '공유 문서');
    assert.equal(uploaded.status, 201);
    const file = (await uploaded.json()).message;
    assert.equal(file.filename, 'meeting.txt');
    assert.equal(file.name, '준호');
    const fileList = await (await fetch(`${base}/api/files`)).json();
    assert.deepEqual(fileList.files.map(item => item.id), [file.id]);
    const download = await fetch(`${base}/api/files/${file.id}`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), '공유 문서');
    assert.match(download.headers.get('content-disposition'), /attachment/);

    const rejected = await fetch(`${base}/api/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://outside.example' },
      body: JSON.stringify({ name: '외부', text: '차단' }),
    });
    assert.equal(rejected.status, 403);

    await stop();
    await start();
    const restored = await (await fetch(`${base}/api/messages`)).json();
    assert.equal(restored.messages.length, 2);
    assert.deepEqual(restored.messages.map(item => item.id), [message.id, file.id]);
  } finally {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('messages.json from the previous version is migrated into chat.db once', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-chat-legacy-'));
  const legacy = [
    { id: 'legacy-text', type: 'text', name: '민지', text: '예전 메시지', createdAt: '2026-09-17T00:33:20.869Z' },
    { id: 'legacy-file', type: 'file', name: '준호', filename: 'old.txt', size: 3, createdAt: '2026-09-17T00:34:00.000Z' },
  ];
  fs.writeFileSync(path.join(legacyDir, 'messages.json'), JSON.stringify(legacy));
  try {
    await start(legacyDir);
    const migrated = await (await fetch(`${base}/api/messages`)).json();
    assert.deepEqual(migrated.messages, legacy);
    assert.ok(!fs.existsSync(path.join(legacyDir, 'messages.json')));
    assert.ok(fs.existsSync(path.join(legacyDir, 'messages.json.migrated')));
    assert.ok(fs.existsSync(path.join(legacyDir, 'chat.db')));

    await stop();
    await start(legacyDir);
    const again = await (await fetch(`${base}/api/messages`)).json();
    assert.equal(again.messages.length, 2);
  } finally {
    await stop();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('files larger than the old 25MB limit upload and download intact', async () => {
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-chat-big-'));
  const big = Buffer.alloc(60 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
  try {
    await start(bigDir);
    const uploaded = await upload('민지', 'video.mp4', big);
    assert.equal(uploaded.status, 201);
    const file = (await uploaded.json()).message;
    assert.equal(file.size, big.length);
    assert.equal(fs.statSync(path.join(bigDir, 'uploads', file.id)).size, big.length);
    const download = Buffer.from(await (await fetch(`${base}/api/files/${file.id}`)).arrayBuffer());
    assert.ok(download.equals(big));

    const empty = await upload('민지', 'empty.txt', '');
    assert.equal(empty.status, 400);
    const multipart = await fetch(`${base}/api/files`, { method: 'POST', body: new FormData() });
    assert.equal(multipart.status, 415);
    assert.deepEqual(fs.readdirSync(path.join(bigDir, 'uploads')), [file.id]);
  } finally {
    await stop();
    fs.rmSync(bigDir, { recursive: true, force: true });
  }
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of png')]);

test('image uploads are recognized by content and served inline', async () => {
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-chat-image-'));
  try {
    await start(imageDir);
    const image = (await (await upload('민지', 'image.png', png)).json()).message;
    assert.equal(image.imageType, 'image/png');
    const inline = await fetch(`${base}/api/files/${image.id}/image`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'image/png');
    assert.match(inline.headers.get('content-disposition'), /^inline/);
    assert.ok(Buffer.from(await inline.arrayBuffer()).equals(png));
    const download = await fetch(`${base}/api/files/${image.id}`);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');

    // 확장자가 이미지여도 내용이 아니면, 또 SVG는 이미지로 보여 주지 않는다.
    const fake = (await (await upload('민지', 'fake.png', 'not an image')).json()).message;
    const svg = (await (await upload('민지', 'logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).json()).message;
    for (const file of [fake, svg]) {
      assert.equal(file.imageType, undefined);
      assert.equal((await fetch(`${base}/api/files/${file.id}/image`)).status, 404);
    }

    // 한 번에 올린 파일은 같은 batch로 묶여 돌아오고, 형식이 이상한 값은 버린다.
    const first = (await (await upload('민지', 'a.png', png, { batch: 'batch-1' })).json()).message;
    const second = (await (await upload('민지', 'b.png', png, { batch: 'batch-1' })).json()).message;
    const odd = (await (await upload('민지', 'c.png', png, { batch: '../x' })).json()).message;
    assert.equal(first.batch, 'batch-1');
    assert.equal(odd.batch, undefined);

    const listed = await (await fetch(`${base}/api/messages`)).json();
    assert.deepEqual(listed.messages.map(item => item.imageType), ['image/png', undefined, undefined, 'image/png', 'image/png', 'image/png']);
    assert.deepEqual(listed.messages.map(item => item.batch), [undefined, undefined, undefined, 'batch-1', 'batch-1', undefined]);
    assert.deepEqual([second.id, second.batch], [listed.messages[4].id, 'batch-1']);
    assert.deepEqual(listed.retention, { messageDays: 0, fileDays: 0 });
  } finally {
    await stop();
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
});

test('old messages and files are cleaned up by retention settings', async () => {
  const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moa-chat-cleanup-'));
  const daysAgo = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const legacy = [
    { id: 'text-40d', type: 'text', name: '민지', text: '아주 오래된 메시지', createdAt: daysAgo(40) },
    { id: 'file-40d', type: 'file', name: '준호', filename: 'old.png', size: png.length, createdAt: daysAgo(40) },
    { id: 'text-10d', type: 'text', name: '민지', text: '조금 지난 메시지', createdAt: daysAgo(10) },
    { id: 'file-10d', type: 'file', name: '준호', filename: 'recent.png', size: png.length, createdAt: daysAgo(10) },
    { id: 'file-1d', type: 'file', name: '준호', filename: 'new.png', size: png.length, createdAt: daysAgo(1) },
  ];
  fs.writeFileSync(path.join(cleanupDir, 'messages.json'), JSON.stringify(legacy));
  fs.mkdirSync(path.join(cleanupDir, 'uploads'));
  for (const message of legacy) if (message.type === 'file') fs.writeFileSync(path.join(cleanupDir, 'uploads', message.id), png);
  try {
    // 보관 기간을 정하지 않으면 아무것도 지우지 않고, 예전 파일도 이미지로 판별된다.
    await start(cleanupDir);
    const kept = await (await fetch(`${base}/api/messages`)).json();
    assert.equal(kept.messages.length, 5);
    assert.deepEqual(kept.messages.filter(item => item.type === 'file').map(item => item.imageType), ['image/png', 'image/png', 'image/png']);
    await stop();

    await start(cleanupDir, { RETENTION_DAYS: '30', FILE_RETENTION_DAYS: '7' });
    const cleaned = await (await fetch(`${base}/api/messages`)).json();
    assert.deepEqual(cleaned.messages.map(item => item.id), ['text-10d', 'file-1d']);
    assert.deepEqual(cleaned.retention, { messageDays: 30, fileDays: 7 });
    assert.deepEqual(fs.readdirSync(path.join(cleanupDir, 'uploads')), ['file-1d']);
    assert.equal((await fetch(`${base}/api/files/file-10d`)).status, 404);
    await stop();

    child = spawn(process.execPath, ['server.js'], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: { ...process.env, DATA_DIR: cleanupDir, HOST: '127.0.0.1', PORT: '0', RETENTION_DAYS: '한 달' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
  } finally {
    await stop();
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  }
});
