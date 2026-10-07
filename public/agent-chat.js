(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = name => {
    const paths = { chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
      plus: '<path d="M12 5v14M5 12h14"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
      send: '<path d="m5 12 7-7 7 7M12 5v14"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>', book: '<path d="M4 4h7v16H4zM13 4h7v16h-7zM7 8h1M16 8h1"/>',
      arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', history: '<path d="M3 7h18M3 12h18M3 17h18"/>' };
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
  };
  function inline(text) {
    let html = escape(text);
    html = html.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_match, label, href) => {
      try {
        const url = new URL(href.replaceAll('&amp;', '&'));
        if (url.protocol !== 'https:' || /["'<>]|&quot;|&#39;/.test(href)) return label;
        return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      } catch { return label; }
    });
    return html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }
  function markdown(text) {
    const lines = String(text || '').split(/\r?\n/), output = []; let list = '', fenced = false, code = [];
    const closeList = () => { if (list) { output.push(`</${list}>`); list = ''; } };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/^\s*```/.test(line)) { closeList(); if (fenced) { output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = []; } fenced = !fenced; continue; }
      if (fenced) { code.push(line); continue; }
      if (!line.trim()) { closeList(); continue; }
      if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
        closeList(); const cells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim()));
        const header = cells(line); index += 2; const rows = [];
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(cells(lines[index])); index++; }
        index--; output.push(`<div class="chat-table"><table><thead><tr>${header.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)/), bullet = line.match(/^\s*([-*]|\d+[.)])\s+(.+)/);
      if (heading) { closeList(); const level = Math.max(2, heading[1].length); output.push(`<h${level}>${inline(heading[2])}</h${level}>`); }
      else if (bullet) { const kind = /^\d/.test(bullet[1]) ? 'ol' : 'ul'; if (list !== kind) { closeList(); list = kind; output.push(`<${kind}>`); } output.push(`<li>${inline(bullet[2])}</li>`); }
      else { closeList(); output.push(`<p>${inline(line)}</p>`); }
    }
    closeList(); if (fenced && code.length) output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
    return output.join('');
  }
  const boards = { newbooks: '签约新书榜', potential: '潜力榜', publicnewbooks: '未签约新书榜', sanjiang: '三江推荐', monthly: '月票榜', bestsellers: '畅销榜', recommendations: '推荐榜' };
  const toolNames = { novel_catalog: '查阅本书目录与设定', novel_read_chapter: '阅读小说章节', novel_read_setting: '阅读人物与设定', novel_read_outline: '阅读卷纲与剧情线', novel_read_canvas: '阅读大纲画布', library_list_documents: '查找文件库资料', library_read_document: '阅读资料文件', rankings_list_snapshots: '查阅已保存榜单', skill_list: '选择研究技能' };
  function activity(events = []) {
    return events.filter(event => event.type === 'tool/call').slice(-30).map(event => {
      const { name = '' } = event.data || {};
      let args = event.data?.arguments || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const label = name === 'qidian_scan_ranking' ? `采集起点${boards[args.board] || args.board || '榜单'}`
        : name === 'skill_read' ? `读取${args.id === 'editorial-review' ? '编辑诊断' : args.id === 'comparable-dissection' ? '对照拆解' : '研究'}技能`
        : toolNames[name] || (name.startsWith('mcp_') ? '查询外部 MCP 资料' : name);
      const result = event.data?.callId && events.find(candidate => candidate.type === 'tool/result' && (candidate.data?.callId || candidate.data?.message?.source?.callId) === event.data.callId);
      return { label, done: Boolean(result), failed: Boolean(result?.data?.isError || result?.data?.message?.content?.some(block => block.type === 'tool-result' && block.isError)), id: event.data?.callId || '' };
    });
  }
  async function api(route, body, method) {
    const response = await fetch('/api' + route, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
    const payload = await response.json(); if (!response.ok) throw Error(payload.error || `请求失败 (${response.status})`); return payload;
  }
  const statusNames = { complete: '已保存', running: '正在研究', failed: '回答失败', cancelled: '已停止', interrupted: '服务中断' };
  const storageKey = 'novelking.agent.conversation';
  let current;
  class Chat {
    constructor(root, options) {
      this.root = root; this.options = options; this.storage = window.NovelKingAccount?.localStorage || localStorage;
      this.workId = options.workId || null; this.configId = options.activeConfigId; this.messages = []; this.conversations = []; this.sequence = 0;
      this.listener = event => this.click(event); root.addEventListener('click', this.listener);
      this.root.classList.add('agent-chat-active');
    }
    active() { return !this.disposed && this.root.isConnected; }
    dispose() { this.disposed = true; this.sequence++; clearTimeout(this.poll); this.root.removeEventListener('click', this.listener); this.settings?.remove(); this.root.classList.remove('agent-chat-active'); if (this.settingsEscape) document.removeEventListener('keydown', this.settingsEscape); }
    note(text, error = false) { if (!this.active()) return; const box = this.root.querySelector('.chat-notice'); if (box) { box.textContent = text; box.hidden = !text; box.dataset.error = String(error); } }
    read(key) { try { return this.storage.getItem(key); } catch { return ''; } }
    write(key, value) { try { this.storage.setItem(key, value); } catch {} }
    draftKey() { return 'novelking.agent.draft.' + (this.conversation?.id || 'new.' + (this.workId || 'shared')); }
    async load() {
      this.root.innerHTML = '<section class="page-loading" role="status"><span class="loading-ring"></span><h1>AI 中心</h1><p>正在读取会话…</p></section>';
      try {
        const [history, works, configs] = await Promise.all([api('/research/conversations'), api('/works'), api('/api_configs')]);
        if (!this.active()) return;
        this.conversations = history.conversations; this.runningId = history.active_conversation_id || null;
        this.works = works; this.configs = configs; this.configId = configs.find(config => config.id === Number(this.configId))?.id || configs[0]?.id;
        const saved = this.conversations.find(conversation => conversation.id === this.read(storageKey));
        if (saved && (!this.options.workId || saved.work_id === this.options.workId)) await this.open(saved.id);
        else { if (!this.workId && works.length === 1) this.workId = works[0].id; this.paint(); }
      } catch (error) { if (this.active()) { this.root.innerHTML = `<section class="page-loading" role="alert"><h1>无法读取 AI 中心</h1><p>${escape(error.message)}</p><button class="btn" data-chat-action="reload">重试</button></section>`; } }
    }
    async open(id) {
      const ticket = ++this.sequence; this.opening = true; this.note('正在打开会话…'); this.paintComposer();
      try {
        const result = await api('/research/conversations/' + id + '/messages');
        if (ticket !== this.sequence || !this.active()) return;
        this.opening = false; this.conversation = result.conversation; this.workId = result.conversation.work_id; this.messages = result.messages;
        this.write(storageKey, id); this.paint(); this.watch();
      } catch (error) { if (ticket === this.sequence) { this.opening = false; this.note(error.message, true); this.paintComposer(); } }
    }
    fresh(workId = this.workId) {
      this.sequence++; this.opening = false; clearTimeout(this.poll); this.conversation = null; this.messages = []; this.workId = workId; this.write(storageKey, ''); this.paint(); this.root.querySelector('#chat-prompt')?.focus();
    }
    historyHTML() {
      return `<aside class="chat-history" aria-label="聊天历史"><div class="chat-history-head"><span>会话</span><button class="chat-icon-button" data-chat-action="history" aria-label="关闭会话列表">${icon('close')}</button></div><button class="chat-new" data-chat-action="new">${icon('plus')} 新对话</button><div class="chat-history-list">${this.conversations.map(conversation => `<div class="chat-history-row ${conversation.id === this.conversation?.id ? 'selected' : ''}"><button data-chat-action="open" data-id="${conversation.id}"><span>${escape(conversation.title)}</span><small>${escape(conversation.work_title || '共享资料与榜单')}</small></button><details><summary aria-label="会话操作">⋯</summary><div><button data-chat-action="rename" data-id="${conversation.id}">重命名</button><button data-chat-action="delete" data-id="${conversation.id}">删除会话</button></div></details></div>`).join('') || '<p class="chat-history-empty">第一段对话会保存在这里。</p>'}</div><div class="chat-history-foot">对话自动保存</div></aside>`;
    }
    paint() {
      if (!this.active()) return;
      const draft = this.read(this.draftKey()) || '';
      this.root.innerHTML = `<div class="chat-workspace">${this.historyHTML()}<section class="chat-main" aria-label="AI 聊天"><header class="chat-header"><div><button class="chat-icon-button chat-history-toggle" data-chat-action="history" aria-label="聊天历史">${icon('history')}</button><h1>${escape(this.conversation?.title || 'AI 中心')}</h1></div><button class="chat-settings-button" data-chat-action="settings">${icon('settings')} <span>AI 设置</span></button></header>
        <div class="chat-thread" role="log" aria-label="对话内容" tabindex="0"></div><div class="chat-compose-wrap"><p class="chat-notice" role="status" hidden></p><form class="chat-composer" id="chat-form"><div class="chat-context"><label>${icon('book')}<select id="chat-work" aria-label="当前小说"><option value="">共享资料与榜单</option>${this.works.map(work => `<option value="${work.id}" ${work.id === this.workId ? 'selected' : ''}>${escape(work.title)}</option>`).join('')}</select></label><label><select id="chat-model" aria-label="聊天模型">${this.configs.map(config => `<option value="${config.id}" ${config.id === this.configId ? 'selected' : ''}>${escape(config.name)} · ${escape(config.model)}</option>`).join('') || '<option value="">先连接模型</option>'}</select></label></div>
          <textarea id="chat-prompt" rows="2" maxlength="12000" aria-label="给 AI 的消息" placeholder="告诉我你想研究什么，或聊聊你的小说…">${escape(draft)}</textarea><div class="chat-compose-bottom"><span>Enter 发送 <span class="chat-key-hint">· Shift + Enter 换行</span></span><button class="chat-send" id="chat-send" type="submit" aria-label="发送消息">${icon('send')}</button><button class="chat-send chat-stop" type="button" data-chat-action="stop" aria-label="停止回答" hidden>${icon('stop')}</button></div></form><p class="chat-footnote">${this.workId ? '可查阅这本小说的正文、大纲、设定及共享资料。' : '选择一本小说后，可以结合正文和大纲一起研究。'} <button data-action="go-view" data-view="library">打开文件库</button></p></div></section></div>`;
      this.paintMessages(true); this.paintComposer();
      const input = this.root.querySelector('#chat-prompt');
      input.oninput = () => { this.write(this.draftKey(), input.value); this.paintComposer(); input.style.height = 'auto'; input.style.height = Math.min(180, input.scrollHeight) + 'px'; };
      input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.send(); } };
      this.root.querySelector('#chat-form').onsubmit = event => { event.preventDefault(); this.send(); };
      this.root.querySelector('#chat-work').onchange = event => { const workId = Number(event.target.value) || null; if (this.conversation) this.fresh(workId); else { this.workId = workId; this.paint(); } };
      this.root.querySelector('#chat-model').onchange = event => { this.configId = Number(event.target.value); this.options.onConfigChange?.(this.configId); };
    }
    messageHTML(message) {
      const calls = activity(message.events), state = statusNames[message.status] || '';
      return `<article class="chat-message ${message.role}" data-message="${message.id}">${message.role === 'assistant' ? `<div class="chat-assistant-label">${icon('chat')} <span>小说研究助手</span></div>` : ''}<div class="chat-message-body">${message.role === 'user' ? escape(message.content).replaceAll('\n', '<br>') : markdown(message.content)}</div>${message.role === 'assistant' ? `<div class="chat-message-activity">${calls.length ? `<details><summary>${calls.filter(call => call.done).length}/${calls.length} 项资料查阅 <span>查看过程</span></summary><ol>${calls.map(call => `<li>${call.failed ? '!' : call.done ? '✓' : '·'} ${escape(call.label)}${call.failed ? '（未取得资料）' : ''}</li>`).join('')}</ol></details>` : ''}</div><p class="chat-message-error" ${message.error ? '' : 'hidden'}>${escape(message.error)}</p><div class="chat-message-meta"><span>${escape(state)}</span>${message.status !== 'running' && message.content ? `<button data-chat-action="copy" data-id="${message.id}">复制回答</button>` : ''}</div>` : ''}</article>`;
    }
    paintMessages(scroll = false) {
      if (!this.active()) return;
      const thread = this.root.querySelector('.chat-thread'); if (!thread) return;
      const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 100;
      thread.innerHTML = this.messages.length ? `<div class="chat-messages">${this.messages.map(message => this.messageHTML(message)).join('')}</div>` : `<div class="chat-welcome"><div class="chat-welcome-mark">${icon('chat')}</div><p class="chat-welcome-eyebrow">你的小说，值得认真研究</p><h2>从一个问题开始</h2><p>看榜单，读你的故事，找到下一步该改什么。</p><div class="chat-suggestions"><button data-chat-action="suggest" data-prompt="根据起点榜单，研究一下我的小说。从题材、市场定位和整体架构出发，直说最严重的问题；如果需要重写，给我具体方案。"><span>对照榜单研究本书</span><small>题材 · 读者 · 故事架构</small>${icon('arrow')}</button><button data-chat-action="suggest" data-prompt="从编辑角度检查我的开篇。先判断读者承诺和故事引擎，再看主角目标、冲突和信息负担。"><span>看看开篇有没有吸引力</span><small>承诺兑现 · 冲突 · 节奏</small>${icon('arrow')}</button><button data-chat-action="suggest" data-prompt="阅读我的大纲、人物和设定，帮我梳理接下来的剧情方向，并指出最值得解决的架构问题。"><span>一起梳理剧情方向</span><small>大纲 · 人物 · 设定</small>${icon('arrow')}</button></div></div>`;
      if (scroll || atBottom) thread.scrollTop = thread.scrollHeight;
    }
    paintComposer() {
      if (!this.active()) return;
      const busy = Boolean(this.sending || this.runningId), send = this.root.querySelector('#chat-send'), stop = this.root.querySelector('.chat-stop');
      if (!send) return; send.hidden = busy; stop.hidden = !busy;
      const input = this.root.querySelector('#chat-prompt'); input.disabled = Boolean(this.opening);
      send.disabled = this.opening || !input.value.trim();
    }
    async refreshHistory() { try { const result = await api('/research/conversations'); this.conversations = result.conversations; this.runningId = result.active_conversation_id; if (this.active()) { const sidebar = this.root.querySelector('.chat-history'); if (sidebar) sidebar.outerHTML = this.historyHTML(); this.paintComposer(); } } catch (error) { this.note(error.message, true); } }
    watch() {
      clearTimeout(this.poll);
      const id = this.conversation?.id;
      if (!this.messages.some(message => message.status === 'running') || this.sending || !this.active()) return;
      this.runningId = id; this.paintComposer();
      this.poll = setTimeout(async () => {
        try { const result = await api('/research/conversations/' + id + '/messages'); if (!this.active() || this.conversation?.id !== id) return; this.messages = result.messages; this.paintMessages(); if (!this.messages.some(message => message.status === 'running')) { this.runningId = null; this.paintComposer(); await this.refreshHistory(); } else this.watch(); }
        catch (error) { this.note(error.message, true); }
      }, 2000);
    }
    async send() {
      const input = this.root.querySelector('#chat-prompt'), prompt = input?.value.trim();
      if (!prompt || this.sending || this.runningId || this.opening) return;
      if (!this.configId) return this.note('请先在 AI 设置中连接一个模型。', true);
      this.sending = true; this.paintComposer(); this.note('');
      const selectedSequence = this.sequence, selectedDraft = this.draftKey(), configId = this.configId, workId = this.workId;
      let conversation = this.conversation, activeConversation, assistant;
      const turnMessages = this.messages;
      try {
        if (!conversation) conversation = await api('/research/conversations', { work_id: workId });
        activeConversation = conversation.id;
        this.write('novelking.agent.draft.' + activeConversation, prompt);
        if (this.sequence === selectedSequence) { this.conversation = conversation; this.write(storageKey, activeConversation); }
        const response = await fetch('/api/research/conversations/' + activeConversation + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, config_id: configId }) });
        if (!response.ok) throw Error((await response.json()).error || '无法开始回答');
        const reader = response.body.getReader(), decoder = new TextDecoder(), frames = window.NovelKingResearch.streamDecoder(); let ended = false;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          for (const event of frames.push(decoder.decode(value, { stream: true }))) {
            if (event.type === 'started') {
              assistant = { ...event.message, events: [] }; turnMessages.push(event.user, assistant); this.runningId = activeConversation;
              if (this.read(selectedDraft).trim() === prompt) this.write(selectedDraft, '');
              if (this.read('novelking.agent.draft.' + activeConversation).trim() === prompt) this.write('novelking.agent.draft.' + activeConversation, '');
              if (this.active() && this.sequence === selectedSequence) { this.conversation = event.conversation; this.messages = turnMessages; const currentInput = this.root.querySelector('#chat-prompt'); if (currentInput?.value.trim() === prompt) currentInput.value = ''; this.paintMessages(true); }
              await this.refreshHistory();
            }
            if (event.type === 'text' && assistant) assistant.content = event.text;
            if (event.type === 'activity' && assistant) assistant.events.push(event.event);
            if (event.type === 'notice') this.note(event.text);
            if (event.type === 'complete' || event.type === 'error') { ended = true; if (assistant) Object.assign(assistant, event.message); if (event.type === 'error') this.note(event.error, true); }
            if (assistant && this.active() && this.conversation?.id === activeConversation && ['text', 'activity', 'complete', 'error'].includes(event.type)) this.paintMessages();
          }
        }
        if (!ended) throw Error('连接中断，已保存的回答可在会话里重新打开。');
      } catch (error) {
        this.note(error.message, true);
        // Keep the original draft on preflight errors. Streaming failures are
        // recovered from the durable server message instead of duplicated text.
        if (assistant && activeConversation && this.active() && this.conversation?.id === activeConversation) {
          try { this.messages = (await api('/research/conversations/' + activeConversation + '/messages')).messages; this.paintMessages(); } catch {}
        }
      } finally {
        this.sending = false; this.runningId = null; this.paintComposer(); await this.refreshHistory(); this.watch(); window.NovelKingPlatform?.refreshBalance();
      }
    }
    async showSettings() {
      this.settings?.remove();
      const overlay = document.createElement('div'); overlay.className = 'agent-settings-backdrop';
      overlay.innerHTML = `<section class="agent-settings-dialog" role="dialog" aria-modal="true" aria-label="AI 设置"><div class="agent-settings-head"><h2>AI 设置</h2><button class="chat-icon-button" aria-label="关闭 AI 设置">${icon('close')}</button></div><div class="agent-settings-content"></div></section>`;
      document.body.append(overlay); this.settings = overlay;
      const close = async () => { overlay.remove(); this.settings = null; document.removeEventListener('keydown', this.settingsEscape); try { this.configs = await api('/api_configs'); if (this.active()) this.paint(); } catch (error) { this.note(error.message, true); } };
      overlay.querySelector('.agent-settings-head button').onclick = close;
      overlay.onclick = event => { if (event.target === overlay) close(); };
      this.settingsEscape = event => { if (event.key === 'Escape' && !document.querySelector('#modal-root .modal')) close(); };
      document.addEventListener('keydown', this.settingsEscape);
      await window.NovelKingResearch.mount(overlay.querySelector('.agent-settings-content'), { works: this.works, configs: this.configs, activeConfigId: this.configId, workId: this.workId, tab: 'models', settingsOnly: true,
        onUseSkill: async id => { await close(); const input = this.root.querySelector('#chat-prompt'); if (input) { input.value = `请使用 ${id} 技能研究我的小说，并引用你查到的资料。`; this.write(this.draftKey(), input.value); this.paintComposer(); input.focus(); } } });
      overlay.querySelector('.agent-settings-head button')?.focus();
    }
    async click(event) {
      const button = event.target.closest('[data-chat-action]'); if (!button) return;
      const action = button.dataset.chatAction, id = button.dataset.id;
      try {
        if (action === 'reload') return this.load();
        if (action === 'new') return this.fresh();
        if (action === 'open') return this.open(id);
        if (action === 'history') return this.root.querySelector('.chat-workspace').classList.toggle('history-open');
        if (action === 'settings') return this.showSettings();
        if (action === 'stop') { const selected = this.runningId || this.conversation?.id; if (selected) await api('/research/conversations/' + selected + '/cancel', {}); return; }
        if (action === 'suggest') { const input = this.root.querySelector('#chat-prompt'); input.value = button.dataset.prompt; this.write(this.draftKey(), input.value); this.paintComposer(); input.focus(); return; }
        if (action === 'copy') { await navigator.clipboard.writeText(this.messages.find(message => message.id === id)?.content || ''); return this.note('回答已复制'); }
        if (action === 'rename') { const title = prompt('会话名称', this.conversations.find(conversation => conversation.id === id)?.title); if (title) { const changed = await api('/research/conversations/' + id, { title }, 'PATCH'); if (this.conversation?.id === id) this.conversation = changed; await this.refreshHistory(); this.paint(); } }
        if (action === 'delete' && confirm('只删除这段聊天记录？小说和文件库内容会保留。')) { await api('/research/conversations/' + id, null, 'DELETE'); if (this.conversation?.id === id) this.fresh(); await this.refreshHistory(); }
      } catch (error) { this.note(error.message, true); }
    }
  }
  window.NovelKingChat = { markdown, activity,
    async mount(root, options = {}) { if (!root.isConnected) return; current?.dispose(); current = new Chat(root, options); await current.load(); },
    dispose() { current?.dispose(); current = null; }
  };
})();
