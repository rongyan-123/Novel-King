(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function parseBooks(text) {
    const books = String(text).split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      const [title, author = '', genre = '', url = ''] = line.split('\t').map(field => field.trim());
      if (!title) throw Error('每一行需要书名');
      return { rank: index + 1, title, author, genre, url };
    });
    if (!books.length || books.length > 200) throw Error('请输入 1–200 本书的书名');
    return books;
  }
  function streamDecoder() {
    let pending = '';
    return { push(chunk) { pending += chunk; const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop(); return frames.flatMap(frame => {
      const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      return payload ? [JSON.parse(payload)] : [];
    }); } };
  }
  const session = { tab: 'research', work: null, prompt: '', skill: 'ranking-research', activeRun: null, running: false, latest: null };
  const statusNames = { running: '研究中', complete: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
  async function request(route, body, method) {
    const response = await fetch('/api/research/' + route, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json(); if (!response.ok) throw Error(payload.error || '操作失败'); return payload;
  }
  function message(root, text, error = false) { const box = root.querySelector('.research-notice'); if (box) { box.textContent = text; box.dataset.error = String(error); box.hidden = !text; } }
  function prettyDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : ''; }
  function safeLink(url, title) { try { const parsed = new URL(url); if (parsed.protocol !== 'https:') return escape(title); return `<a href="${escape(parsed.href)}" target="_blank" rel="noopener noreferrer">${escape(title)} ↗</a>`; } catch { return escape(title); } }
  async function mount(root, { works = [], configs = [], activeConfigId, workId } = {}) {
    if (session.work === null) session.work = workId ? String(workId) : '';
    root.innerHTML = '<div class="empty">正在读取 AI 中心…</div>';
    let status;
    try { status = await request('status?work_id=' + encodeURIComponent(session.work)); }
    catch (error) { root.innerHTML = `<div class="card"><h2>AI 中心暂时不可用</h2><p>${escape(error.message)}</p><p class="muted">如果刚更新了程序，请重启服务器。</p></div>`; return; }
    if (!root.isConnected) return;
    const refresh = () => mount(root, { works, configs, activeConfigId, workId });
    const selectedConfig = configs.find(config => config.id === activeConfigId) || configs[0];
    root.innerHTML = `<div class="research-center"><header class="research-header"><div><div class="research-eyebrow">NOVEL KING / WRITING RESEARCH</div><h1>AI 中心</h1><p>读懂你的作品，研究榜单，再决定怎么写。</p></div><label class="research-work-label">当前作品<select id="research-work"><option value="">共享资料与榜单</option>${works.map(work => `<option value="${work.id}" ${String(work.id) === session.work ? 'selected' : ''}>${escape(work.title)}</option>`).join('')}</select></label></header>
      <nav class="research-tabs" aria-label="AI 中心功能">${[['research', '创作研究'], ['rankings', '榜单资料'], ['models', '模型配置'], ['tools', '工具与技能']].map(([key, name]) => `<button type="button" data-research-tab="${key}" aria-selected="${session.tab === key}" class="${session.tab === key ? 'active' : ''}">${name}</button>`).join('')}</nav>
      <p class="research-notice" role="status" hidden></p><div class="research-body"></div><footer class="research-footer">DSH ${escape(status.version)} · ${status.storage === 'postgres' ? 'PostgreSQL' : 'SQLite'} · API 密钥保存在你的个人数据库中</footer></div>`;
    const body = root.querySelector('.research-body');
    root.querySelector('#research-work').onchange = event => { session.work = event.target.value; session.latest = null; refresh(); };
    root.querySelectorAll('[data-research-tab]').forEach(button => button.onclick = () => { session.tab = button.dataset.researchTab; refresh(); });
    if (session.tab === 'research') {
      const current = session.latest || status.runs[0];
      body.innerHTML = `<div class="research-layout"><section class="research-compose"><h2>这次想研究什么？</h2><p class="muted">${session.work ? 'AI 可以查阅这部作品的正文、人物、设定、资料与大纲画布。' : '当前可查阅共享资料和榜单。选择作品后，可以一起研究正文。'}</p>
        <label>研究方法<select id="research-skill">${status.skills.map(skill => `<option value="${escape(skill.id)}" ${session.skill === skill.id ? 'selected' : ''}>${escape(skill.name)}</option>`).join('')}</select></label>
        <textarea id="research-prompt" rows="7" maxlength="12000" placeholder="例如：对比最近的新书榜，看看我的开篇能否明确传达题材、主角目标和核心看点。请引用你读到的章节与榜单。">${escape(session.prompt)}</textarea>
        <div class="research-examples">${['对比榜单，找出近期题材与开篇看点', '检查前三章：主角目标、冲突和期待感', '检查人物设定与剧情是否矛盾'].map(text => `<button type="button" data-question="${escape(text)}">${escape(text)}</button>`).join('')}</div>
        <label>使用模型<select id="research-model">${configs.map(config => `<option value="${config.id}" ${config.id === selectedConfig?.id ? 'selected' : ''}>${escape(config.name)} · ${escape(config.model)}</option>`).join('') || '<option value="">请先配置模型</option>'}</select></label>
        <div class="research-compose-actions"><button class="btn" id="research-start" ${session.running || !configs.length ? 'disabled' : ''}>${session.running ? '正在研究…' : '开始研究'}</button><button class="btn secondary" id="research-stop" ${session.running ? '' : 'hidden'}>停止</button></div>
        ${!configs.length ? '<button class="research-text-button" data-research-jump="models">先填写 API 密钥 →</button>' : ''}<p class="research-small">研究建议保存为记录。AI 不会修改或删除你的作品。</p>
        <h3>最近研究</h3><div class="research-history">${status.runs.map(run => `<button data-run="${run.id}"><span>${escape(run.prompt)}</span><small>${escape(statusNames[run.status] || run.status)} · ${prettyDate(run.created_at)}</small></button>`).join('') || '<p class="muted">完成第一项研究后，记录会出现在这里。</p>'}</div></section>
        <section class="research-result"><div class="research-result-head"><h2>研究结果</h2><span id="research-run-status" class="chip">${current ? escape(statusNames[current.status] || current.status) : '准备就绪'}</span></div><div id="research-activity" class="research-activity" aria-live="polite"></div><div id="research-output" class="research-output">${escape(current?.text || current?.error || '先提出一个具体问题。AI 会查阅资料，再给出有依据的建议。')}</div></section></div>`;
      const prompt = body.querySelector('#research-prompt'); prompt.oninput = () => session.prompt = prompt.value;
      body.querySelector('#research-skill').onchange = event => session.skill = event.target.value;
      body.querySelectorAll('[data-question]').forEach(button => button.onclick = () => { prompt.value = session.prompt = button.dataset.question; prompt.focus(); });
      body.querySelectorAll('[data-run]').forEach(button => button.onclick = async () => { try { session.latest = await request('runs/' + button.dataset.run); refresh(); } catch (error) { message(root, error.message, true); } });
      body.querySelector('#research-stop').onclick = async () => { if (session.activeRun) { await request('runs/' + session.activeRun + '/cancel', {}).catch(error => message(root, error.message, true)); } };
      body.querySelector('#research-start').onclick = async () => {
        if (!session.prompt.trim()) return message(root, '请先输入想研究的问题', true);
        const start = body.querySelector('#research-start'), stop = body.querySelector('#research-stop'); session.running = true; start.disabled = true; stop.hidden = false;
        const output = body.querySelector('#research-output'), activity = body.querySelector('#research-activity'), badge = body.querySelector('#research-run-status');
        output.textContent = ''; activity.textContent = '正在连接模型与研究工具…'; badge.textContent = '研究中'; message(root, '');
        try {
          const response = await fetch('/api/research/runs/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ work_id: session.work || null, config_id: Number(body.querySelector('#research-model').value), skill: session.skill, prompt: session.prompt }) });
          if (!response.ok) throw Error((await response.json()).error || '无法开始研究');
          const decoder = streamDecoder(), textDecoder = new TextDecoder(), reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            for (const event of decoder.push(textDecoder.decode(value, { stream: true }))) {
              if (event.type === 'started') session.activeRun = event.id;
              if (event.type === 'progress') {
                const observed = event.event;
                if (observed.type === 'tool/call') activity.textContent = '查阅资料：' + (observed.data?.name || observed.data?.toolName || '研究工具');
                if (observed.type === 'assistant/message') output.textContent = (observed.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
              }
              if (event.type === 'complete') { session.latest = event.run; output.textContent = event.run.text; badge.textContent = '已完成'; activity.textContent = '研究记录已保存'; }
              if (event.type === 'error') { badge.textContent = '已停止'; throw Error(event.error); }
            }
          }
        } catch (error) { message(root, error.message, true); activity.textContent = '研究已结束，记录可在最近研究中查看'; badge.textContent = '已结束'; }
        finally { session.running = false; session.activeRun = null; start.disabled = false; stop.hidden = true; }
      };
    } else if (session.tab === 'rankings') {
      body.innerHTML = `<div class="research-section-title"><div><h2>榜单资料</h2><p class="muted">只采集公开书名、作者、分类与简介；研究时会标注来源和日期。</p></div><span class="chip">${status.snapshots.length} 份快照</span></div><div class="research-board-grid">${status.boards.map(board => `<article class="research-board"><h3>${escape(board.name)}</h3><p class="muted">${board.id === 'sanjiang' ? '本期推荐书目' : '当前榜单首页书目'}</p><button class="btn secondary small" data-scan-board="${board.id}">采集公开书目</button></article>`).join('')}</div>
        <details class="research-import"><summary>从浏览器导入书目</summary><p class="muted">网站要求验证时，可以自行查看榜单后导入。每行一本书，支持从表格粘贴“书名、作者、分类、链接”四列。</p><form id="research-import-form"><div class="research-field-row"><label>所属榜单<select name="board">${status.boards.map(board => `<option value="${board.id}">${escape(board.name)}</option>`).join('')}</select></label><label>来源网页<input name="source_url" type="url" required placeholder="https://www.qidian.com/rank/…"></label></div><textarea name="books" rows="6" required placeholder="书名（必填）　作者　分类　链接"></textarea><button class="btn" type="submit">保存快照</button></form></details>
        <div class="research-snapshots">${status.snapshots.map(snapshot => `<details class="research-snapshot"><summary><span>${escape(status.boards.find(board => board.id === snapshot.board)?.name || snapshot.board)}</span><small>${snapshot.books.length} 本 · ${prettyDate(snapshot.captured_at)} · ${snapshot.method === 'manual_import' ? '手动导入' : '公开网页'}</small></summary><p>${safeLink(snapshot.source_url, '查看来源')}</p><div class="research-book-list">${snapshot.books.map(book => `<article><span class="research-book-rank">${book.rank}</span><div><b>${safeLink(book.url, book.title)}</b><p class="muted">${escape([book.author, book.genre, book.period ? '推荐期：' + book.period : ''].filter(Boolean).join(' · '))}</p>${book.synopsis ? `<p>${escape(book.synopsis)}</p>` : ''}</div></article>`).join('')}</div><button class="btn danger small" data-delete-snapshot="${snapshot.id}">删除这份快照</button></details>`).join('') || '<div class="research-empty">还没有榜单资料。选择上方榜单采集，或导入你整理的书目。</div>'}</div>`;
      body.querySelectorAll('[data-scan-board]').forEach(button => button.onclick = async () => { const original = button.textContent; button.disabled = true; button.textContent = '正在读取…'; message(root, '浏览器采集通常需要几十秒，请稍候。'); try { await request('scan', { board: button.dataset.scanBoard, work_id: session.work || null }); await refresh(); message(root, '已保存榜单书目'); } catch (error) { message(root, error.message, true); } finally { button.disabled = false; button.textContent = original; } });
      body.querySelector('#research-import-form').onsubmit = async event => { event.preventDefault(); try { const form = new FormData(event.target); await request('snapshots', { work_id: session.work || null, board: form.get('board'), source_url: form.get('source_url'), books: parseBooks(form.get('books')) }); await refresh(); message(root, '快照已保存'); } catch (error) { message(root, error.message, true); } };
      body.querySelectorAll('[data-delete-snapshot]').forEach(button => button.onclick = async () => { if (!confirm('删除这份榜单快照？')) return; try { await request('snapshots/' + button.dataset.deleteSnapshot, null, 'DELETE'); refresh(); } catch (error) { message(root, error.message, true); } });
    } else if (session.tab === 'models') {
      body.innerHTML = `<div class="research-section-title"><div><h2>模型配置</h2><p class="muted">填写 API 密钥后，正文助手和研究助手共用此配置。</p></div><button class="btn" data-action="new-api-config">添加模型</button></div><div class="research-model-grid">${configs.map(config => `<article class="research-model"><div class="research-section-title"><h3>${escape(config.name)}</h3>${config.id === activeConfigId ? '<span class="chip">当前模型</span>' : ''}</div><p>${escape(config.model)}</p><p class="research-small">${escape(config.base_url)}</p><p class="muted">密钥：${config.has_key || config.api_key ? '已保存' : '未填写'}</p><div class="research-actions"><button class="btn secondary small" data-action="edit-api-config" data-id="${config.id}">编辑密钥与配置</button><button class="btn secondary small" data-action="test-api-config" data-id="${config.id}">测试连接</button><button class="btn secondary small" data-action="set-active-config" data-id="${config.id}">设为当前</button><button class="btn danger small" data-action="delete-api-config" data-id="${config.id}">删除</button></div></article>`).join('') || '<div class="research-empty"><h3>连接你的第一个模型</h3><p>支持 DeepSeek 和管理员允许的 OpenAI 兼容服务。密钥无需写进代码。</p><button class="btn" data-action="new-api-config">填写 API 密钥</button></div>'}</div>`;
    } else {
      body.innerHTML = `<div class="research-section-title"><div><h2>工具与技能</h2><p class="muted">内置工具读取当前作品。外部 MCP 需测试连接，并由你勾选允许的只读工具。</p></div><button class="btn secondary" id="research-exa">添加 Exa 网页搜索</button></div><div class="research-skill-grid">${status.skills.map(skill => `<article class="research-skill"><h3>${escape(skill.name)}</h3><p>${escape(skill.description)}</p><button class="research-text-button" data-use-skill="${skill.id}">用这个方法研究 →</button></article>`).join('')}</div><h3 class="research-tools-title">外部 MCP 服务</h3><div class="research-connectors">${status.connectors.map(connection => `<article class="research-connector"><div class="research-section-title"><div><h3>${escape(connection.name)}</h3><p class="research-small">${escape(connection.endpoint)}</p></div><span class="chip">${connection.enabled ? '已启用' : '未启用'}</span></div><p class="muted">允许 ${connection.allowed_tools.length} 个工具 · ${connection.has_key ? '密钥已保存' : '无密钥'}</p><div class="research-actions"><button class="btn secondary small" data-test-mcp="${connection.id}">测试连接 / 选择工具</button><button class="btn danger small" data-delete-mcp="${connection.id}">删除服务</button></div><div data-mcp-tools="${connection.id}"></div></article>`).join('') || '<p class="muted">尚未添加外部服务。内置作品读取和榜单工具已可用。</p>'}</div>
        <details class="research-import"><summary>添加其他 MCP 服务</summary><form id="research-mcp-form"><label>服务名称<input name="name" required maxlength="80" placeholder="例如：网页研究"></label><label>MCP 地址<input name="endpoint" required type="url" placeholder="https://mcp.exa.ai/mcp"></label><label>服务密钥（可选）<input name="api_key" type="password" autocomplete="off"></label><p class="research-small">管理员允许的服务：${escape(status.mcp_origins.join('、'))}</p><button class="btn" type="submit">保存并测试连接</button></form></details>`;
      const saveConnector = async connector => { const saved = await request('connectors', { ...connector, enabled: false, allowed_tools: [] }); await refresh(); root.querySelector(`[data-test-mcp="${saved.id}"]`)?.click(); };
      body.querySelector('#research-exa').onclick = async () => { try { const existing = status.connectors.find(connection => connection.endpoint === 'https://mcp.exa.ai/mcp'); if (existing) body.querySelector(`[data-test-mcp="${existing.id}"]`).click(); else await saveConnector({ name: 'Exa 网页搜索', endpoint: 'https://mcp.exa.ai/mcp' }); } catch (error) { message(root, error.message, true); } };
      body.querySelector('#research-mcp-form').onsubmit = async event => { event.preventDefault(); try { await saveConnector(Object.fromEntries(new FormData(event.target))); } catch (error) { message(root, error.message, true); } };
      body.querySelectorAll('[data-use-skill]').forEach(button => button.onclick = () => { session.skill = button.dataset.useSkill; session.tab = 'research'; refresh(); });
      body.querySelectorAll('[data-delete-mcp]').forEach(button => button.onclick = async () => { if (!confirm('删除这个 MCP 服务配置？')) return; try { await request('connectors/' + button.dataset.deleteMcp, null, 'DELETE'); refresh(); } catch (error) { message(root, error.message, true); } });
      body.querySelectorAll('[data-test-mcp]').forEach(button => button.onclick = async () => {
        const connection = status.connectors.find(candidate => candidate.id === button.dataset.testMcp); button.disabled = true;
        try {
          const result = await request('connectors/' + connection.id + '/test', {}); const panel = body.querySelector(`[data-mcp-tools="${connection.id}"]`);
          panel.innerHTML = `<fieldset class="research-tool-selection"><legend>连接成功 · 选择允许研究助手使用的工具</legend>${result.discovered_tools.map(tool => `<label><input type="checkbox" value="${escape(tool.name)}" ${tool.allowed ? 'checked' : ''} ${tool.read_only ? '' : 'disabled'}><span><b>${escape(({ web_search_exa: '网页搜索', web_fetch_exa: '阅读网页内容' })[tool.name] || tool.name)}</b><small>${escape(({ web_search_exa: '搜索公开网页，返回可引用的资料来源。', web_fetch_exa: '读取指定公开网页，提取可供研究的正文。' })[tool.name] || tool.description.slice(0, 200))}${tool.read_only ? '' : ' · 服务未声明只读，不能启用'}</small></span></label>`).join('')}<button class="btn small">保存并启用所选工具</button></fieldset>`;
          panel.querySelector('button').onclick = async () => { try { const allowed = [...panel.querySelectorAll('input:checked')].map(input => input.value); await request('connectors/' + connection.id, { ...connection, api_key: null, enabled: allowed.length > 0, allowed_tools: allowed }, 'PUT'); await refresh(); message(root, allowed.length ? 'MCP 工具已启用' : 'MCP 服务已停用'); } catch (error) { message(root, error.message, true); } };
        } catch (error) { message(root, error.message, true); } finally { button.disabled = false; }
      });
    }
    root.querySelectorAll('[data-research-jump]').forEach(button => button.onclick = () => { session.tab = button.dataset.researchJump; refresh(); });
  }
  window.NovelKingResearch = { mount, parseBooks, streamDecoder };
})();
