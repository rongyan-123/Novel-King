(() => {
  const key = 'novel_king_appearance';
  const styles = Object.freeze([
    { id: 'minimal', name: '极简', description: '清晰留白，专注文字', accent: '#3d73c8' },
    { id: 'cool', name: '冷峻', description: '利落线条，冷色秩序', accent: '#527caa' },
    { id: 'premium', name: '质感', description: '温润纸色，细腻层次', accent: '#96704a' },
    { id: 'cartoon', name: '卡通', description: '柔和色彩，轻松创作', accent: '#8764b8' },
  ]);
  function normalize(candidate = {}) {
    const preferences = candidate && typeof candidate === 'object' ? candidate : {};
    return {
      mode: ['system', 'light', 'dark'].includes(preferences.mode) ? preferences.mode : 'system',
      style: styles.some((style) => style.id === preferences.style) ? preferences.style : 'minimal',
      accent: typeof preferences.accent === 'string' && /^#[0-9a-f]{6}$/i.test(preferences.accent) ? preferences.accent.toLowerCase() : '',
    };
  }
  function read(storage) {
    try {
      const saved = storage.getItem(key);
      return saved ? normalize(JSON.parse(saved)) : normalize({ mode: storage.getItem('ns_theme') });
    } catch { return normalize(); }
  }
  function save(storage, candidate) {
    const preferences = normalize(candidate);
    storage.setItem(key, JSON.stringify(preferences));
    return preferences;
  }
  function resolveMode(preferences, systemDark = false) {
    const mode = normalize(preferences).mode;
    return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  }
  function apply(document, candidate, systemDark = false) {
    const preferences = normalize(candidate);
    const root = document.documentElement;
    root.dataset.theme = resolveMode(preferences, systemDark);
    root.dataset.uiStyle = preferences.style;
    const accent = preferences.accent || styles.find((style) => style.id === preferences.style).accent;
    root.style.setProperty('--primary', accent);
    return preferences;
  }
  globalThis.NovelKingAppearance = Object.freeze({ styles, normalize, read, save, resolveMode, apply });
})();
