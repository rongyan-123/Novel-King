import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const accountRoot = mkdtempSync(`${tmpdir()}/novel-accounts-test-`);
let child, origin, alice, bob, admin, aliceWork, aliceFile;
const password = 'Fixture-password-2026';
async function request(route, method = 'GET', body, cookie = '', headers = {}) {
  const response = await fetch(origin + route, { method, redirect: 'manual', headers: {
    Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie, ...headers,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const content = await response.text();
  return { status: response.status, body: (() => { try { return JSON.parse(content); } catch { return content; } })(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
async function challenge() {
  const out = await request('/api/account/challenge');
  assert.equal(out.status, 200);
  assert.equal(out.body.answer, undefined);
  const [left, operator, right] = out.body.question.split(' ');
  return { challenge_id: out.body.id, answer: operator === '+' ? Number(left) + Number(right) : Number(left) * Number(right) };
}
async function register(username) {
  const out = await request('/api/account/register', 'POST', { username, password, ...await challenge() });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.cookie;
}
async function start() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['account-server.mjs'], { cwd: root, env: {
    ...process.env, PORT: String(port), NOVELKING_ACCOUNT_ROOT: accountRoot,
    NOVELKING_PUBLIC_ORIGIN: origin, NOVELKING_ADMIN_USER: 'owner', NOVELKING_ADMIN_PASSWORD: password,
    NOVELKING_MAX_WORKERS: '4', NOVELKING_CAPTCHA_TTL_MS: '500',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('账户服务启动失败：' + diagnostic);
    try { if ((await request('/api/account/status')).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('账户服务启动超时：' + diagnostic);
}
async function stop() {
  if (child?.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
}
before(start); after(stop);

test('匿名不能读取小说、文件或工作台；算术题错答、重放、过期均无效', async () => {
  for (const route of ['/api/works', '/api/files/status', '/api/canvas?work_id=1']) assert.equal((await request(route)).status, 401);
  assert.equal((await request('/')).status, 302);
  const first = await challenge();
  assert.equal((await request('/api/account/register', 'POST', { username: 'bad', password, ...first, answer: -1 })).status, 400);
  assert.equal((await request('/api/account/register', 'POST', { username: 'bad', password, ...first })).status, 400);
  const expired = await challenge();
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal((await request('/api/account/register', 'POST', { username: 'bad', password, ...expired })).status, 400);
  const valid = await challenge();
  const out = await request('/api/account/register', 'POST', { username: 'Alice', password, ...valid });
  assert.equal(out.status, 201); alice = out.cookie;
  assert.match(out.headers.get('set-cookie'), /HttpOnly/);
  assert.match(out.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await request('/api/account/register', 'POST', { username: 'Another', password, ...valid })).status, 400);
  assert.equal((await request('/api/account/register', 'POST', { username: 'alice', password, ...await challenge() })).status, 409);
  bob = await register('Bob');
  admin = (await request('/api/account/login', 'POST', { username: 'owner', password })).cookie;
});

test('账号分别持有数据库：相同小说 ID 也无法读改另一个账号；资料、画布、模型配置隔离', async () => {
  aliceWork = (await request('/api/works', 'POST', { title: 'Alice 私密小说', initial_chapter: true }, alice)).body;
  const bobWork = (await request('/api/works', 'POST', { title: 'Bob 私密小说', initial_chapter: true }, bob)).body;
  assert.equal(aliceWork.id, bobWork.id);
  assert.equal((await request(`/api/works/${aliceWork.id}`, 'GET', undefined, bob)).body.title, 'Bob 私密小说');
  await request(`/api/works/${aliceWork.id}`, 'PUT', { title: 'Bob 修改自己的作品' }, bob);
  assert.equal((await request(`/api/works/${aliceWork.id}`, 'GET', undefined, alice)).body.title, 'Alice 私密小说');
  const response = await fetch(origin + `/api/files/upload?work_id=${aliceWork.id}&area=world&name=setting.txt`, {
    method: 'POST', headers: { Origin: origin, Cookie: alice }, body: 'Alice 的私密设定',
  });
  assert.equal(response.status, 201); aliceFile = await response.json();
  assert.equal((await request(`/api/files/${aliceFile.id}/text?work_id=${aliceWork.id}`, 'GET', undefined, bob)).status, 404);
  assert.equal((await request(`/api/files/${aliceFile.id}`, 'DELETE', undefined, bob)).status, 404);
  assert.equal((await request(`/api/files/${aliceFile.id}/text?work_id=${aliceWork.id}`, 'GET', undefined, alice)).body.text, 'Alice 的私密设定');
  const scene = { elements: [], appState: { viewBackgroundColor: '#ff0000' }, files: {} };
  assert.equal((await request(`/api/canvas?work_id=${aliceWork.id}`, 'PUT', { revision: 0, scene }, alice)).status, 200);
  assert.equal((await request(`/api/canvas?work_id=${bobWork.id}`, 'GET', undefined, bob)).body.revision, 0);
  await request('/api/api_configs', 'POST', { name: 'Alice key', api_key: 'secret-alice', base_url: 'https://api.deepseek.com', model: 'deepseek-chat' }, alice);
  assert.equal((await request('/api/api_configs', 'GET', undefined, bob)).body.length, 0);
  assert.equal((await request('/api/account/users', 'GET', undefined, bob)).status, 403);
  assert.equal((await request('/api/account/users', 'GET', undefined, admin)).body.users.length, 3);
});

test('跨站写入、伪装主机工具、服务器文件导入、私网 AI 地址均被拒绝', async () => {
  assert.equal((await request('/api/works', 'POST', { title: 'CSRF' }, alice, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/works', 'POST', { title: '另一标签页的旧草稿' }, alice, { 'X-NovelKing-Account': 'different-account' })).status, 409);
  for (const route of ['/api/harness/run', '/api/env/open_folder', '/api/env/dsh_repo', '/api/backup/restore', '/api/novel/library/import/confirm', '/api/novel/openviking']) {
    assert.equal((await request(route, 'POST', { path: accountRoot }, alice)).status, 403, route);
  }
  const ssrf = await request('/api/ai/test', 'POST', { api_key: 'fixture', base_url: 'http://127.0.0.1:1' }, alice);
  assert.equal(ssrf.status, 403);
  const me = (await request('/api/account/me', 'GET', undefined, alice)).body.user;
  const workerLog = readFileSync(`${accountRoot}/users/${me.id}/worker.log`, 'utf8');
  const workerPort = workerLog.match(/NOVELKING_WORKER_READY:(\d+)/)[1];
  assert.equal((await fetch(`http://127.0.0.1:${workerPort}/api/works`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${workerPort}/`)).status, 401);
  const accountDb = new DatabaseSync(accountRoot + '/accounts.db', { readOnly: true });
  assert.ok(accountDb.prepare('SELECT password_hash FROM users').all().every(row => !row.password_hash.includes(password)));
  assert.ok(accountDb.prepare('SELECT token_hash FROM sessions').all().every(row => !row.token_hash.includes(alice.split('=')[1])));
  accountDb.close();
});

test('重启保留账号、会话与私有文件；修改密码撤销旧会话，管理员停用账号立即生效', async () => {
  const me = (await request('/api/account/me', 'GET', undefined, alice)).body.user;
  const workerPort = readFileSync(`${accountRoot}/users/${me.id}/worker.log`, 'utf8').match(/NOVELKING_WORKER_READY:(\d+)/)[1];
  await stop();
  await new Promise(resolve => setTimeout(resolve, 150));
  await assert.rejects(fetch(`http://127.0.0.1:${workerPort}/api/works`));
  await start();
  assert.equal((await request('/api/account/me', 'GET', undefined, alice)).body.user.username, 'Alice');
  assert.equal((await request(`/api/files/${aliceFile.id}/text?work_id=${aliceWork.id}`, 'GET', undefined, alice)).body.text, 'Alice 的私密设定');
  const newPassword = 'Changed-password-2026';
  assert.equal((await request('/api/account/password', 'POST', { current_password: password, new_password: newPassword }, alice)).status, 200);
  assert.equal((await request('/api/works', 'GET', undefined, alice)).status, 401);
  alice = (await request('/api/account/login', 'POST', { username: 'alice', password: newPassword })).cookie;
  const users = (await request('/api/account/users', 'GET', undefined, admin)).body.users;
  const bobId = users.find(user => user.username === 'Bob').id;
  assert.equal((await request(`/api/account/users/${bobId}`, 'PATCH', { disabled: true }, admin)).status, 200);
  assert.equal((await request('/api/works', 'GET', undefined, bob)).status, 401);
  assert.equal((await request('/api/account/logout', 'POST', {}, alice)).status, 200);
  assert.equal((await request('/api/works', 'GET', undefined, alice)).status, 401);
});

test('登录限流无法通过伪造 X-Forwarded-For 绕过', async () => {
  let limited = false;
  for (let i = 0; i < 16; i++) {
    const out = await request('/api/account/login', 'POST', { username: 'missing-user', password }, '', { 'X-Forwarded-For': `10.0.0.${i}` });
    if (out.status === 429) { limited = true; assert.ok(out.headers.get('retry-after')); break; }
    assert.equal(out.status, 401);
  }
  assert.ok(limited);
});
