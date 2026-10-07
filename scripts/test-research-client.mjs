import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

function client() { const sandbox = { window: {} }; vm.runInNewContext(fs.readFileSync(new URL('../public/research.js', import.meta.url), 'utf8'), sandbox); return sandbox.window.NovelKingResearch; }
test('ranking paste accepts tab-separated fields and rejects blank books', () => {
  const research = client();
  const books = research.parseBooks('书名甲\t作者甲\t仙侠\thttps://www.qidian.com/book/1/\n\n书名乙');
  assert.equal(books.length, 2); assert.equal(books[0].rank, 1); assert.equal(books[0].author, '作者甲'); assert.equal(books[1].title, '书名乙');
  assert.throws(() => research.parseBooks(' \n'), /书名/);
});
test('stream parser handles split SSE frames and preserves unfinished frames', () => {
  const decoder = client().streamDecoder();
  assert.equal(decoder.push('data: {"type":"started",').length, 0);
  const events = decoder.push('"id":"1"}\n\ndata: {"type":"complete"}\n\n');
  assert.equal(events.length, 2); assert.equal(events[0].id, '1'); assert.equal(events[1].type, 'complete');
});

test('choosing shared research stays shared even when the writing workspace has an active novel', async () => {
  const requests = [], nodes = new Map();
  const root = { isConnected: true, querySelectorAll: () => [], querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { querySelector: root.querySelector.bind(root), querySelectorAll: () => [] });
    return nodes.get(selector);
  } };
  const sandbox = { window: {}, fetch: async route => { requests.push(route); return { ok: true, json: async () => ({ skills: [], runs: [], boards: [], snapshots: [], version: 'fixture' }) }; } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/research.js', import.meta.url), 'utf8'), sandbox);
  await sandbox.window.NovelKingResearch.mount(root, { workId: 7, works: [{ id: 7, title: '当前小说' }] });
  assert.equal(requests[0], '/api/research/status?work_id=7');
  nodes.get('#research-work').onchange({ target: { value: '' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[1], '/api/research/status?work_id=');
  assert.match(nodes.get('.research-body').innerHTML, /当前可查阅共享资料和榜单/);
});

test('chat settings use the selected conversation book after switching between novels', async () => {
  const requests = [], nodes = new Map();
  const root = { isConnected: true, querySelectorAll: () => [], querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { querySelector: root.querySelector.bind(root), querySelectorAll: () => [] });
    return nodes.get(selector);
  } };
  const sandbox = { window: {}, fetch: async route => { requests.push(route); return { ok: true, json: async () => ({ skills: [], runs: [], boards: [], snapshots: [], connectors: [], version: 'fixture' }) }; } };
  vm.runInNewContext(fs.readFileSync(new URL('../public/research.js', import.meta.url), 'utf8'), sandbox);
  for (const workId of [7, 8, null]) await sandbox.window.NovelKingResearch.mount(root, { workId, settingsOnly: true, tab: 'models' });
  assert.deepEqual(requests, ['/api/research/status?work_id=7', '/api/research/status?work_id=8', '/api/research/status?work_id=']);
});
