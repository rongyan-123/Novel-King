import { randomUUID } from 'node:crypto';
import { Context, LlmRuntime, DeepSeekAdapter, SessionStore, SystemPrompt, ToolRuntime, defineTool,
  AgentRegistry, AgentLoop, createUserMessage, SessionId, resolveRetryPolicy } from '../../vendor/dsh-research/runtime.mjs';

export async function runResearchAgent({ config, prompt, persona, tools = [], signal, onEvent = () => {}, maxSteps = 12, timeoutMs = 300000, secrets = [] }) {
  if (!config?.api_key) throw Object.assign(new Error('请先在模型配置中保存 API 密钥'), { status: 400 });
  const ctx = new Context(); const events = [];
  const deepseekEndpoint = new URL(config.base_url).hostname === 'api.deepseek.com';
  class ResearchAdapter extends DeepSeekAdapter {
    async resolveModel(...arguments_) {
      const metadata = await super.resolveModel(...arguments_);
      if (deepseekEndpoint) return metadata;
      const { reasoning, ...compatible } = metadata;
      return compatible;
    }
  }
  const privateKeys = [...new Set([config.api_key, ...secrets].filter(Boolean))];
  const redact = value => privateKeys.reduce((text, secret) => text.replaceAll(secret, '[已隐藏密钥]'), value);
  let handle, steps = 0, budgetExceeded = false, eventBytes = 0;
  const deadline = AbortSignal.timeout(timeoutMs);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore);
    await ctx.plugin(SystemPrompt, { persona, includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 2 });
    const provider = 'novel-research';
    ctx.llm.registerAdapter([provider], new ResearchAdapter({ options: () => ({ baseURL: config.base_url.replace(/\/$/, ''),
      apiKeyEnv: 'NOVELKING_PRIVATE_KEY', defaults: deepseekEndpoint ? { thinking: 'disabled', reasoningEffort: 'off' } : {},
      maxTokens: Math.max(256, Math.min(16384, Number(config.max_tokens) || 4096)), defaultContextWindow: 128000,
      models: [{ id: config.model, contextWindow: 128000 }], streamIdleTimeoutMs: 60000,
      retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'novel-research') }), resolveApiKey: async () => config.api_key, resolveUserId: () => 'novelking' }));
    for (const tool of tools) ctx.tools.register(tool.jsonSchema ? { name: tool.name, description: tool.description, parameters: tool.jsonSchema,
      output: { schema: {}, render: (_arguments, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (arguments_, execution) => tool.execute(arguments_, { signal: execution.signal }) } : defineTool({ name: tool.name, description: tool.description,
      parameters: tool.parameters, output: { schema: { type: 'json' }, render: (_arguments, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(arguments_, execution) { return tool.execute(arguments_, { signal: execution.signal }); } }));
    ctx.on('session/event', (_session, event) => {
      // Request headers contain model and tool schemas; never include credential
      // configuration. Bound durable transcripts independently of model context.
      if (!['assistant/message', 'user/message', 'tool/call', 'tool/result', 'turn/end', 'step/start'].includes(event.type)) return;
      const serialized = redact(JSON.stringify(event)); const bytes = Buffer.byteLength(serialized); eventBytes += bytes;
      if (eventBytes > 4 * 1024 * 1024) { budgetExceeded = true; handle?.agent.cancel({ kind: 'hook', reason: '研究记录超过限制' }); return; }
      const safeEvent = JSON.parse(serialized); events.push(safeEvent); onEvent(safeEvent);
      if (event.type === 'step/start' && ++steps > maxSteps) { budgetExceeded = true; handle?.agent.cancel({ kind: 'hook', reason: '研究步数达到上限' }); }
    });
    handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider, model: config.model, maxTokens: Math.max(256, Math.min(16384, Number(config.max_tokens) || 4096)) } });
    if (Number.isFinite(Number(config.temperature))) handle.agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: Math.max(0, Math.min(2, Number(config.temperature))) }));
    const cancel = () => handle.agent.cancel({ kind: 'user' });
    cancellation.addEventListener('abort', cancel, { once: true });
    try {
      cancellation.throwIfAborted();
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
      await handle.agent.whenIdle(); cancellation.throwIfAborted();
      if (budgetExceeded) throw Error('本次研究达到步数或记录上限，请缩小问题范围后继续');
      const ending = events.findLast(event => event.type === 'turn/end');
      if (ending?.data?.reason?.kind === 'error') throw Error(ending.data.reason.error?.message || '模型请求失败');
      const last = events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text'));
      const text = last?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || '';
      if (!text) throw Error('模型未返回研究结果，请检查模型和工具配置');
      return { text, events, steps, engine: 'dsh', version: '0.1.0-rc.5' };
    } finally { cancellation.removeEventListener('abort', cancel); }
  } finally { await handle?.dispose(); await ctx.fiber.dispose(); }
}
