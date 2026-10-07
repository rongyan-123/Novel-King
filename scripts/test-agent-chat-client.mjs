import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const client = () => {
  const sandbox = { window: {}, URL, console };
  vm.runInNewContext(fs.readFileSync(new URL('../public/agent-chat.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.NovelKingChat;
};
test('editorial response renders readable headings, lists, tables and safe source links', () => {
  const html = client().markdown('## 编辑判断\n\n**建议重构**\n\n- 改故事引擎\n- 再改开篇\n\n| 样本 | 成分 |\n| --- | --- |\n| 甲书 | 仙侠 |\n\n[新书榜](https://www.qidian.com/rank/newbooks/)');
  assert.match(html, /<h2>编辑判断<\/h2>/); assert.match(html, /<strong>建议重构<\/strong>/);
  assert.match(html, /<ul>/); assert.match(html, /<table>/);
  assert.match(html, /href="https:\/\/www.qidian.com\/rank\/newbooks\//);
});
test('chat refuses script links, raw HTML and event handlers in model or tool text', () => {
  const html = client().markdown('<script>alert(1)</script>\n[点击](javascript:alert(1))\n<img src=x onerror=alert(2)>\n[来源](https://example.org/" onmouseover="alert(3))');
  assert.doesNotMatch(html, /<(script|img)\b|href="javascript:|<[^>]*\bonmouseover=/);
  assert.match(html, /&lt;script&gt;/);
});
test('tool activity uses plain task names without exposing hidden reasoning', () => {
  const activity = client().activity([{ type: 'tool/call', data: { name: 'skill_read', arguments: { id: 'editorial-review' } } },
    { type: 'tool/call', data: { name: 'qidian_scan_ranking', arguments: { board: 'newbooks' } } },
    { type: 'tool/result', data: { name: 'qidian_scan_ranking' } },
    { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: '隐藏推理不显示' } } }]);
  assert.equal(activity.length, 2); assert.match(activity[0].label, /编辑/); assert.match(activity[1].label, /新书榜/);
  assert.doesNotMatch(JSON.stringify(activity), /隐藏推理/);
});

test('switching conversations while a send is connecting never inserts its reply into the selected history', async () => {
  let resumeResponse;
  const input = { value: '研究第一本小说' }, selected = { id: 'selected-history', work_id: 2 }, selectedMessages = [{ id: 'kept', role: 'user', content: '第二本小说的历史' }];
  const source = fs.readFileSync(new URL('../public/agent-chat.js', import.meta.url), 'utf8').replace('window.NovelKingChat = { markdown, activity,', 'window.NovelKingChat = { markdown, activity, Chat,');
  const sandbox = { URL, TextDecoder, console, window: { NovelKingResearch: { streamDecoder: () => ({ push: text => text.trim().split('\n\n').map(frame => JSON.parse(frame.slice(6))) }) } },
    fetch: async () => new Promise(resolve => { resumeResponse = resolve; }) };
  vm.runInNewContext(source, sandbox);
  const chat = Object.assign(Object.create(sandbox.window.NovelKingChat.Chat.prototype), {
    root: { isConnected: true, querySelector: () => input }, options: {}, sequence: 0, configId: 1,
    conversation: { id: 'sending-history', work_id: 1 }, workId: 1, messages: [],
    paintComposer() {}, paintMessages() {}, note() {}, write() {}, async refreshHistory() {}, watch() {}
  });
  const pending = chat.send();
  await Promise.resolve();
  chat.conversation = selected; chat.messages = selectedMessages; chat.sequence++;
  const frames = [{ type: 'started', conversation: { id: 'sending-history', work_id: 1 }, user: { id: 'sent', role: 'user', content: input.value }, message: { id: 'reply', role: 'assistant', content: '', status: 'running' } },
    { type: 'complete', message: { id: 'reply', role: 'assistant', content: '第一本小说的回答', status: 'complete', events: [] } }];
  let received = false;
  resumeResponse({ ok: true, body: { getReader: () => ({ read: async () => received ? { done: true } : (received = true, { done: false, value: new TextEncoder().encode(frames.map(frame => 'data: ' + JSON.stringify(frame)).join('\n\n')) }) }) } });
  await pending;
  assert.equal(chat.conversation.id, 'selected-history');
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.messages[0].id, 'kept');
});

test('a rejected first request keeps its draft under the new durable conversation ID', async () => {
  const input = { value: '尚未配置模型也不能丢这份问题草稿' }, drafts = new Map();
  const source = fs.readFileSync(new URL('../public/agent-chat.js', import.meta.url), 'utf8').replace('window.NovelKingChat = { markdown, activity,', 'window.NovelKingChat = { markdown, activity, Chat,');
  const sandbox = { URL, AbortSignal, console, window: {}, fetch: async route => route.endsWith('/conversations')
    ? { ok: true, json: async () => ({ id: 'created', work_id: 1 }) } : { ok: false, json: async () => ({ error: '请配置 API 密钥' }) } };
  vm.runInNewContext(source, sandbox);
  const chat = Object.assign(Object.create(sandbox.window.NovelKingChat.Chat.prototype), { root: { isConnected: true, querySelector: () => input }, options: {}, sequence: 0,
    configId: 1, workId: 1, messages: [], paintComposer() {}, note() {}, write: (key, value) => drafts.set(key, value), async refreshHistory() {}, watch() {} });
  await chat.send();
  assert.equal(chat.conversation.id, 'created');
  assert.equal(drafts.get('novelking.agent.draft.created'), input.value);
});

test('a slow history switch cannot send a new question to the previously selected novel', async () => {
  let respond, requests = 0;
  const source = fs.readFileSync(new URL('../public/agent-chat.js', import.meta.url), 'utf8').replace('window.NovelKingChat = { markdown, activity,', 'window.NovelKingChat = { markdown, activity, Chat,');
  const sandbox = { URL, AbortSignal, console, window: {}, fetch: async () => { requests++; return new Promise(resolve => { respond = resolve; }); } };
  vm.runInNewContext(source, sandbox);
  const chat = Object.assign(Object.create(sandbox.window.NovelKingChat.Chat.prototype), { root: { isConnected: true, querySelector: () => ({ value: '给新选小说的问题' }) },
    options: {}, sequence: 0, configId: 1, conversation: { id: 'old', work_id: 1 }, workId: 1, messages: [], paintComposer() {}, paint() {}, note() {}, write() {}, watch() {} });
  const pending = chat.open('next');
  await Promise.resolve();
  chat.send();
  assert.equal(requests, 1, 'only the selected history request may run while it is loading');
  respond({ ok: true, json: async () => ({ conversation: { id: 'next', work_id: 2 }, messages: [] }) });
  await pending;
  assert.equal(chat.workId, 2);
});
