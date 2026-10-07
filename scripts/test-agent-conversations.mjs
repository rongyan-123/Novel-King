import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore, compactToolEvent } from '../ai/research/conversations.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE works(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO works VALUES(1,\'演示稿\'),(2,\'其他小说\');');
  return { db, store: new ConversationStore(db) };
}
test('invalid model tool arguments do not interrupt activity persistence', () => {
  const event = compactToolEvent({ type: 'tool/call', data: { name: 'novel_catalog', callId: 'invalid-call', arguments: 'null' } });
  assert.deepEqual(event.data.arguments, {});
  assert.equal(event.data.callId, 'invalid-call');
});
test('multi-turn conversation persists messages and keeps its selected novel scope', () => {
  const { db, store } = fixture();
  try {
    const conversation = store.create({ work_id: 1 });
    const turn = store.startTurn(conversation.id, '根据起点榜单研究我的小说');
    store.finish(turn.assistant.id, { status: 'complete', content: '建议重写故事引擎。证据 novel:1/chapter:1。', events: [{ type: 'tool/call', data: { name: 'novel_catalog' } }] });
    assert.equal(store.get(conversation.id).work_id, 1);
    assert.equal(store.messages(conversation.id).length, 2);
    assert.match(store.list()[0].title, /起点榜单/);
    const followup = store.startTurn(conversation.id, '具体要改哪一层？');
    assert.equal(followup.history.length, 2);
    assert.equal(followup.history[1].role, 'assistant');
    assert.match(followup.history[1].content, /故事引擎/);
    assert.throws(() => store.startTurn(conversation.id, '重复提交'), /正在|未结束/);
  } finally { db.close(); }
});
test('restart preserves partial answers as interrupted without restarting paid work', () => {
  const { db, store } = fixture();
  try {
    const conversation = store.create({ work_id: 1 });
    const turn = store.startTurn(conversation.id, '看一下开篇');
    store.progress(turn.assistant.id, '已读取第一章', []);
    const restarted = new ConversationStore(db);
    const saved = restarted.messages(conversation.id).at(-1);
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.content, '已读取第一章');
    assert.equal(restarted.startTurn(conversation.id, '继续解释').history.length, 1, 'interrupted analysis must not become a completed answer in model context');
  } finally { db.close(); }
});
test('separate user stores cannot discover or read another user conversation', () => {
  const first = fixture(), other = fixture();
  try {
    const conversation = first.store.create({ work_id: 1 });
    first.store.startTurn(conversation.id, '私密小说');
    assert.equal(other.store.list().length, 0);
    assert.throws(() => other.store.get(conversation.id), /不存在/);
    assert.throws(() => first.store.create({ work_id: 999 }), /不存在/);
  } finally { first.db.close(); other.db.close(); }
});
test('deleting a conversation removes only its history and leaves manuscripts intact', () => {
  const { db, store } = fixture();
  try {
    const conversation = store.create({ work_id: 1 });
    const turn = store.startTurn(conversation.id, '演示');
    assert.throws(() => store.remove(conversation.id), /正在|未结束/);
    store.finish(turn.assistant.id, { status: 'cancelled', content: '', error: '用户停止' });
    store.remove(conversation.id);
    assert.equal(store.list().length, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM works').get().n, 2);
  } finally { db.close(); }
});

test('saved tool activity stays compact without duplicating entire documents or model messages', () => {
  const { db, store } = fixture();
  try {
    const turn = store.startTurn(store.create().id, '研究演示稿');
    const events = [
      { type: 'tool/call', data: { name: 'library_read_document', callId: 'read-1', arguments: { document_id: 'document-1' } } },
      { type: 'tool/result', data: { callId: 'read-1', output: { source: 'document:1', text: '原文'.repeat(150000) } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '重复答案'.repeat(150000) }] } } }
    ];
    store.progress(turn.assistant.id, '正在阅读', events);
    const saved = store.finish(turn.assistant.id, { status: 'complete', content: '建议调整卷纲，来源 document:1。', events });
    assert.equal(saved.events.length, 2);
    assert.equal(saved.events[0].data.arguments.document_id, 'document-1');
    assert.equal(saved.events[1].data.callId, 'read-1');
    assert.ok(Buffer.byteLength(JSON.stringify(saved.events)) < 32768, 'history must not load megabytes of duplicate document text');
    assert.doesNotMatch(JSON.stringify(saved.events), /重复答案/);
  } finally { db.close(); }
});
