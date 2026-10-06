import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'novel-king-blank-test-'));
let processHandle;
let baseUrl;
let database;
before(async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) throw new Error('隔离服务启动失败');
    try { if ((await fetch(`${baseUrl}/api/works`)).ok) break; } catch {}
    if (attempt === 99) throw new Error('隔离服务启动超时');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  database = new DatabaseSync(path.join(dataDir, 'novel.db'));
});
after(() => { database?.close(); processHandle?.kill(); });
const create = (body) => fetch(`${baseUrl}/api/works`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('新建空稿一次提交产生作品和首章，旧接口保留原行为', async () => {
  const response = await create({ title: '未命名作品', initial_chapter: true });
  assert.equal(response.status, 201);
  const work = await response.json();
  assert.ok(work.initial_chapter_id > 0, '响应须含首章 ID');
  const chapters = await (await fetch(`${baseUrl}/api/chapters?work_id=${work.id}`)).json();
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].id, work.initial_chapter_id);
  assert.equal(chapters[0].title, '第1章');
  assert.equal(chapters[0].content, '');
  const legacy = await (await create({ title: '旧流程作品' })).json();
  assert.equal((await (await fetch(`${baseUrl}/api/chapters?work_id=${legacy.id}`)).json()).length, 0);
});

test('章节写入失败，事务回滚作品；成功重试不会留空壳', async () => {
  const countBefore = database.prepare('SELECT count(*) AS n FROM works').get().n;
  database.exec("CREATE TRIGGER reject_initial_chapter BEFORE INSERT ON chapters WHEN NEW.title = '第1章' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  try {
    const failed = await create({ title: '回滚验证作品', initial_chapter: true });
    assert.equal(failed.ok, false);
    assert.equal(database.prepare('SELECT count(*) AS n FROM works').get().n, countBefore);
  } finally { database.exec('DROP TRIGGER reject_initial_chapter'); }
  assert.equal((await create({ title: '回滚验证作品', initial_chapter: true })).status, 201);
  assert.equal(database.prepare("SELECT count(*) AS n FROM works WHERE title = '回滚验证作品'").get().n, 1);
});
