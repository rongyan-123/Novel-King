import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createChatHandler } from '../ai/research/chat-http.mjs';
import { runResearchAgent } from '../ai/research/dsh.mjs';

test('chat Agent chooses editorial skill, board and manuscript tools, then continues the same persisted conversation', { timeout: 20000 }, async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO works VALUES(1,'明确标注的演示稿');
    CREATE TABLE research_connectors(id TEXT PRIMARY KEY,api_key TEXT,enabled INTEGER);
    CREATE TABLE api_configs(id INTEGER PRIMARY KEY,base_url TEXT,api_key TEXT,model TEXT,max_tokens INTEGER);
    INSERT INTO api_configs VALUES(1,'placeholder','test-key','fixture',2048);`);
  const executed = [], modelRequests = [], snapshots = [];
  const model = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const received = JSON.parse(body); modelRequests.push(received);
    const number = modelRequests.length;
    const call = (name, args = {}) => ({ role: 'assistant', tool_calls: [{ index: 0, id: 'call' + number, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const delta = number === 1 ? call('skill_read', { id: 'editorial-review' }) : number === 2 ? call('qidian_scan_ranking', { board: 'newbooks' })
      : number === 3 ? call('novel_read_chapter', { chapter_id: 1 })
      : { role: 'assistant', content: number === 4 ? '【测试模型演示】建议重写故事引擎。证据：签约新书榜，2026-10-07，https://www.qidian.com/rank/newbooks/；正文 novel:1/chapter:1。' : '延续上轮：需要改的是故事引擎，不是润色句子。' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: number < 4 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  db.prepare('UPDATE api_configs SET base_url=?').run(`http://127.0.0.1:${model.address().port}`);
  const workspace = { work: id => id ? Number(id) : null, saveSnapshot: snapshot => { snapshots.push(snapshot); return { ...snapshot, id: 'saved-ranking' }; },
    connectTools: async workId => ({ close: async () => {}, client: {
      listTools: async () => ({ tools: [{ name: 'qidian_scan_ranking', description: '排名采集', inputSchema: { type: 'object', properties: { board: { type: 'string' } } } },
        { name: 'novel_read_chapter', description: '只读章节', inputSchema: { type: 'object', properties: { chapter_id: { type: 'integer' } } } }] }),
      callTool: async ({ name, arguments: args }) => { executed.push({ name, args, workId }); return { content: [{ type: 'text', text: JSON.stringify(name === 'qidian_scan_ranking'
        ? { board: args.board, source_url: 'https://www.qidian.com/rank/newbooks/', captured_at: '2026-10-07T08:00:00Z', method: 'test_fixture', books: [{ title: '对照样本（非真实榜单）', rank: 1, genre: '仙侠', synopsis: '成长升级、经营宗门' }] }
        : { source: 'novel:1/chapter:1', text: '演示稿：主角用整章介绍世界，却没有行动目标。' }) }] }; }
    } }) };
  const readBody = async request => { let body = ''; for await (const chunk of request) body += chunk; return body ? JSON.parse(body) : {}; };
  const sendJSON = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  const handler = createChatHandler({ database: db, workspace, readBody, sendJSON, active: new Map(), requireAIEndpoint: () => {}, origins: '', agentRunner: runResearchAgent });
  const server = http.createServer(async (request, response) => {
    try { await handler(request, response, new URL(request.url, 'http://localhost')); }
    catch (error) { sendJSON(response, error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/research/conversations`;
  const api = async (suffix, body) => fetch(base + suffix, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const conversation = await (await api('', { work_id: 1 })).json();
    const response = await api('/' + conversation.id + '/messages', { prompt: '根据起点榜单研究我的小说', config_id: 1 });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /complete/); assert.match(stream, /测试模型演示/);
    assert.doesNotMatch(stream, /test-key/);
    assert.deepEqual(executed.map(item => item.name), ['qidian_scan_ranking', 'novel_read_chapter']);
    assert.ok(executed.every(item => item.workId === 1));
    assert.equal(snapshots.length, 1, 'Agent board capture is durable evidence, not discarded tool output');
    assert.match(modelRequests[1].messages.find(message => message.role === 'tool').content, /题材|编辑/);
    assert.equal((await api('/' + conversation.id + '/messages')).status, 200);
    const next = await api('/' + conversation.id + '/messages', { prompt: '具体要改哪一层？', config_id: 1 });
    assert.match(await next.text(), /延续上轮/);
    assert.ok(modelRequests.at(-1).messages.some(message => message.role === 'assistant' && message.content.includes('重写故事引擎')));
    const saved = await (await api('/' + conversation.id + '/messages')).json();
    assert.equal(saved.messages.length, 4);
    const activity = saved.messages[1].events;
    const calls = activity.filter(event => event.type === 'tool/call');
    assert.equal(calls.find(event => event.data.name === 'skill_read').data.arguments.id, 'editorial-review');
    assert.ok(calls.every(call => activity.some(event => event.type === 'tool/result' && event.data.callId === call.data.callId)), 'real DSH results must complete the matching activity indicator');
    assert.equal((await api('/not-my-conversation/messages')).status, 404);
  } finally { server.close(); server.closeAllConnections(); model.close(); model.closeAllConnections(); db.close(); }
});
