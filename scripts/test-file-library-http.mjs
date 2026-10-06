import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { docxFixture, pdfFixture } from './file-library-fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = mkdtempSync(`${tmpdir()}/novel-files-test-`);
let child, base, work;
async function start() {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${port}/api`;
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NOVELSTUDIO_DATA_DIR: dataDir, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('隔离服务启动失败');
    try { if ((await fetch(base + '/works')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('隔离服务启动超时');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill(); await exited;
}
async function request(route, method = 'GET', body, agent = false) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(agent ? { 'X-Novel-Agent': '1' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function upload(name, text, metadata = {}) {
  const query = new URLSearchParams({ area: 'world', name, ...metadata });
  const response = await fetch(base + '/files/upload?' + query, { method: 'POST', body: text });
  return { status: response.status, body: await response.json() };
}
before(async () => { await start(); work = (await request('/works', 'POST', { title: '资料库测试', initial_chapter: true })).body; });
after(stop);

test('用户建立目录、上传同名原件后重启，原件与全文保留且不依赖记忆库', async () => {
  const folder = await request('/files/folders', 'POST', { name: '能力体系', area: 'world', work_id: work.id });
  assert.equal(folder.status, 201);
  const first = await upload('设定.txt', '镜面可以保存记忆。\n第二行', { folder_id: folder.body.id, work_id: work.id });
  assert.equal(first.status, 201);
  const second = await upload('设定.txt', '另一份设定', { folder_id: folder.body.id, work_id: work.id });
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
  await stop(); await start();
  const list = await request(`/files?area=world&folder_id=${folder.body.id}&work_id=${work.id}`);
  assert.equal(list.body.files.length, 2);
  assert.equal(list.body.files.find(file => file.id === first.body.id).text_length, 13);
  const read = await request(`/files/${first.body.id}/text?work_id=${work.id}`);
  assert.equal(read.body.text, '镜面可以保存记忆。\n第二行');
  const original = await fetch(base + `/files/${first.body.id}/original?work_id=${work.id}`);
  assert.equal(await original.text(), '镜面可以保存记忆。\n第二行');
  assert.ok(original.headers.get('content-disposition').startsWith('attachment;'));
  assert.equal((await request('/files/status')).body.total_files, 2);
});

test('目录归属、内部 ID 与模型只读边界拒绝越界，坏请求不会留下文件', async () => {
  const other = (await request('/works', 'POST', { title: '另一本书' })).body;
  const folder = (await request('/files/folders', 'POST', { name: '本书设定', area: 'world', work_id: work.id })).body;
  assert.equal((await upload('错放.txt', '不能保存', { folder_id: folder.id, work_id: other.id })).status, 400);
  assert.equal((await upload('../escape.txt', '不能保存')).status, 400);
  assert.equal((await request('/files/folders', 'POST', { name: '错误', area: 'world', parent_id: folder.id })).status, 400);
  assert.equal((await request('/files/folders', 'POST', { name: '错误', area: 'world', work_id: 999999 })).status, 400);
  const file = (await upload('私有设定.txt', '仅本书阅读', { folder_id: folder.id, work_id: work.id })).body;
  assert.equal((await request(`/files/${file.id}/text?work_id=${other.id}`)).status, 404);
  assert.equal((await request('/files/status', 'GET', null, true)).status, 400, '模型必须指定资料范围');
  assert.equal((await request(`/files/${file.id}/text?work_id=${work.id}`, 'GET', null, true)).body.text, '仅本书阅读');
  for (const [route, method] of [['/files/upload?area=world&name=a.txt', 'POST'], ['/files/folders', 'POST'], [`/files/${file.id}`, 'PATCH'], [`/files/${file.id}`, 'DELETE'], [`/files/${file.id}/restore`, 'POST']]) {
    assert.equal((await request(route, method, { name: '不许操作' }, true)).status, 403);
  }
  assert.equal((await request('/files?scope=shared')).body.files.some(file => file.name === '错放.txt'), false);
});

test('用户手动移动、改名、删除及恢复；非空目录与循环移动被拒绝，搜索读到全文', async () => {
  const parent = (await request('/files/folders', 'POST', { name: '镜面世界', area: 'world' })).body;
  const nested = (await request('/files/folders', 'POST', { name: '历史', area: 'world', parent_id: parent.id })).body;
  const file = (await upload('起源.md', '首次记载发生在第三纪元', { folder_id: parent.id })).body;
  assert.equal((await request(`/files/folders/${parent.id}`, 'DELETE')).status, 409);
  assert.equal((await request(`/files/folders/${parent.id}`, 'PATCH', { parent_id: nested.id })).status, 400);
  assert.equal((await request(`/files/${file.id}`, 'PATCH', { name: '世界起源.md', folder_id: nested.id })).status, 200);
  assert.equal((await request('/files?scope=shared&area=world&q=第三纪元')).body.files[0].id, file.id);
  assert.equal((await request(`/files/${file.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/files/${file.id}/text?scope=shared`)).status, 404);
  assert.equal((await request('/files?trash=1&scope=shared')).body.files[0].id, file.id);
  assert.equal((await request(`/files/folders/${nested.id}`, 'DELETE')).status, 409, '回收站资料仍保留原目录');
  assert.equal((await request(`/files/${file.id}/restore`, 'POST')).status, 200);
  assert.equal((await request(`/files/${file.id}/text`)).body.text, '首次记载发生在第三纪元');
  assert.equal((await request(`/files/${file.id}/text`)).body.original_name, '起源.md', '改名后保留原上传文件名');
  const status = (await request('/files/status')).body;
  assert.equal(status.works.find(row => row.id === work.id).chapters, 1);
  assert.equal(status.books, 0);
  await request('/files/folders', 'POST', { name: '参考小说', area: 'books', kind: 'book', source: 'sanjiang' });
  assert.equal((await request('/files/status')).body.books, 1, '参考书按用户登记的书夹而不是文件计数');
});

test('DOCX 和 PDF 提取可检索正文；坏文件和旧 DOC 保留原件，不伪装成可读', async () => {
  for (const [name, original, expected] of [['剧情.docx', docxFixture(), '主角找到了镜子'], ['资料.pdf', pdfFixture(), 'The king found a mirror.']]) {
    const file = await upload(name, original, { area: 'research' });
    assert.equal(file.status, 201);
    assert.equal(file.body.read_status, 'ready', file.body.read_error);
    assert.ok((await request(`/files/${file.body.id}/text`)).body.text.includes(expected));
    assert.deepEqual(Buffer.from(await (await fetch(base + `/files/${file.body.id}/original`)).arrayBuffer()), original);
  }
  const broken = (await upload('坏文件.docx', 'this is not a zip')).body;
  assert.equal(broken.read_status, 'error'); assert.ok(broken.read_error);
  assert.equal(await (await fetch(base + `/files/${broken.id}/original`)).text(), 'this is not a zip');
  assert.equal((await upload('旧文档.doc', 'original-only')).body.read_status, 'original');
  const long = '完整正文'.repeat(20000);
  const file = (await upload('长正文.txt', long)).body;
  let restored = '', offset = 0;
  do { const page = (await request(`/files/${file.id}/text?offset=${offset}&limit=12345`)).body; restored += page.text; offset = page.next_offset; } while (offset !== null);
  assert.equal(restored, long);
  assert.equal((await upload('超限.txt', Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413);
});

test('图片仅按实际签名预览；取消中的上传不登记半文件，超限请求返回明确错误', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  const file = (await upload('地图.png', png)).body;
  const image = await fetch(base + `/files/${file.id}/preview`);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  const fake = (await upload('伪装.png', '<script>alert(1)</script>')).body;
  assert.equal((await fetch(base + `/files/${fake.id}/preview`)).status, 415);
  const baseline = (await request('/files/status')).body.total_files;
  await new Promise(resolve => {
    const partial = httpRequest(base + '/files/upload?area=world&name=取消.txt', { method: 'POST', headers: { 'Content-Length': 1000000 } });
    partial.on('error', resolve); partial.write('只传一部分'); setTimeout(() => { partial.destroy(); resolve(); }, 60);
  });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await request('/files/status')).body.total_files, baseline);
});

test('分页与请求格式错误明确拒绝；跨分类手动纠正位置不改原件或小说', async () => {
  const file = (await upload('错放的大纲.txt', '镜面世界的章节计划')).body;
  assert.equal((await request('/files?offset=Infinity')).status, 400);
  assert.equal((await request(`/files/${file.id}/text?offset=-1`)).status, 400);
  assert.equal((await request(`/files/${file.id}/text?limit=abc`)).status, 400);
  assert.equal((await request('/files/folders', 'POST', { name: '错误', area: 'world', work_id: 'abc' })).status, 400);
  const invalid = await fetch(base + '/files/folders', { method: 'POST', body: 'null' });
  assert.equal(invalid.status, 400);
  const before = (await request(`/chapters?work_id=${work.id}`)).body;
  assert.equal((await request(`/files/${file.id}`, 'PATCH', { area: 'outline', work_id: work.id, folder_id: null })).status, 200);
  assert.equal((await request(`/files/${file.id}/text?work_id=${work.id}&area=outline`)).body.text, '镜面世界的章节计划');
  assert.deepEqual((await request(`/chapters?work_id=${work.id}`)).body, before);
});

test('无 Content-Length 的超限上传仍返回 413；共享资料工具不返回私有作品概况', async () => {
  const status = await new Promise((resolve, reject) => {
    const streamed = httpRequest(base + '/files/upload?area=world&name=超限流.txt', { method: 'POST' }, response => { response.resume(); resolve(response.statusCode); });
    streamed.on('error', reject);
    streamed.write(Buffer.alloc(20 * 1024 * 1024)); streamed.end(Buffer.alloc(1024));
  });
  assert.equal(status, 413);
  assert.deepEqual((await request('/files/status?scope=shared', 'GET', null, true)).body.works, []);
});

test('升级前的 SQLite 备份仍能还原；未包含文件库的旧备份不丢当前资料', async () => {
  const baseline = (await request('/files/status')).body.total_files;
  const original = (await request('/files?scope=shared')).body.files[0];
  const backup = (await request('/backup', 'POST', { label: 'old-file-library-schema-fixture' })).body.backup;
  const fixture = new DatabaseSync(backup.path);
  fixture.exec('PRAGMA foreign_keys=OFF; DROP TABLE file_documents; DROP TABLE file_folders;'); fixture.close();
  const restored = await request('/backup/restore', 'POST', { path: backup.path });
  assert.equal(restored.status, 200, restored.body.error);
  assert.equal(restored.body.file_library_preserved, true);
  assert.equal((await request('/files/status')).body.total_files, baseline);
  assert.equal((await fetch(base + `/files/${original.id}/original`)).status, 200);
});

test('文件库小说卡片统计只属于各自小说，共享文件单独计数', async () => {
  const sharedBefore = (await request('/files?scope=shared')).body.total;
  const first = (await request('/works', 'POST', { title: '镜城资料测试' })).body;
  const second = (await request('/works', 'POST', { title: '星海资料测试' })).body;
  await upload('相同设定.txt', '镜城设定', { work_id: first.id });
  const deleted = (await upload('回收设定.txt', '回收内容', { work_id: first.id })).body;
  await request(`/files/${deleted.id}`, 'DELETE');
  await upload('相同设定.txt', '星海设定', { work_id: second.id });
  await upload('星海大纲.txt', '星海大纲', { work_id: second.id, area: 'outline' });
  const sharedFile = (await upload('共享技法.txt', '通用资料', { area: 'craft' })).body;
  const status = (await request('/files/status')).body;
  assert.equal(status.works.find(row => row.id === first.id).total_files, 1);
  assert.equal(status.works.find(row => row.id === second.id).total_files, 2);
  assert.equal(status.shared_files, sharedBefore + 1);
  assert.equal((await request(`/files/status?work_id=${first.id}`)).body.total_files, 1);
  assert.equal((await request(`/files?work_id=${first.id}&q=星海`)).body.total, 0);
  // Leave the fixture in the recycle bin after verifying its active-file counts.
  for (const owner of [first.id, second.id]) {
    for (const file of (await request(`/files?work_id=${owner}`)).body.files) await request(`/files/${file.id}`, 'DELETE');
  }
  await request(`/files/${sharedFile.id}`, 'DELETE');
});

test('编辑上传资料保留格式、更新全文检索，原件不变且重启后保留编辑稿', async () => {
  const original = docxFixture();
  const file = (await upload('可编辑设定.docx', original, { work_id: work.id })).body;
  const read = await request(`/files/${file.id}/edit?work_id=${work.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.html, null);
  assert.equal(read.body.revision, 0);
  assert.ok(read.body.text.includes('主角找到了镜子'));
  const edit = { html: '<h2>镜城</h2><p><b>新增能力</b>：读取梦境。</p>', text: '镜城\n新增能力：读取梦境。', revision: 0 };
  const saved = await request(`/files/${file.id}/content?work_id=${work.id}`, 'PUT', edit);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal((await request(`/files?work_id=${work.id}&q=读取梦境`)).body.files[0].id, file.id);
  await stop(); await start();
  const reread = (await request(`/files/${file.id}/edit?work_id=${work.id}`)).body;
  assert.equal(reread.html, edit.html);
  assert.equal(reread.text, edit.text);
  assert.equal(reread.revision, 1);
  assert.deepEqual(Buffer.from(await (await fetch(base + `/files/${file.id}/original?work_id=${work.id}`)).arrayBuffer()), original);
  assert.equal((await request(`/files/${file.id}/text?work_id=${work.id}`, 'GET', null, true)).body.text, edit.text);
  assert.equal((await request(`/files/${file.id}/content?work_id=${work.id}`, 'PUT', { ...edit, text: '过期稿' })).status, 409);
  assert.equal((await request(`/files/${file.id}/edit?work_id=${work.id}`)).body.text, edit.text);
  assert.equal((await request(`/files/${file.id}/content?scope=shared`, 'PUT', { ...edit, revision: 1 })).status, 404);
  assert.equal((await request(`/files/${file.id}/content?work_id=${work.id}`, 'PUT', { ...edit, revision: 1 }, true)).status, 403);
  assert.equal((await request(`/files/${file.id}/content`, 'PUT', { ...edit, revision: 1 })).status, 400);
  assert.equal((await request(`/files/${file.id}/content?work_id=${work.id}`, 'PUT', { html: 123, text: '坏请求', revision: 1 })).status, 400);
  const image = (await upload('预览图片.png', Buffer.from([137,80,78,71,13,10,26,10]), { work_id: work.id })).body;
  assert.equal((await request(`/files/${image.id}/edit?work_id=${work.id}`)).body.editable, false);
  assert.equal((await request(`/files/${image.id}/content?work_id=${work.id}`, 'PUT', edit)).status, 415);
  const empty = (await upload('空设定.txt', '', { work_id: work.id })).body;
  assert.equal((await request(`/files/${empty.id}/content?work_id=${work.id}`, 'PUT', { html: '<p>新设定</p>', text: '新设定', revision: 0 })).status, 200);
  const emptyText = (await request(`/files/${empty.id}/text?work_id=${work.id}`)).body;
  assert.equal(emptyText.text, '新设定');
  assert.equal(emptyText.read_status, 'ready');
  for (const id of [file.id, image.id, empty.id]) await request(`/files/${id}`, 'DELETE');
});

test('还原包含文件库但尚无编辑稿字段的旧备份，原件和文字可继续编辑', async () => {
  const file = (await upload('旧版本资料.txt', '旧版本的原始设定', { work_id: work.id })).body;
  const backup = (await request('/backup', 'POST', { label: 'pre-file-editor-schema' })).body.backup;
  const fixture = new DatabaseSync(backup.path);
  fixture.exec('ALTER TABLE file_documents DROP COLUMN edited_html; ALTER TABLE file_documents DROP COLUMN content_revision;');
  fixture.close();
  await request(`/files/${file.id}/content?work_id=${work.id}`, 'PUT', { html: '<p>新的编辑稿</p>', text: '新的编辑稿', revision: 0 });
  const restored = await request('/backup/restore', 'POST', { path: backup.path });
  assert.equal(restored.status, 200, restored.body.error);
  const read = (await request(`/files/${file.id}/edit?work_id=${work.id}`)).body;
  assert.equal(read.text, '旧版本的原始设定');
  assert.equal(read.html, null);
  assert.equal(read.revision, 0);
  assert.equal((await request(`/files/${file.id}/content?work_id=${work.id}`, 'PUT', { html: '<p>继续编辑</p>', text: '继续编辑', revision: 0 })).status, 200);
  assert.equal(await (await fetch(base + `/files/${file.id}/original?work_id=${work.id}`)).text(), '旧版本的原始设定');
});
