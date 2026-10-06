import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as shortcuts from '../canvas/shortcuts.mjs';

test('双槽冲突指出占用功能，明确替换后两处一致，清除可以释放默认键', () => {
  const original = shortcuts.normalizeShortcuts();
  const collision = shortcuts.changeBinding(original, 'freedraw', 1, 'T');
  assert.deepEqual(collision.conflict, { action: 'text', slot: 0 });
  assert.deepEqual(collision.shortcuts, original);
  const replaced = shortcuts.changeBinding(original, 'freedraw', 1, 'T', { replace: true });
  assert.deepEqual(replaced.shortcuts.freedraw, ['P', 'T']);
  assert.deepEqual(replaced.shortcuts.text, ['', '8']);
  assert.deepEqual(original.text, ['T', '8']);
  const cleared = shortcuts.changeBinding(original, 'text', 0, '').shortcuts;
  assert.equal(shortcuts.changeBinding(cleared, 'freedraw', 1, 'T').conflict, null);
});

test('双槽迁移保留旧绑定，明确清空后不会恢复默认键', () => {
  const migrated = shortcuts.normalizeShortcuts({ freedraw: 'q' });
  assert.deepEqual(migrated.freedraw, ['Q', '7']);
  const cleared = shortcuts.normalizeShortcuts({ ...migrated, freedraw: ['', 'F6'] });
  assert.deepEqual(cleared.freedraw, ['', 'F6']);
  assert.equal(shortcuts.actionForBinding(cleared, 'Q'), null);
  assert.equal(shortcuts.actionForBinding(cleared, 'F6'), 'freedraw');
});

test('上滚是 Mouse+、下滚是 Mouse-，水平滚动和零滚动不会混入上下方向', () => {
  assert.equal(shortcuts.bindingFromWheel({ deltaY: -120, deltaX: 0, deltaMode: 0 }), 'Mouse+');
  assert.equal(shortcuts.bindingFromWheel({ deltaY: 3, deltaX: 0, deltaMode: 1 }), 'Mouse-');
  assert.equal(shortcuts.bindingFromWheel({ deltaY: -1, deltaX: 0, deltaMode: 2, ctrlKey: true }), 'Ctrl+Mouse+');
  assert.equal(shortcuts.bindingFromWheel({ deltaY: 1, deltaX: -80 }), 'MouseLeft');
  assert.equal(shortcuts.bindingFromWheel({ deltaY: 0, deltaX: 80 }), 'MouseRight');
  assert.equal(shortcuts.bindingFromWheel({ deltaY: 0, deltaX: 0 }), '');
});

test('组合键、数字与小键盘按真实事件录入，修饰键和输入法不误绑', () => {
  assert.equal(shortcuts.bindingFromKey({ key: 'q', code: 'KeyQ', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+Q');
  assert.equal(shortcuts.bindingFromKey({ key: '!', code: 'Digit1', shiftKey: true }), 'Shift+1');
  assert.equal(shortcuts.bindingFromKey({ key: '1', code: 'Numpad1' }), 'Numpad1');
  assert.equal(shortcuts.bindingFromKey({ key: 'F6', code: 'F6' }), 'F6');
  assert.equal(shortcuts.bindingFromKey({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), '');
  assert.equal(shortcuts.bindingFromKey({ key: 'a', code: 'KeyA', isComposing: true }), '');
  assert.equal(shortcuts.bindingFromKey({ key: 'Dead', code: 'Quote' }), '');
  assert.equal(shortcuts.bindingFromKey({ key: 'Escape', code: 'Escape' }), '');
});
