import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('AI center reads a selected novel through DSH + MCP and persists the research and model configuration', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-research-http-'));
  let requests = 0;
  const model = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const received = JSON.parse(body); requests++;
    const delta = requests === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read_chapter', type: 'function', function: { name: 'novel_read_chapter', arguments: '{"chapter_id":1}' } }] }
      : { role: 'assistant', content: '在小说第一章，主角想通过考核；建议把阻碍提前。来源 novel:1/chapter:1。' };
    if (requests === 2) assert.match(received.messages.find(message => message.role === 'tool')?.content || '', /考核/);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'fixture', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', NOVELKING_WORKER_PORT: '0', NOVELKING_WORKER_TOKEN: 'fixture',
    NOVELSTUDIO_DATA_DIR: directory, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_ALLOW_LEGACY_AGENT_HEADER: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  try {
    let port;
    for (let attempt = 0; attempt < 100; attempt++) { port = output.match(/NOVELKING_WORKER_READY:(\d+)/)?.[1]; if (port) break; if (child.exitCode !== null) throw Error(output); await delay(100); }
    assert.ok(port, output);
    const api = async (route, body, agent = false) => {
      const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method: body ? 'POST' : 'GET', headers: {
        'x-novelking-worker': 'fixture', 'content-type': 'application/json', ...(agent ? { 'X-Novel-Agent': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    const work = await api('/works', { title: '待投稿小说', initial_chapter: true });
    const chapterResponse = await fetch(`http://127.0.0.1:${port}/api/chapters/1`, { method: 'PUT', headers: { 'x-novelking-worker': 'fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '<p>主角想通过考核。</p>' }) });
    assert.equal(chapterResponse.status, 200);
    const config = await api('/api_configs', { name: '测试模型', base_url: `http://127.0.0.1:${model.address().port}`, api_key: 'fixture-never-reveal-secret', model: 'fixture-model', max_tokens: 2048 });
    const status = await api('/research/status?work_id=' + work.body.id);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.ok(status.body.skills.some(skill => skill.id === 'opening-review'));
    assert.equal((await api('/research/runs', { work_id: 999, config_id: config.body.id, prompt: '分析开篇', skill: 'opening-review' })).status, 404);
    assert.equal((await api('/research/runs', { work_id: work.body.id, config_id: config.body.id, prompt: '分析开篇', skill: 'opening-review' }, true)).status, 403);
    const run = await api('/research/runs', { work_id: work.body.id, config_id: config.body.id, prompt: '分析开篇', skill: 'opening-review' });
    assert.equal(run.status, 201, JSON.stringify(run.body)); assert.equal(requests, 2);
    assert.equal(run.body.status, 'complete'); assert.match(run.body.text, /考核/);
    assert.doesNotMatch(JSON.stringify(run.body), /fixture-never-reveal-secret/);
    const history = await api('/research/runs?work_id=' + work.body.id);
    assert.equal(history.body.runs[0].id, run.body.id);
    const imported = await api('/research/snapshots', { work_id: work.body.id, board: 'sanjiang', source_url: 'https://www.qidian.com/sanjiang/', books: [{ title: '作者选取的参考书', rank: 1, genre: '仙侠' }] });
    assert.equal(imported.status, 201);
    assert.equal((await api('/research/status?work_id=' + work.body.id)).body.snapshots.length, 1);
    assert.doesNotMatch(JSON.stringify((await api('/api_configs')).body), /fixture-never-reveal-secret/);
    const concurrentBody = JSON.stringify({ work_id: work.body.id, config_id: config.body.id, prompt: '同时提交的研究', skill: 'opening-review' });
    const submissions = [];
    const responses = [0, 1].map(() => new Promise((resolve, reject) => {
      const submission = http.request(`http://127.0.0.1:${port}/api/research/runs`, { method: 'POST', headers: { 'x-novelking-worker': 'fixture', 'content-type': 'application/json' } }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode));
      });
      submission.once('error', reject); submission.write(concurrentBody.slice(0, 1)); submissions.push(submission);
    }));
    await delay(100); // Both handlers have begun reading their still-incomplete body.
    submissions.forEach(submission => submission.end(concurrentBody.slice(1)));
    assert.deepEqual((await Promise.all(responses)).sort(), [201, 409], 'a user can start only one paid research task at a time');
    assert.equal(requests, 3);
  } finally { child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); model.close(); model.closeAllConnections(); }
});
