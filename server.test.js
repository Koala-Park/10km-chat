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

async function start(dir = dataDir) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, DATA_DIR: dir, HOST: '127.0.0.1', PORT: '0' },
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

function upload(name, filename, body) {
  const params = new URLSearchParams({ name, filename });
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
