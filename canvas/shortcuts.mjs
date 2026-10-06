export const defaultShortcuts = Object.freeze({ selection: 'V', hand: 'H', freedraw: 'P', text: 'T', rectangle: 'R', arrow: 'A', eraser: 'E' });
export function normalizeShortcuts(candidate = {}) {
  const configured = { ...defaultShortcuts };
  const used = new Set();
  for (const tool of Object.keys(defaultShortcuts)) {
    const requested = String(candidate?.[tool] || '').toUpperCase();
    if (/^[A-Z]$/.test(requested) && !used.has(requested) && !Object.entries(defaultShortcuts).some(([other, key]) => other !== tool && key === requested)) configured[tool] = requested;
    used.add(configured[tool]);
  }
  return configured;
}
