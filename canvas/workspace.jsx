import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, MainMenu, convertToExcalidrawElements, exportToBlob, loadFromBlob, getCommonBounds, CaptureUpdateAction } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { createCanvasSession } from './session.mjs';
import { proposalSkeleton } from './plot.mjs';
import { defaultShortcuts, normalizeShortcuts } from './shortcuts.mjs';

const shortcutKey = 'novel_king_canvas_shortcuts';
const toolNames = { selection: '选择', hand: '移动', freedraw: '铅笔', text: '文字', rectangle: '图形', arrow: '箭头', eraser: '橡皮' };
const capture = CaptureUpdateAction.IMMEDIATELY;
function persistentScene(elements, appState, files) {
  const keys = ['scrollX', 'scrollY', 'zoom', 'viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled', 'currentItemFontFamily', 'currentItemFontSize', 'currentItemStrokeColor', 'currentItemBackgroundColor', 'currentItemRoughness'];
  return { elements, appState: Object.fromEntries(keys.filter((key) => appState[key] !== undefined).map((key) => [key, appState[key]])), files };
}
function readShortcuts() {
  try { return normalizeShortcuts(JSON.parse(localStorage.getItem(shortcutKey) || '{}')); }
  catch { return { ...defaultShortcuts }; }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function mountCanvas(host, options) {
  const initial = await options.request(`/canvas?work_id=${options.workId}`);
  let canvasAPI, destroyed = false;
  let updateStatus = () => {};
  let updateTheme = () => {};
  const session = createCanvasSession({ initial, save: (body) => options.request(`/canvas?work_id=${options.workId}`, { method: 'PUT', body }), onStatus: (status) => updateStatus(status) });
  const snapshot = () => persistentScene(canvasAPI.getSceneElementsIncludingDeleted(), canvasAPI.getAppState(), canvasAPI.getFiles());
  const flush = async () => {
    if (canvasAPI) session.update(snapshot());
    try { await session.flush(); return true; }
    catch (error) { options.notify(`画布未保存：${error.message}。可先导出本机画布。`, 'error'); return false; }
  };

  function Workspace() {
    const apiRef = useRef(null);
    const importRef = useRef(null);
    const [theme, setTheme] = useState(options.theme === 'dark' ? 'dark' : 'light');
    updateTheme = setTheme;
    const [status, setStatus] = useState({ state: 'saved', message: '画布已保存' });
    const [selectedIds, setSelectedIds] = useState([]);
    const [chapterId, setChapterId] = useState('');
    const [aiOpen, setAIOpen] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [vision, setVision] = useState(false);
    const [configId, setConfigId] = useState(String(options.configId || options.configs[0]?.id || ''));
    const [busy, setBusy] = useState(false);
    const [answer, setAnswer] = useState(null);
    const [error, setError] = useState('');
    const [shortcuts, setShortcuts] = useState(readShortcuts);
    const [shortcutError, setShortcutError] = useState('');
    const proposalBase = useRef('');
    updateStatus = setStatus;

    useEffect(() => {
      const onKey = (event) => {
        if (host.hidden || !host.getClientRects().length || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.target.closest('input,textarea,select,[contenteditable="true"]') || apiRef.current?.getAppState().editingTextElement) return;
        const tool = Object.keys(shortcuts).find((key) => shortcuts[key] === event.key.toUpperCase());
        if (!tool || !apiRef.current) return;
        event.preventDefault(); event.stopImmediatePropagation();
        apiRef.current.setActiveTool({ type: tool });
      };
      host.ownerDocument.addEventListener('keydown', onKey, true);
      const beforeUnload = (event) => {
        if (status.state === 'saved') return;
        event.preventDefault(); event.returnValue = '';
      };
      host.ownerDocument.defaultView.addEventListener('beforeunload', beforeUnload);
      return () => { host.ownerDocument.removeEventListener('keydown', onKey, true); host.ownerDocument.defaultView.removeEventListener('beforeunload', beforeUnload); };
    }, [shortcuts, status.state]);

    const guard = (operation) => async (...args) => { try { await operation(...args); } catch (failure) { setError(failure.message); options.notify(failure.message, 'error'); } };
    const origin = () => {
      const state = apiRef.current.getAppState();
      const bounds = host.querySelector('.canvas-editor-area').getBoundingClientRect();
      return { x: bounds.width / (2 * state.zoom.value) - state.scrollX - 125, y: bounds.height / (2 * state.zoom.value) - state.scrollY - 70 };
    };
    const addCard = () => {
      const api = apiRef.current;
      if (!api) return;
      const card = convertToExcalidrawElements([{ type: 'rectangle', ...origin(), width: 250, height: 140, roughness: 0, backgroundColor: '#fff3bf', label: { text: '新剧情\n双击修改内容', fontFamily: 2, fontSize: 18 } }]);
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...card], appState: { selectedElementIds: { [card[0].id]: true } }, captureUpdate: capture });
    };
    const linkChapter = () => {
      const api = apiRef.current;
      if (!api || !selectedIds.length) throw new Error('先选中需要关联的剧情卡或图形');
      const selected = new Set(selectedIds);
      const elements = api.getSceneElementsIncludingDeleted().map((element) => selected.has(element.id) ? { ...element, customData: { ...element.customData, chapterId: chapterId ? Number(chapterId) : null }, link: chapterId ? `${location.origin}/#novel-chapter-${chapterId}` : null, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now() } : element);
      api.updateScene({ elements, captureUpdate: capture });
      options.notify(chapterId ? '已关联章节，点「打开章节」或图形上的链接返回正文' : '已解除章节关联', 'success');
    };
    const openChapter = () => {
      const element = apiRef.current?.getSceneElements().find((item) => selectedIds.includes(item.id) && item.customData?.chapterId);
      if (element) options.openChapter(element.customData.chapterId);
      else throw new Error('选中的图形还没有关联章节');
    };
    const exportFile = () => download(new Blob([JSON.stringify({ type: 'excalidraw', version: 2, source: 'Novel-King', ...snapshot() })], { type: 'application/json' }), `${options.title}-大纲.excalidraw`);
    const exportImage = async () => download(await exportToBlob({ elements: canvasAPI.getSceneElements(), appState: { ...canvasAPI.getAppState(), exportBackground: true, exportWithDarkMode: false }, files: canvasAPI.getFiles(), maxWidthOrHeight: 4096 }), `${options.title}-大纲.png`);
    const importFile = async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) throw new Error('画布文件不能超过 12 MB');
      const raw = JSON.parse(await file.text());
      if (!Array.isArray(raw.elements)) throw new Error('请选择 .excalidraw 画布文件');
      const chapterIds = new Set(options.chapters.map((chapter) => chapter.id));
      if (raw.elements.some((element) => !element.isDeleted && element.customData?.chapterId != null && !chapterIds.has(element.customData.chapterId))) throw new Error('文件包含其他作品或已删除章节的关联，请在原作品解除关联后导出');
      await options.request(`/canvas/validate?work_id=${options.workId}`, { method: 'POST', body: { scene: { elements: raw.elements, appState: raw.appState || {}, files: raw.files || {} } } });
      if (!confirm('导入会替换当前画布。建议先导出备份；导入后可立即撤销。继续吗？')) return;
      const restored = await loadFromBlob(file, canvasAPI.getAppState(), null);
      canvasAPI.addFiles(Object.values(restored.files || {}));
      canvasAPI.updateScene({ elements: restored.elements, appState: restored.appState, captureUpdate: capture });
      canvasAPI.scrollToContent(undefined, { fitToViewport: true });
    };
    const runAI = async (mode) => {
      if (!configId) throw new Error('请先在 AI 设置中配置模型');
      if (!prompt.trim()) throw new Error('先写下你的剧情要求');
      if (!(await flush())) return;
      setBusy(true); setError(''); setAnswer(null);
      const api = apiRef.current;
      const base = JSON.stringify(api.getSceneElements());
      proposalBase.current = base;
      try {
        let image;
        if (vision && api.getSceneElements().length) {
          const blob = await exportToBlob({ elements: api.getSceneElements(), appState: { ...api.getAppState(), exportWithDarkMode: false, exportBackground: true }, files: api.getFiles(), maxWidthOrHeight: 4096 });
          image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('全图生成失败')); reader.readAsDataURL(blob); });
        }
        const result = await options.request('/ai/canvas', { method: 'POST', body: { config_id: Number(configId), work_id: options.workId, scene: snapshot(), prompt: `${mode === 'diagram' ? '生成便于作者理解的剧情图，给出剧情节点和先后/因果连线。' : '分析剧情，给出具体建议；无需画图时 nodes 和 edges 留空。'}\n${prompt}`, ...(image ? { image } : {}) }, timeout: options.aiTimeout });
        if (!destroyed) setAnswer(result);
      } finally { if (!destroyed) setBusy(false); }
    };
    const applyProposal = () => {
      const api = apiRef.current;
      if (!answer?.proposal?.nodes.length) return;
      if (JSON.stringify(api.getSceneElements()) !== proposalBase.current) throw new Error('画布已改变，请重新生成，避免把旧建议混入新剧情');
      const current = api.getSceneElements();
      const bounds = current.length ? getCommonBounds(current) : null;
      const location = bounds ? { x: bounds[2] + 100, y: bounds[1] } : origin();
      const elements = convertToExcalidrawElements(proposalSkeleton(answer.proposal, location, `plot-${crypto.randomUUID()}`), { regenerateIds: false });
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements], captureUpdate: capture });
      api.scrollToContent(elements, { fitToViewport: true });
      setAnswer(null);
      options.notify('剧情图已加入画布，可以撤销；正文和设定未改动', 'success');
    };
    const changeShortcut = (tool, value) => {
      const next = normalizeShortcuts({ ...shortcuts, [tool]: value });
      if (next[tool] !== value.toUpperCase()) { setShortcutError('请输入一个未占用的英文字母'); return; }
      localStorage.setItem(shortcutKey, JSON.stringify(next)); setShortcuts(next); setShortcutError('');
    };

    return <div className="novel-canvas-root">
      <div className="canvas-commandbar">
        <button className="canvas-primary" onClick={addCard}>＋ 剧情卡</button>
        <button onClick={() => canvasAPI?.scrollToContent(undefined, { fitToViewport: true })}>查看全图</button>
        <details className="canvas-link-controls"><summary>关联章节</summary><div><select aria-label="关联章节" value={chapterId} onChange={(event) => setChapterId(event.target.value)}><option value="">解除关联</option>{options.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select><button disabled={!selectedIds.length} onClick={guard(linkChapter)}>关联选中图形</button><button disabled={!selectedIds.length} onClick={guard(openChapter)}>打开章节</button></div></details>
        <details className="canvas-settings"><summary>快捷键</summary><div>{Object.keys(shortcuts).map((tool) => <label key={tool}>{toolNames[tool]}<input aria-label={`${toolNames[tool]}快捷键`} maxLength="1" value={shortcuts[tool]} onChange={(event) => changeShortcut(tool, event.target.value)} /></label>)}{shortcutError && <small role="alert">{shortcutError}</small>}<small>只在画布中生效；输入文字时不触发。</small></div></details>
        <details className="canvas-file-menu"><summary>导入 / 导出</summary><div><button onClick={() => importRef.current.click()}>导入画布</button><button onClick={exportFile}>导出画布文件</button><button onClick={guard(exportImage)}>导出 PNG 图片</button></div></details>
        <input ref={importRef} hidden type="file" accept=".excalidraw,.json" onChange={guard(importFile)} />
        <button className={aiOpen ? 'active' : ''} onClick={() => setAIOpen(!aiOpen)}>AI 剧情助手</button>
      </div>
      <div className={`canvas-stage ${aiOpen ? 'ai-open' : ''}`}>
        <div className="canvas-editor-area"><Excalidraw langCode="zh-CN" aiEnabled={false} validateEmbeddable={false} theme={theme} name={`${options.title}-大纲`} initialData={{ ...initial.scene, appState: { currentItemFontFamily: 2, currentItemRoughness: 0, ...initial.scene.appState } }} excalidrawAPI={(api) => { apiRef.current = api; canvasAPI = api; }} handleKeyboardGlobally={false} UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } }}
          onChange={(elements, appState, files) => {
            if (destroyed) return;
            session.update(persistentScene(elements, appState, files));
            const selection = Object.keys(appState.selectedElementIds);
            setSelectedIds((previous) => previous.join() === selection.join() ? previous : selection);
          }}
          onLinkOpen={(element, event) => { event.preventDefault(); if (options.chapters.some((chapter) => chapter.id === element.customData?.chapterId)) options.openChapter(element.customData.chapterId); else options.notify('请通过「关联章节」连接当前作品的章节', 'error'); }}>
          <MainMenu><MainMenu.Item data-testid="novel-canvas-grid" onSelect={() => canvasAPI.updateScene({ appState: { gridModeEnabled: !canvasAPI.getAppState().gridModeEnabled } })}>显示 / 隐藏网格</MainMenu.Item><MainMenu.DefaultItems.ChangeCanvasBackground /><MainMenu.Separator /><MainMenu.DefaultItems.ClearCanvas /></MainMenu>
        </Excalidraw></div>
        {aiOpen && <aside className="canvas-ai-panel"><header><b>AI 剧情助手</b><button aria-label="关闭画布 AI" onClick={() => setAIOpen(false)}>✕</button></header><p>AI 会读取整张图，以及本作品的章节、角色与设定。</p><label>使用模型<select value={configId} onChange={(event) => setConfigId(event.target.value)}>{!options.configs.length && <option value="">尚未配置</option>}{options.configs.map((config) => <option key={config.id} value={config.id}>{config.name} · {config.model}</option>)}</select></label><button onClick={options.openAISettings}>配置 AI</button><textarea aria-label="画布 AI 要求" rows="5" maxLength="8000" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：把主角发现秘密到身份反转整理成剧情图，标出伏笔。" /><label className="canvas-vision"><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} />识图：同时发送全图图片</label><small>识图需要支持图片的模型；文字模型可理解文字和连线。</small><div className="canvas-ai-actions"><button disabled={busy} onClick={guard(() => runAI('advice'))}>给我建议</button><button className="canvas-primary" disabled={busy} onClick={guard(() => runAI('diagram'))}>{busy ? '正在构思…' : '生成剧情图'}</button></div>{answer && <div className="canvas-ai-answer"><p>{answer.proposal?.advice || answer.reply}</p>{answer.proposal?.nodes.map((node, index) => <div className="canvas-proposal-node" key={node.id}><b>{index + 1}.</b> {node.text}</div>)}{answer.proposal?.edges.map((edge, index) => <small key={index}>{edge.from} → {edge.to} {edge.label}<br /></small>)}{!!answer.proposal?.nodes.length && <button className="canvas-primary" onClick={guard(applyProposal)}>加入画布（可撤销）</button>}</div>}{error && <p className="canvas-error" role="alert">{error}</p>}</aside>}
      </div>
      <footer className={`canvas-status ${status.state}`}><span>{status.message}</span><span className="canvas-gesture-hint">双击剧情卡编辑文字 · 空格拖动平移 · 手机双指缩放</span><button onClick={guard(flush)}>保存</button><button onClick={exportFile}>导出</button>{status.state === 'error' && <button onClick={() => options.reload()}>重新载入</button>}</footer>
    </div>;
  }
  const root = createRoot(host);
  root.render(<Workspace />);
  return { flush, setTheme(theme) { updateTheme(theme); }, dispose() { destroyed = true; session.dispose(); root.unmount(); updateStatus = () => {}; }, refresh() { canvasAPI?.refresh(); }, snapshot };
}
