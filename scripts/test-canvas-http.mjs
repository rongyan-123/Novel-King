import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'novel-king-canvas-test-'));
let serverProcess, baseUrl, work, otherWork, fakeModel, captured, modelUrl;
const scene = { elements: [{ id: 'opening', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 }, { id: 'text', type: 'text', text: '主角在远处发现秘密', x: 20000, y: 10000 }], appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } }, files: {} };
async function request(route, method = 'GET', body) {
  const response = await fetch(baseUrl + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function startServer() {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (serverProcess.exitCode !== null) throw new Error('隔离画布服务启动失败');
    try { if ((await fetch(`${baseUrl}/api/works`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('隔离画布服务启动超时');
}
async function stopServer() {
  if (serverProcess?.exitCode !== null) return;
  const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
  serverProcess.kill();
  await exited;
}
before(async () => {
  await startServer();
  work = (await request('/works', 'POST', { title: '画布测试作品', initial_chapter: true })).body;
  otherWork = (await request('/works', 'POST', { title: '其他作品', initial_chapter: true })).body;
  fakeModel = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    captured = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ advice: '先埋伏笔，再安排反转', nodes: [{ id: 'plot1', text: '主角发现秘密' }, { id: 'plot2', text: '身份反转' }], edges: [{ from: 'plot1', to: 'plot2', label: '导致' }] }) } }] }));
  });
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  modelUrl = `http://127.0.0.1:${fakeModel.address().port}`;
});
after(async () => { await stopServer(); if (fakeModel) await new Promise((resolve) => fakeModel.close(resolve)); });

test('完整画布存入 SQLite，服务重启后保留屏幕外节点及视口', async () => {
  const initial = await request(`/canvas?work_id=${work.id}`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.revision, 0);
  const saved = await request(`/canvas?work_id=${work.id}`, 'PUT', { revision: 0, scene });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  await stopServer();
  await startServer();
  const restored = await request(`/canvas?work_id=${work.id}`);
  assert.deepEqual(restored.body.scene, scene);
  assert.equal(restored.body.revision, 1);
  assert.equal((await request(`/canvas?work_id=${otherWork.id}`)).body.revision, 0);
});

test('两个设备使用同一版本保存，只有一个成功，另一个得到冲突且不覆盖', async () => {
  const baseline = (await request(`/canvas?work_id=${work.id}`)).body;
  const firstScene = { ...scene, elements: [...scene.elements, { id: 'new', type: 'text', text: '已保存的反转' }] };
  const first = await request(`/canvas?work_id=${work.id}`, 'PUT', { revision: baseline.revision, scene: firstScene });
  assert.equal(first.status, 200);
  const stale = await request(`/canvas?work_id=${work.id}`, 'PUT', { revision: baseline.revision, scene });
  assert.equal(stale.status, 409);
  assert.deepEqual((await request(`/canvas?work_id=${work.id}`)).body.scene, firstScene);
});

test('画布拒绝跨作品章节、重复节点与无效结构，失败不会更改已保存内容', async () => {
  const baseline = (await request(`/canvas?work_id=${work.id}`)).body;
  for (const invalid of [
    { ...scene, elements: [{ id: 'foreign', type: 'rectangle', customData: { chapterId: otherWork.initial_chapter_id } }] },
    { ...scene, elements: [{ id: 'dup', type: 'text', text: 'A' }, { id: 'dup', type: 'text', text: 'B' }] },
    { ...scene, elements: 'broken' },
  ]) {
    assert.equal((await request(`/canvas?work_id=${work.id}`, 'PUT', { revision: baseline.revision, scene: invalid })).status, 400);
    assert.deepEqual((await request(`/canvas?work_id=${work.id}`)).body, baseline);
  }
  const linked = { ...scene, elements: [{ id: 'own', type: 'rectangle', customData: { chapterId: work.initial_chapter_id } }] };
  assert.equal((await request(`/canvas?work_id=${work.id}`, 'PUT', { revision: baseline.revision, scene: linked })).status, 200);
});

test('AI 实际请求包含屏幕外文字、箭头、章节正文、角色、设定和全图图片；结果只预览不写入', async () => {
  await request('/characters', 'POST', { work_id: work.id, name: '镜爷', personality: '谨慎且嘴硬' });
  await request('/terms', 'POST', { work_id: work.id, title: '镜面世界', content: '镜子能保存人的记忆' });
  await request(`/chapters/${work.initial_chapter_id}`, 'PUT', { content: '<p>主角第一次进入镜面世界。</p>' });
  const baseline = (await request(`/canvas?work_id=${work.id}`)).body;
  const aiScene = { ...scene, elements: [...scene.elements,
    { id: 'arrow', type: 'arrow', startBinding: { elementId: 'opening' }, endBinding: { elementId: 'text' }, points: [[0, 0], [20000, 10000]] },
    { id: 'removed', type: 'text', text: '已删剧情不应出现', isDeleted: true },
  ] };
  const result = await request('/ai/canvas', 'POST', { work_id: work.id, scene: aiScene, prompt: '设计反转', image: 'data:image/png;base64,YWJj', base_url: modelUrl, api_key: 'test-only-key', model: 'local-vision-test' });
  assert.equal(result.status, 200);
  const sent = JSON.stringify(captured.messages);
  for (const expected of ['主角在远处发现秘密', 'opening', 'arrow', '镜爷', '镜子能保存人的记忆', '主角第一次进入镜面世界', 'data:image/png;base64,YWJj']) assert.ok(sent.includes(expected), `缺少实际发送内容：${expected}`);
  assert.equal(sent.includes('已删剧情不应出现'), false);
  assert.equal(result.body.proposal.nodes.length, 2);
  assert.deepEqual((await request(`/canvas?work_id=${work.id}`)).body, baseline);
});

test('画布导入预检验证结构与章节归属，不保存也不推进版本', async () => {
  const before = (await request(`/canvas?work_id=${work.id}`)).body;
  assert.equal((await request(`/canvas/validate?work_id=${work.id}`, 'POST', { scene })).status, 200);
  assert.equal((await request(`/canvas/validate?work_id=${work.id}`, 'POST', { scene: { elements: 'bad' } })).status, 400);
  assert.deepEqual((await request(`/canvas?work_id=${work.id}`)).body, before);
});

test('模型通道不能保存画布，删除作品后其画布不可读', async () => {
  const baseline = (await request(`/canvas?work_id=${work.id}`)).body;
  const agentWrite = await fetch(`${baseUrl}/api/canvas?work_id=${work.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Novel-Agent': '1' },
    body: JSON.stringify({ revision: baseline.revision, scene }),
  });
  assert.equal(agentWrite.status, 403);
  assert.deepEqual((await request(`/canvas?work_id=${work.id}`)).body, baseline);
  assert.equal((await request(`/works/${work.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/canvas?work_id=${work.id}`)).status, 404);
});
