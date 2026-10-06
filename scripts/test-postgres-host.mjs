import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresDatabase } from '../storage/postgres.mjs';
import { createAccountServer } from '../account-server.mjs';

test('operator password reset opens PostgreSQL accounts without requiring a legacy SQLite file', { timeout: 30000 }, async () => {
  const { openAccountPasswordStore } = await import('./reset-account-password.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-pg-reset-'));
  const schema = 'nk_test_' + randomUUID().replaceAll('-', '');
  let store;
  try {
    store = openAccountPasswordStore({ NOVELKING_ACCOUNT_ROOT: directory, NOVELKING_DATABASE_URL: process.env.NOVELKING_TEST_DATABASE_URL, NOVELKING_ACCOUNT_SCHEMA: schema });
    const user = await store.createUser('重置测试作者', 'Fixture-original-password');
    const token = store.newSession(user);
    await store.resetPasswordByOperator(user.username, 'Fixture-replaced-password');
    assert.equal(store.session(token), undefined);
    assert.equal((await store.login('127.0.0.1', user.username, 'Fixture-replaced-password')).id, user.id);
    assert.equal(fs.existsSync(path.join(directory, 'accounts.db')), false);
  } finally {
    store?.close();
    const cleanup = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    cleanup.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); cleanup.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('full application SQLite data migrates to PostgreSQL with model keys, nested files and research snapshots intact', { timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-full-pg-migration-'));
  const schema = 'nk_test_' + randomUUID().replaceAll('-', ''); let child, base;
  async function start(postgres) {
    t.diagnostic(postgres ? 'Starting migrated PostgreSQL host' : 'Starting SQLite fixture host');
    let output = '';
    child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', NOVELKING_WORKER_PORT: '0', NOVELKING_WORKER_TOKEN: 'fixture-migration', NOVELSTUDIO_DATA_DIR: directory,
      NOVELSTUDIO_OV_DISABLED: '1', NOVELKING_DATABASE_URL: postgres ? process.env.NOVELKING_TEST_DATABASE_URL : '', NOVELKING_DATABASE_SCHEMA: schema }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    for (let attempt = 0; attempt < 150; attempt++) { const port = output.match(/NOVELKING_WORKER_READY:(\d+)/)?.[1]; if (port) { base = `http://127.0.0.1:${port}/api`; return; } if (child.exitCode !== null) throw Error(output); await delay(100); }
    throw Error('Migration host timeout: ' + output);
  }
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; } child = null; }
  async function api(route, body, method = body ? 'POST' : 'GET') {
    t.diagnostic('Request ' + method + ' ' + route);
    const response = await fetch(base + route, { method, headers: { 'x-novelking-worker': 'fixture-migration', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json(); assert.ok(response.ok, route + ': ' + JSON.stringify(payload)); return payload;
  }
  try {
    await start(false);
    const work = await api('/works', { title: '完整迁移的小说', initial_chapter: true });
    const config = await api('/api_configs', { name: '保存的模型', api_key: 'fixture-preserved-key', model: 'fixture', temperature: 0.8123456789 });
    const folder = await api('/files/folders', { name: '世界设定', area: 'world', work_id: work.id });
    const parent = await api('/files/folders', { name: '设定合集', area: 'world', work_id: work.id });
    await api('/files/folders/' + folder.id, { parent_id: parent.id }, 'PATCH');
    const response = await fetch(base + '/files/upload?' + new URLSearchParams({ area: 'world', name: '镜面.txt', folder_id: folder.id, work_id: work.id }), { method: 'POST', headers: { 'x-novelking-worker': 'fixture-migration' }, body: '镜面可保存记忆，代价是失去一段过去。' });
    assert.equal(response.status, 201); const file = await response.json();
    await api('/research/snapshots', { work_id: work.id, board: 'newbooks', source_url: 'https://www.qidian.com/rank/signNewBkAll/', books: [{ title: '作者登记的参考书' }] });
    t.diagnostic('Stopping SQLite fixture'); await stop(); const original = fs.readFileSync(path.join(directory, 'novel.db'));
    await start(true);
    assert.equal((await api('/works/' + work.id)).title, '完整迁移的小说');
    assert.equal((await api('/files/' + file.id + '/text?work_id=' + work.id)).text, '镜面可保存记忆，代价是失去一段过去。');
    assert.equal((await api('/research/status?work_id=' + work.id)).snapshots.length, 1);
    assert.equal((await api('/api_configs/' + config.id)).temperature, 0.8123456789);
    const database = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    try { assert.equal(database.prepare('SELECT api_key FROM api_configs WHERE id=?').get(config.id).api_key, 'fixture-preserved-key'); }
    finally { database.close(); }
    await stop(); assert.deepEqual(fs.readFileSync(path.join(directory, 'novel.db')), original);
  } finally { await stop(); const cleanup = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema); cleanup.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); cleanup.close(); }
});

test('existing novel, chapter, file and canvas HTTP APIs run on PostgreSQL', { timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-pg-host-'));
  const schema = 'nk_test_' + randomUUID().replaceAll('-', '');
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', NOVELKING_WORKER_PORT: '0',
    NOVELKING_WORKER_TOKEN: 'test-worker', NOVELKING_HOSTED: '1', NOVELSTUDIO_DATA_DIR: directory,
    NOVELSTUDIO_OV_DISABLED: '1', NOVELKING_DATABASE_URL: process.env.NOVELKING_TEST_DATABASE_URL, NOVELKING_DATABASE_SCHEMA: schema }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  try {
    let port;
    for (let attempt = 0; attempt < 150; attempt++) {
      port = output.match(/NOVELKING_WORKER_READY:(\d+)/)?.[1]; if (port) break;
      if (child.exitCode !== null) throw Error('Host did not boot: ' + output);
      await delay(100);
    }
    assert.ok(port, output);
    const api = async (route, body, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method,
        headers: { 'x-novelking-worker': 'test-worker', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const json = await response.json(); assert.ok(response.ok, `${route}: ${JSON.stringify(json)}`); return json;
    };
    const work = await api('/works', { title: 'PG 小说' });
    const chapter = await api('/chapters', { title: '第一章', work_id: work.id, content: '<p>中文正文</p>' });
    assert.equal((await api(`/chapters/${chapter.id}`)).content, '<p>中文正文</p>');
    const uploaded = await fetch(`http://127.0.0.1:${port}/api/files/upload?` + new URLSearchParams({ area: 'world', work_id: work.id, name: 'mirror.txt' }), { method: 'POST', headers: { 'x-novelking-worker': 'test-worker' }, body: '古老镜面保存记忆' });
    assert.equal(uploaded.status, 201);
    const document = await uploaded.json();
    assert.equal((await api(`/files?area=world&work_id=${work.id}&q=镜面`)).files[0].id, document.id);
    assert.equal((await api(`/files?area=world&work_id=${work.id}&q=MIRROR`)).files[0].id, document.id);
    assert.equal((await api(`/files?area=world&work_id=${work.id}&q=不存在`)).files.length, 0);
    await api(`/canvas?work_id=${work.id}`, { scene: { elements: [], appState: {}, files: {} }, revision: 0 }, 'PUT');
    const database = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    try {
      assert.equal(database.prepare('SELECT title FROM works WHERE id=?').get(work.id).title, 'PG 小说');
      assert.equal(database.prepare('SELECT count(*) AS n FROM work_canvases').get().n, 1);
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length >= 75);
      assert.equal(database.prepare('SELECT extname FROM pg_extension WHERE extname=?').get('vector')?.extname, 'vector');
    } finally { database.close(); }
  } finally {
    child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    const cleanup = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    cleanup.exec(`DROP SCHEMA "${schema}" CASCADE`); cleanup.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('account gateway persists accounts in PostgreSQL and routes two users to isolated novel schemas', { timeout: 45000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-pg-accounts-'));
  const schema = 'nk_test_' + randomUUID().replaceAll('-', '');
  const app = await createAccountServer({ PORT: '3796', NOVELKING_PUBLIC_ORIGIN: 'http://127.0.0.1:3796',
    NOVELKING_ACCOUNT_ROOT: directory, NOVELKING_ADMIN_USER: 'PG-owner', NOVELKING_ADMIN_PASSWORD: 'Fixture-pg-owner-password',
    NOVELKING_DATABASE_URL: process.env.NOVELKING_TEST_DATABASE_URL, NOVELKING_ACCOUNT_SCHEMA: schema });
  const userSchemas = [];
  try {
    await new Promise(resolve => app.server.listen(3796, '127.0.0.1', resolve));
    assert.equal(app.store.db.kind, 'postgres');
    const alice = await app.store.createUser('PG-Alice', 'Fixture-alice-password');
    const bob = await app.store.createUser('PG-Bob', 'Fixture-bob-password');
    const cookies = [alice, bob].map(user => 'novelking_session=' + app.store.newSession(user));
    for (const user of [alice, bob]) userSchemas.push('nk_u_' + user.id.replaceAll('-', ''));
    async function request(route, cookie, body) {
      const response = await fetch('http://127.0.0.1:3796/api' + route, { method: body ? 'POST' : 'GET',
        headers: { Origin: 'http://127.0.0.1:3796', Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const json = await response.json(); assert.ok(response.ok, JSON.stringify(json)); return json;
    }
    const first = await request('/works', cookies[0], { title: 'Alice 的小说' });
    const second = await request('/works', cookies[1], { title: 'Bob 的小说' });
    assert.equal(first.id, second.id);
    assert.equal((await request('/works/' + first.id, cookies[1])).title, 'Bob 的小说');
    const migrated = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, userSchemas[0]);
    try { assert.equal(migrated.prepare('SELECT title FROM works WHERE id=?').get(first.id).title, 'Alice 的小说'); }
    finally { migrated.close(); }
    assert.equal(fs.existsSync(path.join(directory, 'accounts.db')), false);
  } finally {
    app.close();
    const cleanup = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    try {
      for (const name of userSchemas) cleanup.exec(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      cleanup.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { cleanup.close(); }
  }
});
