// 小型、可独立验证的写作交互；正文保存仍由 app.js 的保存护栏负责。
(() => {
  const preferenceKey = 'novel_king_writing_preferences';
  const fonts = ['"Microsoft YaHei", sans-serif', 'SimSun, serif', 'KaiTi, serif', 'Arial, sans-serif'];
  const defaults = Object.freeze({ font: fonts[0], fontSize: 20, lineHeight: 2, width: 960, margin: 64, theme: 'navy', background: '', image: '' });
  function normalizePreferences(candidate = {}) {
    const preferences = candidate && typeof candidate === 'object' ? candidate : {};
    const bounded = (key, minimum, maximum) => {
      const value = Number(preferences[key] ?? defaults[key]);
      return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : defaults[key];
    };
    const image = typeof preferences.image === 'string' ? preferences.image : '';
    const font = typeof preferences.font === 'string' ? preferences.font.trim() : '';
    const validFont = fonts.includes(font) || /^[\p{L}\p{N} _-]{1,80}$/u.test(font);
    return {
      font: validFont ? font : defaults.font,
      fontSize: bounded('fontSize', 14, 36), lineHeight: bounded('lineHeight', 1.2, 3),
      width: bounded('width', 480, 1400), margin: bounded('margin', 12, 200),
      theme: ['navy', 'paper', 'green'].includes(preferences.theme) ? preferences.theme : defaults.theme,
      background: /^#[0-9a-f]{6}$/i.test(preferences.background || '') ? preferences.background : '',
      image: image.length <= 2800000 && /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(image) ? image : '',
    };
  }
  function readPreferences(storage) {
    try { return normalizePreferences(JSON.parse(storage.getItem(preferenceKey) || '{}')); }
    catch { return normalizePreferences(); }
  }
  function savePreferences(storage, candidate) {
    const preferences = normalizePreferences(candidate);
    storage.setItem(preferenceKey, JSON.stringify(preferences));
    return preferences;
  }
  function createWorkStarter(request) {
    let pending;
    return function startWork() {
      if (pending) return pending;
      pending = (async () => {
        const work = await request('/works', { method: 'POST', body: { title: '未命名作品', initial_chapter: true } });
        if (!Number(work?.id) || !Number(work?.initial_chapter_id)) throw new Error('未取得作品或初始章节，请刷新作品列表');
        return work;
      })().finally(() => { pending = null; });
      return pending;
    };
  }
  function publicationText(text) {
    return String(text || '').replace(/\r\n?/g, '\n').replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
  }
  async function copyPlainText(editor, clipboard) {
    if (!editor || !clipboard?.writeText) throw new Error('无法访问剪贴板，请使用 TXT 导出');
    const plain = publicationText(editor.innerText);
    await clipboard.writeText(plain);
    return plain;
  }
  function findMatch(text, query, from = 0) {
    if (!query) return null;
    let start = text.indexOf(query, Math.max(0, from));
    if (start < 0) start = text.indexOf(query);
    return start < 0 ? null : { start, end: start + query.length };
  }
  globalThis.NovelKingWriting = Object.freeze({ defaults, fonts, normalizePreferences, readPreferences, savePreferences, createWorkStarter, publicationText, copyPlainText, findMatch });
})();
