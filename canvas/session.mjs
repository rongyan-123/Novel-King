// 场景保存独立于 React 和绘图库；同一作品的请求严格串行，失败不推进保存基线。
export function createCanvasSession({ initial, save, onStatus = () => {}, delay = 800 }) {
  let revision = initial.revision;
  let scene = initial.scene;
  let signature = JSON.stringify(scene);
  let sequence = 0, savedSequence = 0, timer, pending;
  const flush = () => {
    clearTimeout(timer);
    if (pending) return pending;
    pending = (async () => {
      while (savedSequence < sequence) {
        const writingSequence = sequence;
        const snapshot = scene;
        onStatus({ state: 'saving', message: '正在保存画布…' });
        try {
          const result = await save({ revision, scene: snapshot });
          revision = result.revision;
          savedSequence = writingSequence;
        } catch (error) {
          clearTimeout(timer);
          onStatus({ state: 'error', message: error.message });
          throw error;
        }
      }
      clearTimeout(timer);
      onStatus({ state: 'saved', message: '画布已保存' });
    })().finally(() => { pending = null; });
    return pending;
  };
  return {
    update(next) {
      const nextSignature = JSON.stringify(next);
      if (signature === nextSignature) return;
      scene = next; signature = nextSignature; sequence++;
      onStatus({ state: 'dirty', message: '画布有修改' });
      clearTimeout(timer);
      timer = setTimeout(() => { flush().catch(() => {}); }, delay);
    },
    flush,
    dispose() { clearTimeout(timer); },
  };
}
