import assert from 'node:assert/strict';
import { test, before } from 'node:test';

let writing;
before(async () => {
  await import('../public/writing-workspace.js');
  writing = globalThis.NovelKingWriting;
});

test('偏好损坏、未知键及越界值不会破坏写作布局', () => {
  const defaults = writing.readPreferences({ getItem: () => '{broken' });
  assert.equal(defaults.fontSize, 20);
  assert.equal(defaults.theme, 'navy');
  const normalized = writing.normalizePreferences({ fontSize: 200, width: -100, lineHeight: 'bad', margin: 999, theme: 'bad', font: 'url(evil)', extra: true });
  assert.equal(normalized.fontSize, 36);
  assert.equal(normalized.width, 480);
  assert.equal(normalized.lineHeight, 2);
  assert.equal(normalized.margin, 200);
  assert.equal(normalized.font, defaults.font);
  assert.equal(normalized.theme, 'navy');
  assert.equal('extra' in normalized, false);
});

test('偏好存储及恢复，拒绝外部背景地址和非法颜色', () => {
  const stored = new Map();
  const storage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  writing.savePreferences(storage, { fontSize: 24, lineHeight: 2.4, width: 1000, margin: 32, theme: 'paper', background: '#123456' });
  const restored = writing.readPreferences(storage);
  assert.equal(restored.fontSize, 24);
  assert.equal(restored.width, 1000);
  assert.equal(restored.background, '#123456');
  assert.equal(writing.normalizePreferences({ image: 'https://external.test/pixel', background: 'red;display:none' }).image, '');
  assert.equal(writing.normalizePreferences({ background: 'red;display:none' }).background, '');
  assert.equal(writing.normalizePreferences({ image: 'data:image/png;base64,YWJj' }).image, 'data:image/png;base64,YWJj');
  assert.throws(() => writing.savePreferences({ setItem: () => { throw new Error('quota'); } }, {}), /quota/);
});

test('新建请求合并快速连点，一次创建作品及首章', async () => {
  const calls = [];
  let resolveRequest;
  const create = writing.createWorkStarter((...args) => { calls.push(args); return new Promise((resolve) => { resolveRequest = resolve; }); });
  const first = create();
  const second = create();
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['/works', { method: 'POST', body: { title: '未命名作品', initial_chapter: true } }]);
  resolveRequest({ id: 7, initial_chapter_id: 9 });
  assert.deepEqual(await first, { id: 7, initial_chapter_id: 9 });
});

test('新建失败后可以重试，失败不会导航到不存在的作品', async () => {
  let attempts = 0;
  const create = writing.createWorkStarter(async () => {
    if (++attempts === 1) throw new Error('network');
    return { id: 8, initial_chapter_id: 10 };
  });
  await assert.rejects(create(), /network/);
  assert.equal((await create()).id, 8);
  const invalid = writing.createWorkStarter(async () => ({ id: 8 }));
  await assert.rejects(invalid(), /章节/);
});

test('发布复制保留段落及缩进，不夹带 HTML 或显示样式', async () => {
  let clipboard;
  const editor = { innerText: '　　第一段\r\n\r\n第二段\u200b\u00a0文字\n', innerHTML: '<p>不能读取这个字段</p>' };
  await writing.copyPlainText(editor, { writeText: async (value) => { clipboard = value; } });
  assert.equal(clipboard, '　　第一段\n\n第二段 文字');
  await assert.rejects(writing.copyPlainText(editor, { writeText: async () => { throw new Error('denied'); } }), /denied/);
});

test('查找支持重复命中、循环查找、空查询及无命中', () => {
  assert.deepEqual(writing.findMatch('镜爷说，镜爷听。', '镜爷', 0), { start: 0, end: 2 });
  assert.deepEqual(writing.findMatch('镜爷说，镜爷听。', '镜爷', 2), { start: 4, end: 6 });
  assert.deepEqual(writing.findMatch('镜爷说，镜爷听。', '镜爷', 6), { start: 0, end: 2 });
  assert.equal(writing.findMatch('镜爷', '', 0), null);
  assert.equal(writing.findMatch('镜爷', '不存在', 0), null);
});

test('允许自定义已安装字体名称，拒绝 CSS 注入', () => {
  assert.equal(writing.normalizePreferences({ font: '霞鹜文楷' }).font, '霞鹜文楷');
  assert.equal(writing.normalizePreferences({ font: 'Noto Serif SC' }).font, 'Noto Serif SC');
  assert.equal(writing.normalizePreferences({ font: 'serif; background: url(evil)' }).font, writing.defaults.font);
});

test('字体设置只更新排版，保留背景和目录偏好；背景设置只更新背景', () => {
  const original = writing.normalizePreferences({ image: 'data:image/png;base64,YWJj', background: '#123456', catalogWidth: 380, catalogCollapsed: true });
  const font = writing.mergeAppearance(original, 'font', { fontSize: 26, indent: false, paragraphGap: false, background: '#ffffff' });
  assert.equal(font.fontSize, 26);
  assert.equal(font.indent, false);
  assert.equal(font.background, '#123456');
  assert.equal(font.image, original.image);
  assert.equal(font.catalogWidth, 380);
  assert.equal(font.catalogCollapsed, true);
  const background = writing.mergeAppearance(font, 'background', { theme: 'paper', imageOpacity: .3, grid: 'dashed', fontSize: 15 });
  assert.equal(background.fontSize, 26);
  assert.equal(background.grid, 'dashed');
  assert.equal(background.imageOpacity, .3);
  assert.equal(background.theme, 'paper');
});

test('选中空卷后在该卷建章；未分卷和已删除卷不会误用当前章节的卷', () => {
  const volumes = [{ id: 3 }, { id: 4 }];
  assert.equal(writing.chapterVolume(volumes, 4, 3), 4);
  assert.equal(writing.chapterVolume(volumes, null, 3), null);
  assert.equal(writing.chapterVolume(volumes, undefined, 3), 3);
  assert.equal(writing.chapterVolume(volumes, 99, 3), null);
});
