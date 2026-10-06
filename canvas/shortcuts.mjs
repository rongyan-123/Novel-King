export const shortcutActions = Object.freeze([
  { id: 'selection', name: '选择', group: '绘图工具', keys: ['V', '1'], tool: 'selection' },
  { id: 'hand', name: '抓手 / 平移', group: '绘图工具', keys: ['H', ''], tool: 'hand' },
  { id: 'rectangle', name: '矩形', group: '绘图工具', keys: ['R', '2'], tool: 'rectangle' },
  { id: 'diamond', name: '菱形', group: '绘图工具', keys: ['D', '3'], tool: 'diamond' },
  { id: 'ellipse', name: '椭圆', group: '绘图工具', keys: ['O', '4'], tool: 'ellipse' },
  { id: 'arrow', name: '箭头', group: '绘图工具', keys: ['A', '5'], tool: 'arrow' },
  { id: 'line', name: '线条', group: '绘图工具', keys: ['L', '6'], tool: 'line' },
  { id: 'freedraw', name: '铅笔', group: '绘图工具', keys: ['P', '7'], tool: 'freedraw' },
  { id: 'text', name: '文字', group: '绘图工具', keys: ['T', '8'], tool: 'text' },
  { id: 'image', name: '插入图片', group: '绘图工具', keys: ['9', ''], tool: 'image' },
  { id: 'eraser', name: '橡皮', group: '绘图工具', keys: ['E', '0'], tool: 'eraser' },
  { id: 'frame', name: '画框', group: '绘图工具', keys: ['F', ''], tool: 'frame' },
  { id: 'laser', name: '激光笔', group: '绘图工具', keys: ['K', ''], tool: 'laser' },
  { id: 'addCard', name: '新建剧情卡', group: '编辑与保存', keys: ['Ctrl+Enter', 'Meta+Enter'] },
  { id: 'undo', name: '撤销', group: '编辑与保存', keys: ['Ctrl+Z', 'Meta+Z'] },
  { id: 'redo', name: '重做', group: '编辑与保存', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'] },
  { id: 'delete', name: '删除选中图形', group: '编辑与保存', keys: ['Delete', 'Backspace'] },
  { id: 'save', name: '保存画布', group: '编辑与保存', keys: ['Ctrl+S', 'Meta+S'] },
  { id: 'fit', name: '查看全图', group: '视图与导航', keys: ['Shift+1', ''] },
  { id: 'zoomIn', name: '放大', group: '视图与导航', keys: ['Ctrl+Mouse+', '='] },
  { id: 'zoomOut', name: '缩小', group: '视图与导航', keys: ['Ctrl+Mouse-', '-'] },
  { id: 'panUp', name: '向上平移', group: '视图与导航', keys: ['Mouse+', ''] },
  { id: 'panDown', name: '向下平移', group: '视图与导航', keys: ['Mouse-', ''] },
  { id: 'panLeft', name: '向左平移', group: '视图与导航', keys: ['MouseLeft', 'Shift+Mouse+'] },
  { id: 'panRight', name: '向右平移', group: '视图与导航', keys: ['MouseRight', 'Shift+Mouse-'] },
  { id: 'shortcuts', name: '打开快捷键设置', group: '视图与导航', keys: ['F1', 'Shift+/'] },
]);
export const defaultShortcuts = Object.freeze(Object.fromEntries(shortcutActions.map((action) => [action.id, Object.freeze([...action.keys])])));
const modifierNames = ['Ctrl', 'Meta', 'Alt', 'Shift'];
const namedKeys = ['Space', 'Tab', 'Enter', 'Delete', 'Backspace', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'CapsLock', 'ScrollLock', 'Pause', 'PrintScreen', 'Mouse+', 'Mouse-', 'MouseLeft', 'MouseRight'];

export function normalizeBinding(candidate) {
  if (typeof candidate !== 'string') return '';
  let key = candidate.trim();
  const modifiers = new Set();
  for (;;) {
    const prefix = /^(ctrl|meta|alt|shift)\+/i.exec(key);
    if (!prefix) break;
    modifiers.add(modifierNames.find((name) => name.toLowerCase() === prefix[1].toLowerCase()));
    key = key.slice(prefix[0].length);
  }
  const named = namedKeys.find((name) => name.toLowerCase() === key.toLowerCase());
  if (named) key = named;
  else if (/^[a-z0-9]$|^F(?:[1-9]|1\d|2[0-4])$/i.test(key)) key = key.toUpperCase();
  else if (!/^[=\-.,/;'\[\]`\\]$/.test(key) && !/^Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter)$/.test(key)) return '';
  return [...modifierNames.filter((name) => modifiers.has(name)), key].join('+');
}

export function normalizeShortcuts(candidate = {}) {
  const configured = {};
  const occupied = new Set();
  for (const action of shortcutActions) {
    const requested = candidate?.[action.id];
    const slots = Array.isArray(requested) ? requested.slice(0, 2)
      : typeof requested === 'string' ? [requested, action.keys[1]] : action.keys;
    configured[action.id] = [0, 1].map((slot) => {
      const binding = normalizeBinding(slots[slot]);
      if (!binding || occupied.has(binding)) return '';
      occupied.add(binding);
      return binding;
    });
  }
  return configured;
}

export function actionForBinding(shortcuts, binding) {
  if (!binding) return null;
  return shortcutActions.find((action) => shortcuts[action.id]?.includes(binding))?.id || null;
}

function withModifiers(key, event) {
  return normalizeBinding([...modifierNames.filter((name) => event[`${name.toLowerCase()}Key`]), key].join('+'));
}

export function bindingFromKey(event) {
  if (event.isComposing || ['Control', 'Meta', 'Alt', 'Shift', 'Escape', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return '';
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code || '');
  const punctuation = { Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/' };
  const key = physical ? physical[1] || physical[2] : event.code?.startsWith('Numpad') ? event.code : punctuation[event.code] || (event.key === ' ' ? 'Space' : event.key);
  return withModifiers(key, event);
}

export function bindingFromWheel(event) {
  const horizontal = Number(event.deltaX) || 0;
  const vertical = Number(event.deltaY) || 0;
  if (!horizontal && !vertical) return '';
  const key = Math.abs(horizontal) > Math.abs(vertical) ? (horizontal < 0 ? 'MouseLeft' : 'MouseRight') : (vertical < 0 ? 'Mouse+' : 'Mouse-');
  return withModifiers(key, event);
}

export function changeBinding(current, action, slot, requested, { replace = false } = {}) {
  if (!shortcutActions.some((item) => item.id === action) || ![0, 1].includes(slot)) throw new Error('快捷键槽位不存在');
  const binding = normalizeBinding(requested);
  if (requested && !binding) throw new Error('无法识别这个按键，请重新录入');
  const shortcuts = normalizeShortcuts(current);
  const owner = binding && shortcutActions.find((item) => shortcuts[item.id].some((key, index) => key === binding && (item.id !== action || index !== slot)));
  const conflict = owner ? { action: owner.id, slot: shortcuts[owner.id].indexOf(binding) } : null;
  if (conflict && !replace) return { shortcuts, conflict };
  if (conflict) shortcuts[conflict.action][conflict.slot] = '';
  shortcuts[action][slot] = binding;
  return { shortcuts, conflict: null };
}

export function displayBinding(binding) {
  return binding.replace('MouseLeft', 'Mouse←').replace('MouseRight', 'Mouse→').replace('Meta+', '⌘+').replace('Space', '空格');
}
