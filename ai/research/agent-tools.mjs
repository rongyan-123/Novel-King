import { connectRemoteTools } from './mcp.mjs';
import { RESEARCH_SKILLS, getResearchSkill } from './skills.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export async function connectAgentTools({ workspace, database, workId, origins, signal, notify = () => {}, rankingIntervalMs = 10000 }) {
  const connected = [], connectors = database.prepare('SELECT * FROM research_connectors WHERE enabled=1').all();
  const secrets = connectors.map(connector => connector.api_key).filter(Boolean);
  const redact = text => secrets.reduce((safe, secret) => safe.replaceAll(secret, '[已隐藏密钥]'), String(text));
  try {
    const internal = await workspace.connectTools(workId); connected.push(internal);
    const discovered = await internal.client.listTools();
    // Ranking capture is serialized within a turn; the browser service already
    // enforces a global single-capture limit across users.
    let rankingQueue = Promise.resolve(), lastRankingStart = 0;
    const tools = discovered.tools.map(tool => ({ name: tool.name, description: tool.description, jsonSchema: tool.inputSchema,
      execute: async (arguments_, execution) => {
        const call = async () => {
          const result = await internal.client.callTool({ name: tool.name, arguments: arguments_ }, undefined, { signal: execution.signal, timeout: tool.name === 'qidian_scan_ranking' ? 90000 : 25000 });
          if (result.isError) throw Error(result.content.find(block => block.type === 'text')?.text || '未取得工具资料');
          if (tool.name === 'qidian_scan_ranking' && !result.isError) {
            const captured = JSON.parse(result.content.find(block => block.type === 'text').text);
            return workspace.saveSnapshot(captured, workId);
          }
          return result;
        };
        if (tool.name !== 'qidian_scan_ranking') return call();
        const next = rankingQueue.then(async () => {
          const wait = rankingIntervalMs - (Date.now() - lastRankingStart);
          if (wait > 0) await delay(wait, undefined, { signal: execution.signal });
          execution.signal?.throwIfAborted(); lastRankingStart = Date.now(); return call();
        });
        rankingQueue = next.catch(() => {}); return next;
      } }));
    tools.push({ name: 'skill_list', description: '列出可用的小说编辑、榜单研究、对照拆解、开篇与一致性分析技能。', parameters: {},
      execute: async () => RESEARCH_SKILLS.map(({ text, ...metadata }) => metadata) });
    tools.push({ name: 'skill_read', description: '按 ID 读取研究技能。审稿、投稿和市场对比先读取 editorial-review；对照书目再读取 comparable-dissection。',
      parameters: { id: { type: 'string', required: true } }, execute: async arguments_ => getResearchSkill(arguments_.id) });
    for (const configured of connectors) {
      try {
        const remote = await connectRemoteTools({ ...configured, allowed_tools: JSON.parse(configured.allowed_tools) }, origins, signal); connected.push(remote);
        for (const tool of remote.discovered.filter(tool => tool.allowed)) tools.push({
          name: 'mcp_' + configured.id.replaceAll('-', '').slice(0, 8) + '_' + tool.name.slice(0, 40),
          description: configured.name + ': ' + tool.description.slice(0, 2000), jsonSchema: tool.inputSchema,
          execute: (arguments_, execution) => remote.client.callTool({ name: tool.name, arguments: arguments_ }, undefined, { signal: execution.signal, timeout: 20000 }) });
      } catch (error) {
        if (signal?.aborted) throw error;
        notify({ type: 'notice', text: redact(configured.name + '暂时不可用：' + error.message + '。本次仍可使用内置作品和榜单工具。') });
      }
    }
    return { tools, secrets, close: async () => { for (const connection of connected.reverse()) await connection.close().catch(() => {}); } };
  } catch (error) { for (const connection of connected.reverse()) await connection.close().catch(() => {}); throw error; }
}
