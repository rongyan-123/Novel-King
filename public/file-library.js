/* File library: manual organization; uploading never changes novel chapters or character cards. */
(() => {
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icons = ['◇', '♙', '☷', '▤', '▥', '✎', '⌕', '↗', '✦', '▱'];
  const descriptions = ['地图、势力、体系与历史', '人物档案、关系与成长', '总纲、卷纲、场景与伏笔', '草稿、修订与发布版本', '一书一夹，保存原文与笔记', '开篇、节奏、对白与结构', '查证知识，积累真实细节', '三江、新书与其他榜单记录', '片段、台词、图片与随手记', '书名、简介、投稿与反馈'];
  const sizeLabel = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  const readLabel = { ready: '可读可搜索', original: '仅保留原件', error: '提取失败 · 原件保留' };
  const button = (label, action, id = '', extra = '') => `<button type="button" class="btn secondary small" data-fl-action="${action}" data-id="${escapeHTML(id)}" ${extra}>${label}</button>`;
  const formField = (label, input) => `<label class="fl-field"><span>${label}</span>${input}</label>`;
  let current;
  class FileLibrary {
    constructor(root, options) {
      this.root = root; this.options = options; this.area = ''; this.folderId = ''; this.scope = options.workId ? String(options.workId) : 'all';
      this.query = ''; this.trash = false; this.offset = 0; this.queue = []; this.sequence = 0; this.disposed = false;
      this.listener = event => this.onClick(event);
      root.addEventListener('click', this.listener);
      this.dragOver = event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); root.classList.add('fl-dragging'); } };
      this.dragLeave = event => { if (!root.contains(event.relatedTarget)) root.classList.remove('fl-dragging'); };
      this.drop = event => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); root.classList.remove('fl-dragging'); this.enqueue([...event.dataTransfer.files]); };
      root.addEventListener('dragover', this.dragOver); root.addEventListener('dragleave', this.dragLeave); root.addEventListener('drop', this.drop);
    }
    dispose() {
      this.disposed = true; this.sequence++;
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
      const sequence = ++this.sequence;
      try {
        const status = await this.call('/status?' + this.parameters());
        const listing = this.area || this.trash ? await this.call('?' + this.parameters({ ...(this.area ? { area: this.area } : {}), ...(this.query ? { q: this.query } : !this.trash ? { folder_id: this.folderId } : {}), ...(this.trash ? { trash: '1' } : {}), offset: String(this.offset) })) : null;
        if (sequence !== this.sequence || !this.active()) return;
        this.status = status; this.listing = listing;
        if (!this.allWorks) this.allWorks = (await this.call('/status')).works;
        if (sequence !== this.sequence || !this.active()) return;
        const area = status.areas.find(entry => entry.id === this.area);
        this.root.classList.add('fl-root');
        this.root.innerHTML = `<section class="fl-library">
          <header class="fl-header"><div><div class="fl-eyebrow">NOVEL-KING / 创作资料</div><h1>${this.trash ? '回收站' : area?.name || '文件库'}</h1><p>${this.trash ? '误传或删错的资料，可以在这里恢复。' : area ? descriptions[status.areas.indexOf(area)] : '把设定、故事和参考放在一起，随时回来找。'}</p></div><div class="fl-header-actions">${this.area || this.trash ? button('← 文件库', 'home') : button('回收站', 'trash')}${button('刷新', 'refresh')}</div></header>
          <div class="fl-scope-row"><label>资料范围 <select data-fl-scope aria-label="资料范围"><option value="all" ${this.scope === 'all' ? 'selected' : ''}>全部资料</option><option value="shared" ${this.scope === 'shared' ? 'selected' : ''}>共享资料</option>${this.allWorks.map(work => `<option value="${work.id}" ${this.scope === String(work.id) ? 'selected' : ''}>${escapeHTML(work.title)}</option>`).join('')}</select></label><span>文件库原件独立保存，上传不会覆盖作品正文。</span></div>
          ${listing ? this.filesHTML(area) : this.dashboardHTML()}
          <div class="fl-upload-queue" aria-live="polite"></div>
          ${!listing ? `<details class="fl-legacy"><summary>旧版资料导入</summary><p>已有的旧资料登记保留在原入口。</p>${button('打开旧版资料库', 'legacy')}</details>` : ''}
          <input type="file" multiple data-fl-picker hidden>
        </section>`;
        this.root.querySelector('[data-fl-scope]').addEventListener('change', event => { this.scope = event.target.value; this.folderId = ''; this.offset = 0; this.render(); });
        this.root.querySelector('[data-fl-picker]').addEventListener('change', event => this.enqueue([...event.target.files]));
        this.root.querySelector('[data-fl-search]')?.addEventListener('submit', event => { event.preventDefault(); this.query = new FormData(event.target).get('q').trim(); this.offset = 0; this.render(); });
        this.paintQueue();
      } catch (error) {
        if (this.active() && sequence === this.sequence) { this.options.toast(error.message); if (!this.root.querySelector('.fl-library')) this.root.innerHTML = '<div class="empty">文件库加载失败，请重新进入。</div>'; }
      }
    }
    dashboardHTML() {
      const status = this.status;
      const totalCharacters = status.works.reduce((sum, work) => sum + work.characters, 0), settings = status.works.reduce((sum, work) => sum + work.settings, 0);
      return `<div class="fl-overview"><div><strong>${status.total_files}</strong><span>资料文件</span></div><div><strong>${status.books}</strong><span>参考书资料夹</span></div><div><strong>${totalCharacters}</strong><span>作品人物</span></div><div><strong>${settings}</strong><span>作品设定条目</span></div></div>
        <div class="fl-section-title"><h2>资料分区</h2><span>选一个分区，上传或整理资料</span></div>
        <div class="fl-area-grid">${status.areas.map((area, index) => `<button class="fl-area-card" data-fl-action="area" data-id="${area.id}"><span class="fl-area-icon">${icons[index]}</span><span class="fl-area-name">${area.name}</span><span class="fl-area-description">${descriptions[index]}</span><span class="fl-area-count">${area.count} 份资料 <span>→</span></span></button>`).join('')}</div>
        <section class="fl-work-overview"><div class="fl-section-title"><h2>作品进度</h2><span>来自已保存的作品和画布</span></div>${status.works.map(work => `<div class="fl-work-row"><strong>${escapeHTML(work.title)}</strong><span>${work.chapters} 章 · ${work.characters} 人物 · ${work.settings} 设定 · ${work.canvas_nodes} 个画布元素</span><small>最近编辑：${escapeHTML(work.recent_chapter?.title || '暂无章节')}</small></div>`).join('') || '<div class="fl-empty">还没有作品。先回到书架开始写作。</div>'}</section>`;
    }
    folderPath(id, folders = this.listing?.folders || []) {
      const names = [], visited = new Set(); let folder = folders.find(entry => entry.id === id);
      while (folder && !visited.has(folder.id)) { visited.add(folder.id); names.unshift(folder.name); folder = folders.find(entry => entry.id === folder.parent_id); }
      return names.join(' / ');
    }
    filesHTML(area) {
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
        if (action === 'home') { this.area = ''; this.trash = false; this.folderId = ''; this.query = ''; this.offset = 0; return this.render(); }
        if (action === 'area') { this.area = id; this.folderId = ''; this.query = ''; this.trash = false; this.offset = 0; return this.render(); }
        if (action === 'folder') { this.folderId = id; this.query = ''; this.offset = 0; return this.render(); }
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
      const page = await this.call(`/${id}/text?` + this.parameters());
      if (!this.active()) return;
      const original = `/api/files/${id}/original?` + this.parameters();
      const dialog = this.showDialog(page.name, `<div class="fl-reader-meta"><span>${sizeLabel(page.size)} · ${readLabel[page.read_status]}</span><a class="btn secondary small" href="${original}" download>下载原件</a></div>${page.read_error ? `<p class="fl-reader-note">${escapeHTML(page.read_error)}</p>` : ''}<pre class="fl-reader-text">${escapeHTML(page.text)}</pre>${page.next_offset !== null ? '<button type="button" class="btn secondary" data-fl-read-next>继续阅读</button>' : ''}${page.read_status === 'original' && !page.read_error ? '<p class="fl-reader-note">此格式尚未提取正文，原件可以下载使用。</p>' : ''}`);
      if (/\.(png|jpe?g|webp|gif)$/i.test(page.original_name || page.name)) {
        const preview = document.createElement('img'); preview.className = 'fl-reader-image'; preview.alt = page.name;
        preview.src = `/api/files/${id}/preview?` + this.parameters();
        preview.addEventListener('load', () => dialog.querySelector('.fl-reader-note')?.remove());
        preview.addEventListener('error', () => { preview.remove(); const note = dialog.querySelector('.fl-reader-note'); if (note) note.textContent = '无法预览这张图片；可以下载原件检查。'; });
        dialog.querySelector('.fl-reader-meta').after(preview);
      }
      let offset = page.next_offset;
      dialog.querySelector('[data-fl-read-next]')?.addEventListener('click', async event => {
        event.target.disabled = true;
        try { const next = await this.call(`/${id}/text?` + this.parameters({ offset: String(offset) })); dialog.querySelector('.fl-reader-text').textContent += next.text; offset = next.next_offset; if (offset === null) event.target.remove(); }
        catch (error) { this.options.toast(error.message); }
        finally { event.target.disabled = false; }
      });
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
    async mount(root, options) { current?.dispose(); current = new FileLibrary(root, options); await current.render(); },
    dispose() { current?.dispose(); current = null; },
  };
})();
