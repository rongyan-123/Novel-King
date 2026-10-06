import assert from 'node:assert/strict';
import { test } from 'node:test';

test('画布保存串行执行，保存途中继续编辑时发送最新场景及新版本', async () => {
  const { createCanvasSession } = await import('../canvas/session.mjs');
  let resolveFirst;
  const calls = [];
  const session = createCanvasSession({ initial: { revision: 2, scene: { elements: [] } }, delay: 60000, save: async (body) => {
    calls.push(body);
    if (calls.length === 1) await new Promise((resolve) => { resolveFirst = resolve; });
    return { revision: body.revision + 1, scene: body.scene };
  } });
  session.update({ elements: [{ id: 'A' }] });
  const flush = session.flush();
  session.update({ elements: [{ id: 'B' }] });
  resolveFirst();
  await flush;
  assert.deepEqual(calls.map((call) => [call.revision, call.scene.elements[0].id]), [[2, 'A'], [3, 'B']]);
  await session.flush();
  assert.equal(calls.length, 2);
  session.dispose();
});

test('保存失败保留本机修改，重试沿原版本保存，不把失败当作已保存', async () => {
  const { createCanvasSession } = await import('../canvas/session.mjs');
  let fails = true;
  const calls = [];
  const session = createCanvasSession({ initial: { revision: 4, scene: { elements: [] } }, delay: 60000, save: async (body) => {
    calls.push(body);
    if (fails) throw new Error('network');
    return { revision: 5 };
  } });
  session.update({ elements: [{ id: 'kept' }] });
  await assert.rejects(session.flush(), /network/);
  fails = false;
  await session.flush();
  assert.deepEqual(calls.map((call) => [call.revision, call.scene.elements[0].id]), [[4, 'kept'], [4, 'kept']]);
  session.dispose();
});

test('AI 剧情图拒绝悬空连线与重复编号，转换后的箭头绑定到剧情卡', async () => {
  const { parsePlotProposal, proposalSkeleton } = await import('../canvas/plot.mjs');
  assert.equal(parsePlotProposal('{"nodes":[{"id":"a","text":"开端"}],"edges":[{"from":"a","to":"bad"}]}'), null);
  assert.equal(parsePlotProposal('{"nodes":[{"id":"a","text":"开端"},{"id":"a","text":"重复"}],"edges":[]}'), null);
  const proposal = parsePlotProposal('```json\n{"advice":"先后衔接","nodes":[{"id":"a","text":"发现秘密"},{"id":"b","text":"身份反转"}],"edges":[{"from":"a","to":"b","label":"导致"}]}\n```');
  const skeleton = proposalSkeleton(proposal, { x: 100, y: 200 }, 'test');
  assert.equal(skeleton[0].label.text, '发现秘密');
  assert.equal(skeleton[1].label.text, '身份反转');
  assert.equal(skeleton[2].start.id, skeleton[0].id);
  assert.equal(skeleton[2].end.id, skeleton[1].id);
});

test('工具快捷键可自定义，重复或无效配置不会覆盖已使用的按键', async () => {
  const { normalizeShortcuts } = await import('../canvas/shortcuts.mjs');
  const configured = normalizeShortcuts({ freedraw: 'q', text: 'Q', rectangle: 'ctrl+k', arrow: 'l' });
  assert.deepEqual(configured.freedraw, ['Q', '7']);
  assert.deepEqual(configured.text, ['', '8']);
  assert.deepEqual(configured.rectangle, ['Ctrl+K', '2']);
  assert.deepEqual(configured.arrow, ['L', '5']);
  const bindings = Object.values(configured).flat().filter(Boolean);
  assert.equal(new Set(bindings).size, bindings.length);
});
