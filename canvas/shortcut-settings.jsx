import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { shortcutActions, defaultShortcuts, normalizeShortcuts, bindingFromKey, bindingFromWheel, changeBinding, displayBinding } from './shortcuts.mjs';

export function ShortcutSettings({ shortcuts, onApply, onClose }) {
  const [draft, setDraft] = useState(() => normalizeShortcuts(shortcuts));
  const [listening, setListening] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current.querySelector('button').focus();
    return () => opener?.isConnected && opener.focus();
  }, []);
  useEffect(() => {
    const captureBinding = (binding) => {
      if (!binding) return;
      const updated = changeBinding(draft, listening.action, listening.slot, binding);
      if (updated.conflict) setConflict({ ...listening, binding, owner: updated.conflict });
      else { setDraft(updated.shortcuts); setConflict(null); }
      setListening(null);
      setError('');
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (listening || conflict) { setListening(null); setConflict(null); } else onClose();
        return;
      }
      if (listening) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) captureBinding(bindingFromKey(event));
      } else if (event.key === 'Tab') {
        const buttons = [...dialogRef.current.querySelectorAll('button:not(:disabled)')];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onWheel = (event) => {
      if (!listening) return;
      event.preventDefault(); event.stopImmediatePropagation();
      captureBinding(bindingFromWheel(event));
    };
    document.addEventListener('keydown', onKey, true);
    const dialog = dialogRef.current;
    dialog.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => { document.removeEventListener('keydown', onKey, true); dialog.removeEventListener('wheel', onWheel, true); };
  }, [draft, listening, conflict, onClose]);

  const begin = (action, slot) => { setListening({ action, slot }); setConflict(null); setError(''); };
  const clear = (action, slot) => { setDraft(changeBinding(draft, action, slot, '').shortcuts); setListening(null); setConflict(null); };
  const replace = () => {
    setDraft(changeBinding(draft, conflict.action, conflict.slot, conflict.binding, { replace: true }).shortcuts);
    setConflict(null);
  };
  return createPortal(<div className="shortcut-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-title" ref={dialogRef}>
      <header><div><h2 id="shortcut-title">画布快捷键</h2><p>点选绑定框，然后按下按键或滚动鼠标。</p></div><button aria-label="关闭快捷键设置" onClick={onClose}>✕</button></header>
      <div className="shortcut-instructions"><span><kbd>Mouse+</kbd> 滚轮向上</span><span><kbd>Mouse-</kbd> 滚轮向下</span><span>支持 Ctrl / Shift 等组合键；Esc 取消录入。</span></div>
      <div className="shortcut-scroll"><div className="shortcut-columns"><span>功能</span><span>主按键</span><span>备用按键</span></div>
        {shortcutActions.map((action, index) => <React.Fragment key={action.id}>
          {shortcutActions[index - 1]?.group !== action.group && <h3 className="shortcut-group">{action.group}</h3>}
          <div className="shortcut-row" data-shortcut-action={action.id}><span className="shortcut-action-name">{action.name}</span>{[0, 1].map((slot) => {
            const active = listening?.action === action.id && listening.slot === slot;
            return <div className={`shortcut-cell ${active ? 'listening' : ''}`} key={slot}>
              <button className="shortcut-binding" data-slot={slot} title={draft[action.id][slot] ? displayBinding(draft[action.id][slot]) : undefined} aria-label={`${action.name}${slot === 0 ? '主' : '备用'}按键`} aria-pressed={active} onClick={() => begin(action.id, slot)}>{active ? '请按键 / 滚动…' : draft[action.id][slot] ? <kbd>{displayBinding(draft[action.id][slot])}</kbd> : <span className="shortcut-unbound">点击绑定</span>}</button>
              {draft[action.id][slot] && <button className="shortcut-clear" data-slot={slot} aria-label={`清除${action.name}${slot === 0 ? '主' : '备用'}按键`} onClick={() => clear(action.id, slot)}>×</button>}
            </div>;
          })}</div>
        </React.Fragment>)}
      </div>
      <div className="shortcut-feedback" aria-live="polite">{conflict ? <div role="alert"><span><kbd>{displayBinding(conflict.binding)}</kbd> 已绑定「{shortcutActions.find((action) => action.id === conflict.owner.action).name}」的{conflict.owner.slot === 0 ? '主' : '备用'}按键。</span><div><button className="shortcut-replace" onClick={replace}>替换绑定</button><button onClick={() => begin(conflict.action, conflict.slot)}>重新录入</button></div></div> : error ? <span role="alert">{error}</span> : <span>{listening ? '正在录入，按 Esc 取消。' : '仅在画布中生效；编辑文字时不触发。应用后保存到当前浏览器。'}</span>}</div>
      <footer><button className="shortcut-reset" onClick={() => { setDraft(normalizeShortcuts(defaultShortcuts)); setListening(null); setConflict(null); }}>恢复默认</button><div><button className="shortcut-cancel" onClick={onClose}>取消</button><button className="shortcut-apply" disabled={!!listening || !!conflict} onClick={() => { try { onApply(draft); } catch { setError('快捷键保存失败，请检查浏览器是否允许存储，然后重试。'); } }}>应用</button></div></footer>
    </section>
  </div>, document.body);
}
