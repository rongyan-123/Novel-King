import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectAgentTools } from '../ai/research/agent-tools.mjs';

test('Agent serializes consecutive board scans and observes the collector interval', async () => {
  const started = [], saved = [];
  const workspace = { saveSnapshot: snapshot => { saved.push(snapshot); return snapshot; }, connectTools: async () => ({ close: async () => {}, client: {
    listTools: async () => ({ tools: [{ name: 'qidian_scan_ranking', inputSchema: { type: 'object' } }] }),
    callTool: async ({ arguments: args }) => { started.push(performance.now()); return { content: [{ type: 'text', text: JSON.stringify({ board: args.board }) }] }; }
  } }) };
  const connected = await connectAgentTools({ workspace, database: { prepare: () => ({ all: () => [] }) }, rankingIntervalMs: 30 });
  try {
    const scan = connected.tools.find(tool => tool.name === 'qidian_scan_ranking');
    await Promise.all([scan.execute({ board: 'newbooks' }, {}), scan.execute({ board: 'sanjiang' }, {})]);
    assert.ok(started[1] - started[0] >= 25, 'immediate second capture would be rejected by the shared browser');
    assert.deepEqual(saved.map(snapshot => snapshot.board), ['newbooks', 'sanjiang']);
  } finally { await connected.close(); }
});

test('an unavailable external MCP reports a redacted notice and retains internal manuscript tools', async () => {
  const notices = [], workspace = { connectTools: async () => ({ close: async () => {}, client: { listTools: async () => ({ tools: [{ name: 'novel_catalog', inputSchema: { type: 'object' } }] }) } }) };
  const connector = { id: 'external', enabled: 1, name: '故障搜索', endpoint: 'http://invalid.example/', allowed_tools: '[]', api_key: 'fixture-private-mcp-key' };
  const connected = await connectAgentTools({ workspace, database: { prepare: () => ({ all: () => [connector] }) }, origins: 'https://allowed.example', notify: event => notices.push(event) });
  try {
    assert.ok(connected.tools.some(tool => tool.name === 'novel_catalog'));
    assert.match(notices[0].text, /暂时不可用/);
    assert.doesNotMatch(JSON.stringify(notices), /fixture-private-mcp-key/);
  } finally { await connected.close(); }
});

test('a denied tool read is an Agent tool failure rather than a successful document lookup', async () => {
  const workspace = { connectTools: async () => ({ close: async () => {}, client: {
    listTools: async () => ({ tools: [{ name: 'library_read_document', inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: '当前范围没有此资料' }] })
  } }) };
  const connected = await connectAgentTools({ workspace, database: { prepare: () => ({ all: () => [] }) } });
  try { await assert.rejects(connected.tools[0].execute({ document_id: 'another-book' }, {}), /当前范围/); }
  finally { await connected.close(); }
});
