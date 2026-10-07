/* File library: manual organization; uploading never changes novel chapters or character cards. */
(() => {
  const accountLocalStorage = window.NovelKingAccount?.localStorage || localStorage;
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icons = ['◇', '♙', '☷', '▤', '▥', '✎', '⌕', '↗', '✦', '▱'];
  const descriptions = ['地图、势力、体系与历史', '人物档案、关系与成长', '总纲、卷纲、场景与伏笔', '草稿、修订与发布版本', '一书一夹，保存原文与笔记', '开篇、节奏、对白与结构', '查证知识，积累真实细节', '三江、新书与其他榜单记录', '片段、台词、图片与随手记', '书名、简介、投稿与反馈'];
  const sizeLabel = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  const readLabel = { ready: '可读可搜索', original: '仅保留原件', error: '提取失败 · 原件保留' };
  const button = (label, action, id = '', extra = '') => `<button type="button" class="btn secondary small" data-fl-action="${action}" data-id="${escapeHTML(id)}" ${extra}>${label}</button>`;
  const formField = (label, input) => `<label class="fl-field"><span>${label}</span>${input}</label>`;
  const locationKey = 'novelking.fileLibrary.location';
  const readStored = key => { try { return JSON.parse(accountLocalStorage.getItem(key)); } catch { return null; } };
  const writeStored = (key, value) => { try { accountLocalStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  let current;
  class FileLibrary {
    constructor(root, options) {
      this.root = root; this.options = options; this.area = ''; this.folderId = ''; this.scope = options.workId ? String(options.workId) : 'all';
      const previous = readStored(locationKey);
      if (previous && (!options.workId || previous.scope === String(options.workId))) {
        this.scope = previous.scope; this.area = previous.area || ''; this.folderId = previous.folderId || ''; this.selectedId = previous.selectedId || '';
      }
      this.query = ''; this.trash = false; this.offset = 0; this.queue = []; this.sequence = 0; this.disposed = false;
      this.dirty = false; this.readerSequence = 0;
      this.listener = event => this.onClick(event);
      root.addEventListener('click', this.listener);
      this.dragOver = event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); root.classList.add('fl-dragging'); } };
      this.dragLeave = event => { if (!root.contains(event.relatedTarget)) root.classList.remove('fl-dragging'); };
      this.drop = event => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); root.classList.remove('fl-dragging'); this.enqueue([...event.dataTransfer.files]); };
      root.addEventListener('dragover', this.dragOver); root.addEventListener('dragleave', this.dragLeave); root.addEventListener('drop', this.drop);
      this.beforeUnload = event => { if (this.dirty) { this.keepDraft(); event.preventDefault(); event.returnValue = ''; } };
      window.addEventListener('beforeunload', this.beforeUnload);
    }
    dispose() {
      this.disposed = true; this.sequence++;
      this.keepDraft(); clearTimeout(this.saveTimer); this.readerSequence++;
      window.removeEventListener('beforeunload', this.beforeUnload);
      this.root.removeEventListener('click', this.listener); this.root.removeEventListener('dragover', this.dragOver); this.root.removeEventListener('dragleave', this.dragLeave); this.root.removeEventListener('drop', this.drop);
      this.dialog?.remove();
      this.root.classList.remove('fl-root', 'fl-dragging');
      for (const item of this.queue) { if (item.status === '等待上传') item.status = '已取消'; }
      this.controller?.abort();
    }
    active() { return !this.disposed && this.options.isActive(); }
    parameters(extra = {}) {
      return new URLSearchParams({ ...(this.scope === 'shared' ? { scope: 'shared' } : this.scope !== 'all' ? { work_id: this.scope } : {}), ...extra }).toString();
    }
    async call(route, method = 'GET', body) { return this.options.request('/files' + route, { method, ...(body ? { body } : {}) }); }
    async render() {
      if (!(await this.flush())) return;
      const sequence = ++this.sequence;
      try {
        if (!this.allWorks) this.allWorks = (await this.call('/status')).works;
        if (!['all', 'shared', ...this.allWorks.map(work => String(work.id))].includes(this.scope)) { this.scope = 'all'; this.area = ''; this.folderId = ''; this.selectedId = ''; }
        const status = await this.call('/status?' + this.parameters());
        const listing = this.area || this.trash ? await this.call('?' + this.parameters({ ...(this.area ? { area: this.area } : {}), ...(this.query ? { q: this.query } : !this.trash ? { folder_id: this.folderId } : {}), ...(this.trash ? { trash: '1' } : {}), offset: String(this.offset) })) : null;
        if (sequence !== this.sequence || !this.active()) return;
        this.status = status; this.listing = listing;
        if (sequence !== this.sequence || !this.active()) return;
        const area = status.areas.find(entry => entry.id === this.area);
        if (this.area && !area) { this.area = ''; return this.render(); }
        const owner = this.scope === 'shared' ? '共享资料' : this.allWorks.find(work => String(work.id) === this.scope)?.title || '文件库';
        this.owner = owner;
        this.rememberLocation();
        this.root.classList.add('fl-root');
        this.root.innerHTML = `<section class="fl-library">
          <header class="fl-header"><div><div class="fl-eyebrow">文件库${this.scope !== 'all' ? ' / ' + escapeHTML(owner) : ''}</div><h1>${escapeHTML(this.trash ? '回收站' : area?.name || owner)}</h1><p>${this.scope === 'all' ? '先选一本小说，再整理它的设定、大纲和参考。' : this.trash ? '误删的资料可以恢复到原位置。' : area ? descriptions[status.areas.indexOf(area)] : '这里的资料属于' + escapeHTML(owner) + '。'}</p></div><div class="fl-header-actions">${this.scope !== 'all' ? button('切换小说', 'novels') : ''}${this.area || this.trash ? button('资料分区', 'home') : this.scope !== 'all' ? button('回收站', 'trash') : ''}${button('刷新', 'refresh')}</div></header>
          ${this.scope === 'all' ? this.novelsHTML() : listing ? this.filesHTML(area) : this.dashboardHTML()}
          <div class="fl-upload-queue" aria-live="polite"></div>
          ${!listing ? `<details class="fl-legacy"><summary>旧版资料导入</summary><p>已有的旧资料登记保留在原入口。</p>${button('打开旧版资料库', 'legacy')}</details>` : ''}
          <input type="file" multiple data-fl-picker hidden>
        </section>`;
        this.root.querySelector('[data-fl-picker]').addEventListener('change', event => this.enqueue([...event.target.files]));
        this.root.querySelector('[data-fl-area]')?.addEventListener('change', async event => { if (!(await this.flush())) { event.target.value = this.area; return; } this.area = event.target.value; this.folderId = ''; this.query = ''; this.selectedId = ''; this.offset = 0; this.render(); });
        this.root.querySelector('[data-fl-search]')?.addEventListener('submit', async event => { event.preventDefault(); if (!(await this.flush())) return; this.query = new FormData(event.target).get('q').trim(); this.offset = 0; this.selectedId = ''; this.render(); });
        this.paintQueue();
        if (listing && !this.trash) {
          const first = listing.files.find(file => file.id === this.selectedId) || listing.files[0];
          this.page = null;
          if (first) await this.reader(first.id); else { this.selectedId = ''; this.rememberLocation(); }
        } else this.page = null;
      } catch (error) {
        if (this.active() && sequence === this.sequence) { this.options.toast(error.message); if (!this.root.querySelector('.fl-library')) this.root.innerHTML = '<div class="empty">文件库加载失败，请重新进入。</div>'; }
      }
    }
    rememberLocation() { writeStored(locationKey, { scope: this.scope, area: this.area, folderId: this.folderId, selectedId: this.selectedId }); }
    novelsHTML() {
      const card = (id, title, count, detail, recent = '') => `<button class="fl-novel-card" data-fl-action="scope-card" data-id="${id}"><span class="fl-novel-cover">${id === 'shared' ? '▱' : escapeHTML(title.slice(0, 1))}</span><strong>${escapeHTML(title)}</strong><span>${count} 份资料</span><small>${escapeHTML(detail)}</small>${recent ? `<small>最近章节：${escapeHTML(recent)}</small>` : ''}<span class="fl-novel-enter">打开资料库 →</span></button>`;
      return `<div class="fl-section-title"><h2>小说资料库</h2><span>每本小说单独存放</span></div><div class="fl-novel-grid">${this.status.works.map(work => card(work.id, work.title, work.total_files, `${work.characters} 人物 · ${work.settings} 设定 · ${work.chapters} 章`, work.recent_chapter?.title)).join('') || '<div class="fl-empty">还没有小说，先到书架新建作品。</div>'}</div><div class="fl-section-title"><h2>共享资料</h2><span>多本小说通用的参考与素材</span></div><div class="fl-novel-grid fl-shared-grid">${card('shared', '共享资料', this.status.shared_files, '写作技法、研究资料、通用素材')}</div>`;
    }
    dashboardHTML() {
      const status = this.status;
      const works = this.scope === 'shared' ? [] : status.works;
      const totalCharacters = works.reduce((sum, work) => sum + work.characters, 0), settings = works.reduce((sum, work) => sum + work.settings, 0);
      return `<div class="fl-overview"><div><strong>${status.total_files}</strong><span>资料文件</span></div><div><strong>${status.books}</strong><span>参考书资料夹</span></div><div><strong>${totalCharacters}</strong><span>作品人物</span></div><div><strong>${settings}</strong><span>作品设定条目</span></div></div>
        <div class="fl-section-title"><h2>资料分区</h2><span>选一个分区，上传或整理资料</span></div>
        <div class="fl-area-grid">${status.areas.map((area, index) => `<button class="fl-area-card" data-fl-action="area" data-id="${area.id}"><span class="fl-area-icon">${icons[index]}</span><span class="fl-area-name">${area.name}</span><span class="fl-area-description">${descriptions[index]}</span><span class="fl-area-count">${area.count} 份资料 <span>→</span></span></button>`).join('')}</div>
        ${works.length ? `<section class="fl-work-overview"><div class="fl-section-title"><h2>作品进度</h2><span>来自已保存的作品和画布</span></div>${works.map(work => `<div class="fl-work-row"><strong>${escapeHTML(work.title)}</strong><span>${work.chapters} 章 · ${work.characters} 人物 · ${work.settings} 设定 · ${work.canvas_nodes} 个画布元素</span><small>最近编辑：${escapeHTML(work.recent_chapter?.title || '暂无章节')}</small></div>`).join('')}</section>` : ''}`;
    }
    folderPath(id, folders = this.listing?.folders || []) {
      const names = [], visited = new Set(); let folder = folders.find(entry => entry.id === id);
      while (folder && !visited.has(folder.id)) { visited.add(folder.id); names.unshift(folder.name); folder = folders.find(entry => entry.id === folder.parent_id); }
      return names.join(' / ');
    }
    filesHTML(area) {
      if (this.trash) return this.archiveHTML();
      const { files, folders, total, next_offset } = this.listing;
      const tree = (parent = null, depth = 0) => depth > 32 ? '' : folders.filter(folder => folder.parent_id === parent).map(folder => `<div class="fl-folder-row" style="--folder-depth:${depth}"><button class="${folder.id === this.folderId ? 'selected' : ''}" data-fl-action="folder" data-id="${folder.id}" title="${escapeHTML(folder.name)}">▱ ${escapeHTML(folder.name)}</button><button data-fl-action="edit-folder" data-id="${folder.id}" aria-label="管理${escapeHTML(folder.name)}">⋯</button></div>${tree(folder.id, depth + 1)}`).join('');
      return `<div class="fl-workspace"><aside class="fl-catalog"><div class="fl-catalog-top"><label class="fl-field"><span>资料分区</span><select data-fl-area aria-label="资料分区">${this.status.areas.map(entry => `<option value="${entry.id}" ${entry.id === this.area ? 'selected' : ''}>${entry.name} · ${entry.count}</option>`).join('')}</select></label><div class="fl-catalog-actions"><button class="btn" data-fl-action="upload">＋ 上传文件</button>${button('新建目录', 'new-folder')}</div><form data-fl-search class="fl-search"><input name="q" value="${escapeHTML(this.query)}" placeholder="搜索本分区…" aria-label="搜索资料"><button type="submit" class="btn secondary small" aria-label="搜索">⌕</button></form>${this.query ? button('清除搜索', 'clear-search') : ''}</div>
        <details class="fl-catalog-folders" ${innerWidth > 650 ? 'open' : ''}><summary>文件夹${this.folderId ? ' / ' + escapeHTML(this.folderPath(this.folderId)) : ''}</summary><button class="fl-root-folder ${!this.folderId ? 'selected' : ''}" data-fl-action="folder" data-id="">▱ 分区根目录</button>${tree()}</details>
        <div class="fl-catalog-heading"><strong>${escapeHTML(this.query ? '搜索结果' : this.folderPath(this.folderId) || area.name)}</strong><span>${total} 份</span></div><div class="fl-catalog-files">${files.map(file => `<button class="fl-document-card ${file.id === this.selectedId ? 'selected' : ''}" data-fl-action="read" data-id="${file.id}"><span class="fl-file-icon">${escapeHTML(file.name.split('.').pop().slice(0, 5).toUpperCase())}</span><span><strong>${escapeHTML(file.name)}</strong><small>${file.has_edits ? '已编辑' : readLabel[file.read_status]} · ${sizeLabel(file.size)}</small></span></button>`).join('') || '<p class="fl-tree-hint">这个目录还没有资料。</p>'}</div><div class="fl-catalog-pagination">${this.offset ? button('上一页', 'previous') : ''}${next_offset !== null ? button('下一页', 'next') : ''}</div></aside>
        <section class="fl-document" aria-label="资料编辑区"><div data-fl-document>${files.length ? '<div class="fl-empty">正在打开资料…</div>' : `<div class="fl-upload-empty fl-drop-zone"><span>▱</span><h2>${this.query ? '没有找到相关资料' : '把资料放到这里'}</h2><p>${this.query ? '换一个关键词，或清除搜索。' : '拖入设定、大纲或参考文件，上传后直接阅读和编辑。'}</p>${this.query ? button('清除搜索', 'clear-search') : '<button class="btn" data-fl-action="upload">选择文件上传</button>'}<small>TXT / Markdown / Word / PDF / 图片 · 单文件 ≤ 20 MB</small></div>`}</div></section></div>`;
    }
    archiveHTML() {
      const { files, folders, total, next_offset } = this.listing;
      const tree = (parent = null, depth = 0) => depth > 32 ? '' : folders.filter(folder => folder.parent_id === parent).map(folder => `<div class="fl-folder-row" style="--folder-depth:${depth}"><button class="${folder.id === this.folderId ? 'selected' : ''}" data-fl-action="folder" data-id="${folder.id}" title="${escapeHTML(folder.name)}"><span>${folder.kind === 'book' ? '▥' : '▱'}</span> ${escapeHTML(folder.name)}</button><button data-fl-action="edit-folder" data-id="${folder.id}" aria-label="管理${escapeHTML(folder.name)}">⋯</button></div>${tree(folder.id, depth + 1)}`).join('');
      return `<div class="fl-browser">${!this.trash ? `<aside class="fl-folder-panel"><details class="fl-folder-details" ${innerWidth > 650 ? 'open' : ''}><summary class="fl-folder-heading"><strong>文件夹</strong>${button('＋', 'new-folder', '', 'aria-label="新建文件夹"')}</summary><button class="fl-root-folder ${!this.folderId ? 'selected' : ''}" data-fl-action="folder" data-id="">▱ 分区根目录</button>${tree()}${!folders.length ? '<p class="fl-tree-hint">目录由你决定。可以按设定主题、卷或参考书建立子文件夹。</p>' : ''}</details></aside>` : ''}
        <section class="fl-file-panel"><div class="fl-list-toolbar"><div class="fl-breadcrumb">${escapeHTML(this.trash ? '已删除的文件' : area.name)}${this.folderId ? ' / ' + escapeHTML(this.folderPath(this.folderId)) : ''}</div><div class="fl-toolbar-actions">${!this.trash ? `${button('新建文件夹', 'new-folder')}<button class="btn" data-fl-action="upload">＋ 上传文件</button>` : ''}</div></div>
          <form data-fl-search class="fl-search"><input name="q" value="${escapeHTML(this.query)}" placeholder="搜索文件名或正文…" aria-label="搜索资料"><button class="btn secondary" type="submit">搜索</button>${this.query ? button('清除', 'clear-search') : ''}</form>
          ${!this.trash ? '<div class="fl-drop-zone">拖入文件到这里，或点击「上传文件」<small>TXT / Markdown / Word / PDF / 图片等 · 单文件 ≤ 20 MB</small></div>' : ''}
          <div class="fl-file-list">${files.map(file => `<article class="fl-file-row"><button class="fl-file-open" data-fl-action="read" data-id="${file.id}" ${this.trash ? 'disabled' : ''}><span class="fl-file-icon">${escapeHTML(file.name.split('.').pop().slice(0, 5).toUpperCase())}</span><span><strong>${escapeHTML(file.name)}</strong><small>${sizeLabel(file.size)} · ${escapeHTML(this.allWorks.find(work => work.id === file.work_id)?.title || '共享资料')}${this.query || this.trash ? ' · ' + escapeHTML(this.folderPath(file.folder_id) || '根目录') : ''}</small></span></button><span class="fl-read-status ${file.read_status}">${readLabel[file.read_status]}</span><time>${escapeHTML(file.updated_at.slice(0, 16))}</time><div class="fl-row-actions">${this.trash ? button('恢复', 'restore', file.id) : button('管理', 'manage', file.id)}</div></article>`).join('') || `<div class="fl-empty"><span>▱</span><strong>${this.query ? '没有找到相关资料' : this.trash ? '回收站是空的' : '这里还没有文件'}</strong><p>${this.query ? '可以换个关键词，或清除搜索查看文件。' : this.trash ? '删除的文件会保留在这里。' : '把文件放到当前目录。文件名和内容都会保留。'}</p></div>`}</div>
          <div class="fl-list-footer"><span>共 ${total} 个文件${this.query ? ' · 搜索当前分区的全部目录' : ''}</span><div>${this.offset ? button('上一页', 'previous') : ''}${next_offset !== null ? button('下一页', 'next') : ''}</div></div>
        </section></div>`;
    }
    async onClick(event) {
      if (!this.active()) return;
      const element = event.target.closest('[data-fl-action]'); if (!element || !this.root.contains(element)) return;
      event.preventDefault(); event.stopPropagation();
      const { flAction: action, id } = element.dataset;
      try {
        if (!['save', 'format', 'download-draft', 'reload-document', 'clear-queue', 'cancel-upload', 'retry-upload', 'read'].includes(action) && !(await this.flush())) return;
        if (action === 'scope-card' || action === 'novels') { this.scope = action === 'novels' ? 'all' : id; this.area = ''; this.trash = false; this.folderId = ''; this.query = ''; this.offset = 0; this.selectedId = ''; return this.render(); }
        if (action === 'save') return this.flush();
        if (action === 'download-draft') return this.downloadDraft();
        if (action === 'reload-document') {
          if (!confirm('读取服务器最新版本会放弃当前未保存的编辑稿及本地草稿。请先下载需要保留的编辑稿。确定读取最新版本？')) return;
          this.removeDraft(); this.dirty = false; this.conflict = false; return this.reader(this.selectedId);
        }
        if (action === 'format') { const editor = this.root.querySelector('[data-fl-editor]'); this.options.editor.format(editor, element.dataset.format); this.changed(); return; }
        if (action === 'home') { this.area = ''; this.trash = false; this.folderId = ''; this.query = ''; this.offset = 0; return this.render(); }
        if (action === 'area') { this.area = id; this.folderId = ''; this.query = ''; this.trash = false; this.offset = 0; return this.render(); }
        if (action === 'folder') { this.folderId = id; this.query = ''; this.offset = 0; this.selectedId = ''; return this.render(); }
        if (action === 'trash') { this.area = ''; this.trash = true; this.folderId = ''; this.query = ''; this.offset = 0; return this.render(); }
        if (action === 'clear-search') { this.query = ''; this.offset = 0; return this.render(); }
        if (action === 'next' || action === 'previous') { this.offset = action === 'next' ? this.listing.next_offset : Math.max(0, this.offset - 100); return this.render(); }
        if (action === 'refresh') { this.allWorks = null; return this.render(); }
        if (action === 'legacy') { this.dispose(); this.root.classList.remove('fl-root'); return this.options.showLegacy(); }
        if (action === 'upload') { if (this.scope === 'all') return this.options.toast('请先选择共享资料或所属作品，再上传。'); return this.root.querySelector('[data-fl-picker]').click(); }
        if (action === 'new-folder') return this.folderDialog();
        if (action === 'edit-folder') return this.folderDialog(this.listing.folders.find(folder => folder.id === id));
        if (action === 'read') return this.reader(id);
        if (action === 'manage') return this.manageDialog(this.listing.files.find(file => file.id === id));
        if (action === 'restore') { await this.call(`/${id}/restore`, 'POST'); this.options.toast('资料已恢复到原目录'); return this.render(); }
        if (action === 'cancel-upload') { const item = this.queue.find(entry => entry.id === id); if (item.status === '上传中') this.controller?.abort(); else item.status = '已取消'; this.paintQueue(); }
        if (action === 'retry-upload') { this.queue.find(entry => entry.id === id).status = '等待上传'; this.runQueue(); }
        if (action === 'clear-queue') { this.queue = this.queue.filter(item => ['等待上传', '上传中'].includes(item.status)); this.paintQueue(); }
      } catch (error) { this.options.toast(error.message); }
    }
    showDialog(title, html, onSubmit) {
      this.dialog?.remove();
      const dialog = document.createElement('dialog'); dialog.className = 'fl-dialog';
      dialog.innerHTML = `<form class="fl-dialog-form"><header><h2>${escapeHTML(title)}</h2><button type="button" class="fl-close" aria-label="关闭">×</button></header><div class="fl-dialog-body">${html}</div>${onSubmit ? '<footer><span class="fl-form-error" role="alert"></span><button type="submit" class="btn">保存</button></footer>' : ''}</form>`;
      document.body.append(dialog); this.dialog = dialog;
      const close = () => { dialog.close(); dialog.remove(); };
      dialog.querySelector('.fl-close').addEventListener('click', close);
      dialog.addEventListener('cancel', () => { dialog.remove(); });
      dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
      dialog.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault(); if (!onSubmit) return;
        const submit = dialog.querySelector('[type=submit]'); submit.disabled = true;
        try { await onSubmit(new FormData(event.target)); close(); await this.render(); }
        catch (error) { dialog.querySelector('.fl-form-error').textContent = error.message; }
        finally { submit.disabled = false; }
      });
      dialog.showModal(); return dialog;
    }
    folderDialog(folder) {
      if (!folder && this.scope === 'all') return this.options.toast('请先选择共享资料或所属作品，再建立文件夹。');
      const area = this.status.areas.find(entry => entry.id === this.area);
      const suggestions = area.suggestions.map(name => `<option value="${escapeHTML(name)}">`).join('');
      const location = `<option value="">分区根目录</option>${this.listing.folders.filter(entry => entry.id !== folder?.id && entry.work_id === (folder ? folder.work_id : this.scope === 'shared' ? null : Number(this.scope))).map(entry => `<option value="${entry.id}" ${(folder ? folder.parent_id : this.folderId) === entry.id ? 'selected' : ''}>${escapeHTML(this.folderPath(entry.id))}</option>`).join('')}`;
      const dialog = this.showDialog(folder ? '管理文件夹' : '新建文件夹', `${formField('名称', `<input name="name" list="fl-folder-suggestions" maxlength="240" required value="${escapeHTML(folder?.name || '')}" placeholder="例如：${escapeHTML(area.suggestions[0])}"><datalist id="fl-folder-suggestions">${suggestions}</datalist>`)}${formField('上级目录', `<select name="parent_id">${location}</select>`)}${!folder && this.area === 'books' ? `${formField('类型', '<select name="kind"><option value="book">书籍资料夹（计为一本参考书）</option><option value="folder">普通文件夹</option></select>')}${formField('来源', '<select name="source"><option value="manual">自行添加</option><option value="sanjiang">三江榜</option><option value="newbooks">新书榜</option></select>')}` : ''}${folder ? '<button type="button" class="btn danger" data-fl-delete-folder>删除空文件夹</button>' : ''}`, async form => {
        const body = { name: form.get('name'), parent_id: form.get('parent_id') || null };
        await this.call(folder ? `/folders/${folder.id}` : '/folders', folder ? 'PATCH' : 'POST', folder ? body : { ...body, area: this.area, work_id: this.scope === 'shared' ? null : Number(this.scope), kind: form.get('kind') || 'folder', source: form.get('source') || 'manual' });
      });
      dialog.querySelector('[data-fl-delete-folder]')?.addEventListener('click', async () => {
        try { await this.call(`/folders/${folder.id}`, 'DELETE'); if (this.folderId === folder.id) this.folderId = folder.parent_id || ''; dialog.remove(); this.render(); }
        catch (error) { dialog.querySelector('.fl-form-error').textContent = error.message; }
      });
    }
    manageDialog(file) {
      const locations = this.listing.folders.filter(folder => folder.work_id === file.work_id).map(folder => `<option value="${folder.id}" ${file.folder_id === folder.id ? 'selected' : ''}>${escapeHTML(this.folderPath(folder.id))}</option>`).join('');
      const dialog = this.showDialog('管理资料', `${formField('文件名', `<input name="name" required maxlength="240" value="${escapeHTML(file.name)}">`)}${formField('资料分区', `<select name="area">${this.status.areas.map(area => `<option value="${area.id}" ${area.id === file.area ? 'selected' : ''}>${area.name}</option>`).join('')}</select>`)}${formField('所属作品', `<select name="work_id"><option value="">共享资料</option>${this.allWorks.map(work => `<option value="${work.id}" ${work.id === file.work_id ? 'selected' : ''}>${escapeHTML(work.title)}</option>`).join('')}</select>`)}${formField('移动到文件夹', `<select name="folder_id"><option value="">分区根目录</option>${locations}</select>`)}<p class="muted">移动只改变位置，原件和内容保持完整。</p><button type="button" class="btn danger" data-fl-delete-file>移入回收站</button>`, async form => this.call(`/${file.id}`, 'PATCH', { name: form.get('name'), area: form.get('area'), work_id: form.get('work_id') ? Number(form.get('work_id')) : null, folder_id: form.get('folder_id') || null }));
      let locationRequest = 0;
      const refreshFolders = async () => {
        const sequence = ++locationRequest, form = dialog.querySelector('form'), destination = form.elements.folder_id, submit = form.querySelector('[type=submit]');
        submit.disabled = true; destination.disabled = true;
        try {
          const area = form.elements.area.value, owner = form.elements.work_id.value;
          const result = await this.call('?' + new URLSearchParams({ area, ...(owner ? { work_id: owner } : { scope: 'shared' }) }));
          if (sequence !== locationRequest || !dialog.isConnected) return;
          destination.innerHTML = '<option value="">分区根目录</option>' + result.folders.map(folder => `<option value="${folder.id}">${escapeHTML(this.folderPath(folder.id, result.folders))}</option>`).join('');
          dialog.querySelector('.fl-form-error').textContent = '';
          submit.disabled = false;
        } catch (error) { if (sequence === locationRequest) dialog.querySelector('.fl-form-error').textContent = error.message; }
        finally { if (sequence === locationRequest) destination.disabled = false; }
      };
      dialog.querySelector('[name=area]').addEventListener('change', refreshFolders);
      dialog.querySelector('[name=work_id]').addEventListener('change', refreshFolders);
      dialog.querySelector('[data-fl-delete-file]').addEventListener('click', async () => { try { await this.call(`/${file.id}`, 'DELETE'); dialog.remove(); this.options.toast('已移入回收站，可恢复'); this.render(); } catch (error) { dialog.querySelector('.fl-form-error').textContent = error.message; } });
    }
    async reader(id) {
      if (!(await this.flush())) return;
      const sequence = ++this.readerSequence;
      this.selectedId = id; this.rememberLocation(); this.page = null; this.dirty = false; this.conflict = false; this.composing = false;
      this.root.querySelectorAll('.fl-document-card').forEach(card => { card.classList.toggle('selected', card.dataset.id === id); card.setAttribute('aria-current', card.dataset.id === id ? 'true' : 'false'); });
      const container = this.root.querySelector('[data-fl-document]'); if (!container) return;
      container.innerHTML = '<div class="fl-empty">正在打开资料…</div>';
      try {
        const page = await this.call(`/${id}/edit?` + this.parameters());
        if (!this.active() || sequence !== this.readerSequence || !container.isConnected) return;
        this.page = page;
        const parameters = this.parameters(), draft = readStored(this.draftKey());
        const hasDraft = draft && draft.scope === this.scope && typeof draft.html === 'string' && typeof draft.text === 'string';
        const html = this.options.editor.sanitize(hasDraft ? draft.html : page.html === null ? this.options.editor.fromText(page.text) : page.html);
        this.dirty = !!hasDraft; this.conflict = !!hasDraft && draft.revision !== page.revision;
        container.innerHTML = `<header class="fl-document-header"><div><span>${escapeHTML(this.folderPath(page.folder_id) || '分区根目录')}</span><h2>${escapeHTML(page.name)}</h2></div><div class="fl-document-actions">${button('管理', 'manage', id)}<details class="fl-download-menu"><summary>下载 ▾</summary><a href="/api/files/${id}/original?${parameters}" download>上传原件</a>${page.editable ? `<a href="/api/files/${id}/export?${parameters}" download>已保存的文字稿 TXT</a>${button('当前编辑稿 TXT', 'download-draft')}` : ''}</details></div></header>
          ${page.editable ? `<div class="fl-editor-toolbar">${[['B','粗体'],['I','斜体'],['U','下划线'],['H2','标题'],['BLOCKQUOTE','引用'],['insertUnorderedList','列表'],['insertOrderedList','编号']].map(([format,label]) => button(label, 'format', '', `data-format="${format}"`)).join('')}<button class="btn small" data-fl-action="save">保存</button></div><div class="fl-editor-scroll"><div class="fl-editor-page"><div class="editor-content fl-editor-content" data-fl-editor contenteditable="true" role="textbox" aria-label="资料正文" aria-multiline="true" data-placeholder="写下你的设定或笔记…">${html}</div></div></div><footer class="fl-editor-status"><span data-fl-save-status role="status">${hasDraft ? '已恢复本地编辑稿，等待保存' : '已保存'}</span><span data-fl-word-count></span><span>Ctrl / Cmd S 保存</span></footer><div class="fl-save-recovery" data-fl-save-recovery hidden>${button('下载当前编辑稿', 'download-draft')}${button('读取服务器最新版本', 'reload-document')}</div>` : `<div class="fl-original-preview">${/\.(png|jpe?g|webp|gif)$/i.test(page.original_name || page.name) ? `<img class="fl-reader-image" alt="${escapeHTML(page.name)}" src="/api/files/${id}/preview?${parameters}">` : '<span class="fl-preview-symbol">▱</span>'}<h3>${escapeHTML(page.read_error || '此格式暂不支持文字编辑')}</h3><p>可以下载上传原件，或在左侧上传文字版。</p></div>`}`;
        const editor = container.querySelector('[data-fl-editor]');
        container.querySelector('img')?.addEventListener('error', event => { event.target.remove(); container.querySelector('h3').textContent = '图片无法预览，可以下载原件检查。'; });
        if (editor) {
          this.updateCount();
          editor.addEventListener('input', () => this.changed());
          editor.addEventListener('compositionstart', () => { this.composing = true; clearTimeout(this.saveTimer); });
          editor.addEventListener('compositionend', () => { this.composing = false; this.changed(); });
          editor.addEventListener('paste', event => { event.preventDefault(); document.execCommand('insertHTML', false, this.options.editor.fromText(event.clipboardData.getData('text/plain'))); this.changed(); });
          editor.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) return; event.preventDefault(); document.execCommand('insertHTML', false, this.options.editor.fromText(event.dataTransfer.getData('text/plain'))); this.changed(); });
          editor.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!event.isComposing) this.flush(); } });
          container.querySelectorAll('[data-fl-action=format]').forEach(item => item.addEventListener('mousedown', event => event.preventDefault()));
          if (hasDraft) { this.keepDraft(); if (this.conflict) this.saveStatus('本地稿与服务器版本不同，请先下载编辑稿，再读取最新版本', true); else this.saveTimer = setTimeout(() => this.flush(), 900); }
        }
      } catch (error) {
        if (this.active() && sequence === this.readerSequence && container.isConnected) container.innerHTML = `<div class="fl-empty"><p>${escapeHTML(error.message)}</p>${button('重新打开', 'read', id)}</div>`;
      }
    }
    editorSnapshot() {
      const editor = this.root.querySelector('[data-fl-editor]');
      return editor && this.page ? { html: this.options.editor.sanitize(editor.innerHTML), text: editor.innerText.replace(/\r\n/g, '\n'), revision: this.page.revision, scope: this.scope } : null;
    }
    draftKey() { return 'novelking.fileLibrary.draft.' + this.selectedId; }
    keepDraft() {
      const snapshot = this.dirty && this.editorSnapshot();
      if (snapshot && !writeStored(this.draftKey(), snapshot) && !this.storageWarning) { this.storageWarning = true; this.options.toast('浏览器无法保存本地草稿，请先保存到服务器或下载编辑稿。'); }
    }
    removeDraft() { try { accountLocalStorage.removeItem(this.draftKey()); } catch { /* The original and server edit are independent of local storage. */ } }
    updateCount() { const counter = this.root.querySelector('[data-fl-word-count]'), editor = this.root.querySelector('[data-fl-editor]'); if (counter && editor) counter.textContent = `${editor.innerText.replace(/\s/g, '').length} 字`; }
    changed() {
      this.dirty = true; this.keepDraft(); this.updateCount(); clearTimeout(this.saveTimer);
      if (!this.conflict) { this.saveStatus('未保存 · 自动保存中'); if (!this.composing) this.saveTimer = setTimeout(() => this.flush(), 900); }
    }
    saveStatus(message, error = false) {
      const status = this.root.querySelector('[data-fl-save-status]'); if (status) { status.textContent = message; status.classList.toggle('fl-save-error', error); }
      const recovery = this.root.querySelector('[data-fl-save-recovery]'); if (recovery) recovery.hidden = !error;
    }
    async flush() {
      clearTimeout(this.saveTimer);
      if (this.saving) return this.saving;
      if (!this.dirty) return true;
      if (this.composing || this.conflict) { this.options.toast(this.composing ? '请先完成输入法选字，资料还未保存。' : '请先下载编辑稿，再读取最新版本。'); return false; }
      this.saving = (async () => {
        while (this.dirty && this.active()) {
          const snapshot = this.editorSnapshot(); if (!snapshot) return false;
          const id = this.selectedId;
          try {
            this.saveStatus('正在保存…');
            const saved = await this.call(`/${id}/content?` + this.parameters(), 'PUT', snapshot);
            if (!this.active()) {
              const draft = readStored('novelking.fileLibrary.draft.' + id);
              if (draft?.revision === snapshot.revision) {
                if (draft.html === snapshot.html && draft.text === snapshot.text) { try { accountLocalStorage.removeItem('novelking.fileLibrary.draft.' + id); } catch {} }
                else writeStored('novelking.fileLibrary.draft.' + id, { ...draft, revision: saved.revision });
              }
              return false;
            }
            this.page.revision = saved.revision;
            const currentSnapshot = this.editorSnapshot();
            this.dirty = !currentSnapshot || currentSnapshot.html !== snapshot.html || currentSnapshot.text !== snapshot.text;
            if (this.dirty) this.keepDraft(); else this.removeDraft();
            const cardNote = this.root.querySelector(`.fl-document-card[data-id="${id}"] small`);
            if (cardNote) cardNote.textContent = `已编辑 · ${sizeLabel(this.page.size)}`;
            if (this.composing) { this.keepDraft(); return false; }
          } catch (error) { this.conflict = error.status === 409; this.keepDraft(); this.saveStatus(error.message + ' · 编辑稿已留在当前页面', true); return false; }
        }
        this.saveStatus('已保存'); return !this.dirty;
      })();
      try { return await this.saving; } finally { this.saving = null; }
    }
    downloadDraft() {
      const snapshot = this.editorSnapshot(); if (!snapshot) return;
      const url = URL.createObjectURL(new Blob([snapshot.text], { type: 'text/plain;charset=utf-8' })), link = document.createElement('a');
      link.href = url; link.download = this.page.name.replace(/\.[^.]+$/, '') + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    enqueue(files) {
      if (!this.area || this.trash || this.scope === 'all') return this.options.toast('先进入分区，再选择共享资料或所属作品作为上传位置。');
      if (files.length + this.queue.filter(item => ['等待上传', '上传中'].includes(item.status)).length > 100) return this.options.toast('每批最多 100 个文件，请分批上传。');
      const location = { area: this.area, ...(this.scope === 'shared' ? {} : { work_id: this.scope }), ...(this.folderId ? { folder_id: this.folderId } : {}) };
      for (const file of files) this.queue.push({ id: crypto.randomUUID(), file, location: { ...location }, status: file.size > 20 * 1024 * 1024 ? '失败' : '等待上传', error: file.size > 20 * 1024 * 1024 ? '单文件不能超过 20 MB' : '' });
      this.paintQueue(); this.runQueue();
    }
    async runQueue() {
      if (this.uploading) return;
      this.uploading = true;
      try {
        for (;;) {
          const item = this.queue.find(entry => entry.status === '等待上传'); if (!item || !this.active()) break;
          item.status = '上传中'; this.controller = new AbortController(); this.paintQueue();
          try {
            if (item.file.size > 20 * 1024 * 1024) throw Error('单文件不能超过 20 MB');
            const response = await fetch('/api/files/upload?' + new URLSearchParams({ ...item.location, name: item.file.name }), { method: 'POST', body: item.file, signal: this.controller.signal });
            const result = await response.json(); if (!response.ok) throw Error(result.error || '上传失败');
            item.status = '已上传'; item.error = result.read_status === 'error' ? result.read_error : '';
          } catch (error) { item.status = error.name === 'AbortError' ? '已取消' : '失败'; item.error = error.name === 'AbortError' ? '' : error.message; }
          this.paintQueue();
        }
      } finally { this.uploading = false; this.controller = null; if (this.active()) await this.render(); }
    }
    paintQueue() {
      const container = this.root.querySelector('.fl-upload-queue'); if (!container || !this.active()) return;
      container.innerHTML = this.queue.length ? `<div class="fl-queue-heading"><strong>上传队列 · ${this.queue.filter(item => item.status === '已上传').length}/${this.queue.length} 完成</strong>${button('清除已结束', 'clear-queue')}</div>${this.queue.map(item => `<div class="fl-queue-row"><span>${escapeHTML(item.file.name)}</span><small>${escapeHTML(item.status)}${item.error ? ' · ' + escapeHTML(item.error) : ''}</small>${['等待上传', '上传中'].includes(item.status) ? button('取消', 'cancel-upload', item.id) : item.status === '失败' ? button('重试', 'retry-upload', item.id) : ''}</div>`).join('')}` : '';
    }
  }
  window.NovelKingFileLibrary = {
    async mount(root, options) { if (!root.isConnected) return; if (current && !(await current.flush())) return; if (!root.isConnected) return; current?.dispose(); current = new FileLibrary(root, options); await current.render(); },
    async flush() { return current ? current.flush() : true; },
    dispose() { current?.dispose(); current = null; },
  };
})();
