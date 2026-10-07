import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runResearchAgent } from '../ai/research/dsh.mjs';

test('DSH restores prior conversation as native model messages and publishes safe text before completion', async () => {
  const requests = [], updates = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = text => 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n';
    response.write(frame('进一步解释：主角目标已经明确，但故事引擎无法持续兑现读者期待。这是结构问题。'));
    await new Promise(resolve => setTimeout(resolve, 80));
    response.write(frame('上轮结论仍适用。意外回显 private-'));
    response.end(frame('secret。') + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runResearchAgent({ config: { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'private-secret', model: 'fixture' },
      persona: '小说编辑', prompt: '具体要改哪一层？',
      history: [{ role: 'user', content: '根据榜单研究我的小说' }, { role: 'assistant', content: '建议重写故事引擎，依据第一章与新书榜。' }],
      onText: text => updates.push(text) });
    const messages = requests[0].messages;
    assert.ok(messages.some(message => message.role === 'user' && message.content.includes('根据榜单')));
    assert.ok(messages.some(message => message.role === 'assistant' && message.content.includes('故事引擎')));
    assert.ok(updates.length > 1, 'text must stream before the completed response');
    assert.doesNotMatch(JSON.stringify(updates), /private-secret|private-/);
    assert.match(result.text, /已隐藏密钥/);
  } finally { server.close(); server.closeAllConnections(); }
});

test('real DSH loop calls a scoped tool via a model HTTP stream then produces the cited response', { timeout: 15000 }, async () => {
  const requests = []; let executed = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    assert.equal(request.headers.authorization, 'Bearer fixture-api-key');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = requests.length === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'scope_call', type: 'function', function: { name: 'novel_read', arguments: '{}' } }] }
      : { role: 'assistant', content: '依据当前小说：第1章中主角的目标需要提前。' };
    response.end('data: ' + JSON.stringify({ id: 'fixture', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runResearchAgent({ config: { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'fixture-api-key', model: 'fixture-model', max_tokens: 2048, temperature: 0.35 },
      prompt: '请看我的小说，帮我诊断开篇', persona: '小说研究助手', tools: [{ name: 'novel_read', description: 'Read only the selected work', parameters: {},
        execute: async () => { executed++; return { work_id: 7, chapter: '第1章 主角登场', source: 'novel:7/chapter:1' }; } }] });
    assert.equal(executed, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].thinking, undefined, 'Generic Chat Completions must not receive DeepSeek-only options');
    assert.equal(requests[0].temperature, 0.35);
    assert.equal(requests[1].messages.find(message => message.role === 'tool')?.tool_call_id, 'scope_call');
    assert.match(result.text, /主角的目标/);
    assert.ok(result.events.some(event => event.type === 'tool/result'));
    assert.equal(requests[0].tools.some(tool => /bash|write_file|run_code|delete|cordis/.test(tool.function.name)), false);
  } finally { server.close(); server.closeAllConnections(); }
});

test('model redirects cannot forward the private research prompt to another endpoint', async () => {
  let leaked = 0;
  const destination = http.createServer((request, response) => { leaked++; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: [DONE]\n\n'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const redirect = http.createServer((request, response) => { response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/leak` }); response.end(); });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(runResearchAgent({ config: { base_url: `http://127.0.0.1:${redirect.address().port}`, api_key: 'fixture-key', model: 'fixture-model' }, prompt: '作者尚未公开的小说内容', persona: '小说助手' })); assert.equal(leaked, 0); }
  finally { redirect.close(); redirect.closeAllConnections(); destination.close(); destination.closeAllConnections(); }
});

test('DSH cancellation aborts a pending model stream and disposes the session', { timeout: 10000 }, async () => {
  let started; const ready = new Promise(resolve => started = resolve);
  const server = http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); started(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const running = runResearchAgent({ config: { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'fixture-api-key', model: 'fixture-model' }, prompt: '取消测试', persona: '小说研究助手', signal: controller.signal });
    await ready; controller.abort(); await assert.rejects(running, /abort/i);
  } finally { server.close(); server.closeAllConnections(); }
});

test('model text and durable tool events redact the configured API secret', async () => {
  const server = http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ id: 'fixture', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Unexpected reflected fixture-sensitive-key' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runResearchAgent({ config: { base_url: `http://127.0.0.1:${server.address().port}`, api_key: 'fixture-sensitive-key', model: 'fixture-model' }, prompt: '密钥脱敏测试', persona: '小说研究助手' });
    assert.doesNotMatch(JSON.stringify(result), /fixture-sensitive-key/);
  } finally { server.close(); server.closeAllConnections(); }
});
