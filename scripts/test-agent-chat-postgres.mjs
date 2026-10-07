import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../storage/postgres.mjs';
import { ConversationStore } from '../ai/research/conversations.mjs';

test('PostgreSQL conversation tables support atomic turns, restart recovery and independent user schemas', { skip: !process.env.NOVELKING_TEST_DATABASE_URL, timeout: 30000 }, () => {
  const schema = 'nk_test_chat_' + randomUUID().replaceAll('-', ''), otherSchema = 'nk_test_chat_' + randomUUID().replaceAll('-', '');
  const first = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema), other = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, otherSchema);
  try {
    for (const db of [first, other]) db.exec("CREATE TABLE works(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO works(title) VALUES('PG演示稿');");
    const store = new ConversationStore(first), isolated = new ConversationStore(other);
    const conversation = store.create({ work_id: 1 });
    const turn = store.startTurn(conversation.id, 'PG下的编辑研究');
    store.progress(turn.assistant.id, '来自第一章的初步证据', []);
    const reopened = new ConversationStore(first);
    assert.equal(reopened.messages(conversation.id)[1].status, 'interrupted');
    assert.equal(reopened.messages(conversation.id)[1].content, '来自第一章的初步证据');
    assert.throws(() => isolated.get(conversation.id), /不存在/);
    const followup = reopened.startTurn(conversation.id, '继续讨论结构');
    reopened.finish(followup.assistant.id, { status: 'complete', content: '建议重构卷纲' });
    assert.match(reopened.messages(conversation.id).at(-1).content, /重构卷纲/);
    reopened.remove(conversation.id);
    assert.equal(first.prepare('SELECT count(*) AS n FROM agent_messages').get().n, 0);
    assert.equal(first.prepare('SELECT count(*) AS n FROM works').get().n, 1);
  } finally {
    first.exec(`DROP SCHEMA "${schema}" CASCADE`); other.exec(`DROP SCHEMA "${otherSchema}" CASCADE`); first.close(); other.close();
  }
});
