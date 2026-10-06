import assert from 'node:assert/strict';
import { test, before } from 'node:test';
let appearance;
before(async () => { await import('../public/appearance.js'); appearance = globalThis.NovelKingAppearance; });
const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
test('全局外观规范化并拒绝任意 CSS，四款风格独立于深浅模式', () => {
  assert.deepEqual(appearance.normalize({ mode: 'bad', style: 'bad', accent: 'url(evil)' }), { mode: 'system', style: 'minimal', accent: '' });
  for (const style of ['minimal', 'cool', 'premium', 'cartoon']) {
    assert.equal(appearance.normalize({ mode: 'dark', style, accent: '#456789' }).style, style);
  }
});
test('全局外观持久化，旧主题可迁移，损坏设置可恢复', () => {
  const memory = storage(); memory.setItem('ns_theme', 'dark');
  assert.equal(appearance.read(memory).mode, 'dark');
  appearance.save(memory, { mode: 'system', style: 'cartoon', accent: '#4973cb' });
  assert.deepEqual(appearance.read(memory), { mode: 'system', style: 'cartoon', accent: '#4973cb' });
  assert.equal(appearance.resolveMode(appearance.read(memory), true), 'dark');
  assert.equal(appearance.resolveMode({ mode: 'light' }, true), 'light');
  memory.setItem('novel_king_appearance', '{broken');
  assert.equal(appearance.read(memory).style, 'minimal');
});

test('损坏的模式与非字符串颜色可安全恢复', () => {
  assert.equal(appearance.resolveMode({ mode: 'bad' }, true), 'dark');
  assert.equal(appearance.normalize({ accent: { toString: () => '#123456' } }).accent, '');
});
