// Isolated, zero-billing browser acceptance fixture. Never install this model
// configuration in an author's account or use it for actual manuscript advice.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.NOVELKING_AGENT_REVIEW !== '1' || !process.env.NOVELSTUDIO_DATA_DIR?.includes('novel-agent-demo')) throw Error('Only an explicitly isolated review directory is allowed');
const port = Number(process.env.PORT || 38510), modelPort = 38511;
let work, chapter, document;
const parseTool = content => {
  try { const value = JSON.parse(content); return value.content?.[0]?.text ? JSON.parse(value.content[0].text) : value; }
  catch { return {}; }
};
const model = http.createServer(async (request, response) => {
  let content = ''; for await (const chunk of request) content += chunk;
  const body = JSON.parse(content), messages = body.messages;
  const userIndex = messages.findLastIndex(message => message.role === 'user'), question = messages[userIndex]?.content || '';
  const done = new Set(messages.slice(userIndex + 1).filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []).map(call => call.function.name + ':' + (JSON.parse(call.function.arguments || '{}').id || '')));
  const call = (name, args = {}) => ({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_' + done.size + '_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const rankingResult = messages.find(message => message.role === 'tool' && JSON.stringify(parseTool(message.content)).includes('captured_at'));
  const plan = [
    ['skill_read', { id: 'editorial-review' }], ['skill_read', { id: 'comparable-dissection' }],
    ['novel_catalog', {}], ['qidian_scan_ranking', { board: 'newbooks' }], ['rankings_list_snapshots', {}],
    ['novel_read_outline', {}], ['library_list_documents', {}], ['library_read_document', { document_id: document?.id }],
    ['novel_read_chapter', { chapter_id: chapter?.id }]
  ];
  const next = plan.find(([name, args]) => !done.has(name + ':' + (args.id || '')));
  let delta;
  if (/延迟测试/.test(question)) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '【测试模型】正在等待，用于停止回答验收。' }, finish_reason: null }] }) + '\n\n');
    await delay(5000);
    if (!response.destroyed) response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '等待结束。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    return;
  }
  if (/哪一层|上轮|继续解释/.test(question)) delta = { role: 'assistant', content: '【受控测试模型 · 仅演示】\n\n改的是上轮提到的**故事引擎与卷纲**，不是先润色句子。让主角在开篇主动争夺一项稀缺资格，每卷围绕同一个长期目标提高代价；保留镜子读取记忆的原创设定。这个回答用于验证多轮上下文，不代表正式审稿结论。' };
  else if (next) delta = call(next[0], next[1]);
  else delta = { role: 'assistant', content: `【受控测试模型 · 仅演示】\n\n## 编辑判断\n\n**建议重构故事引擎，再决定是否重写开篇。**这是明确标注的演示稿和测试模型，不能作为当前市场或签约判断。\n\n### 作品成分与定位\n\n演示稿由都市奇幻、记忆能力和资源竞争组成。主角的能力很清楚，读者在第一章仍不知道他要争夺什么。\n\n| 证据 | 能支持的判断 | 不能支持的判断 |\n| --- | --- | --- |\n| 模拟参考书简介 | 比较题材和读者承诺的方法 | 真实起点题材风向 |\n| 本书第一章 | 主角目标传达较晚 | 全书文笔或签约概率 |\n| 上传的总纲 | 阶段目标和长期冲突需要接上 | 未读内容的质量 |\n\n### 先解决这三件事\n\n1. **故事引擎**：让读者明白主角的长期欲望、反复兑现的奖励和约束。\n2. **卷纲**：每卷争夺一个可验证的目标，并提高失败代价。\n3. **开篇**：保留记忆镜子的原创核心，把能力介绍放到主角主动行动中。\n\n若这个结构与作者的目标市场确实错位，可以建议重写；本演示证据不足以声称题材被市场拒绝。\n\n来源：novel:${work.id}/chapter:${chapter.id}；document:${document.id}；[起点新书榜](https://www.qidian.com/rank/signNewBkAll/)。已实际尝试采集公开榜单，${rankingResult ? '工具返回记录可在查阅过程查看；模拟书单始终单独标注。' : '没有取得可用于实时市场结论的榜单正文；模拟书单不能代替它。'}\n\n可以继续问我：“具体要改哪一层？”` };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (delta.content) {
    for (const text of delta.content.match(/.{1,50}/gs)) {
      if (response.destroyed) return;
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n');
      await delay(20);
    }
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } else response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => model.listen(modelPort, '127.0.0.1', resolve));
const child = spawn(process.execPath, ['--max-old-space-size=256', 'server.js'], { env: { ...process.env, NOVELKING_DATABASE_URL: '', NOVELKING_WORKER_PORT: '', NOVELKING_WORKER_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-4000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
const api = async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(`http://127.0.0.1:${port}/api` + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  const value = await response.json(); if (!response.ok) throw Error(route + ': ' + JSON.stringify(value)); return value;
};
for (let attempt = 0; attempt < 100; attempt++) {
  if (child.exitCode !== null) throw Error(logs);
  try { await api('/works'); break; } catch { await delay(100); }
}
work = await api('/works', { title: '【演示稿】镜城的账本', description: '验收用模拟小说，不是作者正式稿件。', initial_chapter: true });
chapter = (await api('/chapters?work_id=' + work.id))[0];
await api('/chapters/' + chapter.id, { content: '<p>镜城的历史开始于一面镜子。这里的每面镜子都能记住过去，七个行会控制着镜子的制造权。</p><p>林昭花了一上午研究镜子的构造。透明的玻璃下埋着古老的文字。他忽然意识到，自己能看见被抹去的账本。</p><p>直到天黑，他才听说母亲欠下一笔债。明天的资格争夺，是他唯一的机会。</p>' }, 'PUT');
const upload = await fetch(`http://127.0.0.1:${port}/api/files/upload?` + new URLSearchParams({ name: '演示总纲.txt', area: 'outline', work_id: String(work.id) }), { method: 'POST', body: '【验收演示资料】主角读取镜子中的旧记忆，先争夺资格，再调查母亲的债务。每卷加重失败代价。尚未确定资源争夺与长期目标如何连接。' });
document = await upload.json(); if (!upload.ok) throw Error(JSON.stringify(document));
const config = await api('/api_configs', { name: '验收专用（受控测试模型）', base_url: `http://127.0.0.1:${modelPort}`, model: 'fixture-editor', api_key: 'fixture-key-no-billing', max_tokens: 4096 });
await api('/research/snapshots', { work_id: work.id, board: 'newbooks', source_url: 'https://www.qidian.com/rank/signNewBkAll/', captured_at: new Date().toISOString(), books: [
  { rank: 1, title: '【模拟样本】经营宗门', genre: '仙侠', synopsis: '验收模拟书目：主角经营资源、培养弟子并争夺名次。' },
  { rank: 2, title: '【模拟样本】记忆侦探', genre: '都市', synopsis: '验收模拟书目：主角用记忆能力解决案件，揭开家族悬疑。' },
  { rank: 3, title: '【模拟样本】资格之城', genre: '奇幻', synopsis: '验收模拟书目：主角争夺资格，每阶段提高失去资格的代价。' }
] });
fs.writeFileSync('/tmp/novel-agent-review-ids.json', JSON.stringify({ work_id: work.id, chapter_id: chapter.id, document_id: document.id, config_id: config.id }));
// The legacy test server deliberately binds loopback. Expose only this isolated
// fixture through a container-local proxy so the review browser can reach it.
const preview = http.createServer((request, response) => {
  const headers = { ...request.headers, host: '127.0.0.1:' + port };
  if (headers.origin === 'http://novelking-agent-review:' + (port + 2)) headers.origin = 'http://127.0.0.1:' + port;
  const upstream = http.request({ hostname: '127.0.0.1', port, path: request.url, method: request.method, headers }, received => {
    response.writeHead(received.statusCode, received.headers); received.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  request.pipe(upstream);
  response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
});
await new Promise(resolve => preview.listen(port + 2, '0.0.0.0', resolve));
console.log('AGENT_DEMO_READY ' + JSON.stringify({ port: port + 2, work_id: work.id, model: '受控测试模型，仅演示，不计费' }));
const stop = () => { child.kill(); preview.close(); preview.closeAllConnections(); model.close(); model.closeAllConnections(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop); child.on('exit', () => { model.close(); model.closeAllConnections(); });
