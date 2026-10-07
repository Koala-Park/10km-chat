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

    const form = new FormData();
    form.append('name', '준호');
    form.append('file', new Blob(['공유 문서'], { type: 'text/plain' }), 'meeting.txt');
    const uploaded = await fetch(`${base}/api/files`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 201);
    const file = (await uploaded.json()).message;
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
