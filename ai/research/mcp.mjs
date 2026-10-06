import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function connectInternalTools(definitions) {
  const server = new Server({ name: 'novelking-research', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(tool => ({ name: tool.name,
    description: tool.description, inputSchema: { type: 'object', properties: tool.properties || {}, required: tool.required || [], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: Boolean(tool.external) } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = definitions.find(definition => definition.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: '未知或不允许的研究工具' }] };
    try { return { content: [{ type: 'text', text: JSON.stringify(await tool.execute(request.params.arguments || {}, { signal: extra.signal })) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'novelking-dsh', version: '1.0.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, definitions, close: async () => { await client.close(); await server.close(); } };
}

export function validateMcpEndpoint(endpoint, origins) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
    || !new Set(String(origins || '').split(',').map(value => value.trim())).has(url.origin)) {
    throw Object.assign(new Error('MCP 地址须使用管理员允许的 HTTPS 服务；密钥请填在独立密钥字段'), { status: 400 });
  }
  return url;
}
export async function connectRemoteTools(connector, origins, signal) {
  const url = validateMcpEndpoint(connector.endpoint, origins);
  const client = new Client({ name: 'novelking-research', version: '1.0.0' });
  const headers = connector.api_key ? { Authorization: 'Bearer ' + connector.api_key } : {};
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers, redirect: 'error' },
    fetch: (endpoint, options = {}) => {
      if (new URL(endpoint).origin !== url.origin) throw Error('MCP 禁止重定向到其他服务');
      return fetch(endpoint, { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : []), ...(options.signal ? [options.signal] : [])]) });
    } });
  try {
    await client.connect(transport);
    const found = await client.listTools({}, { timeout: 20000, signal });
    const allowed = new Set(connector.allowed_tools || []);
    const discovered = found.tools.map(tool => ({ name: tool.name, description: tool.description || '', read_only: tool.annotations?.readOnlyHint === true,
      allowed: allowed.has(tool.name) && tool.annotations?.readOnlyHint === true, inputSchema: tool.inputSchema }));
    return { client, discovered, close: () => client.close() };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}
