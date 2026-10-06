(() => {
  const originalFetch = window.fetch.bind(window);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  let locked = false;
  function lock(message) {
    if (locked) return; locked = true;
    const panel = document.createElement('div'); panel.className = 'account-overlay account-lock';
    panel.innerHTML = `<section class="account-panel"><h2>请重新登录</h2><p>${escapeHTML(message)}</p><p class="account-hint">未保存的资料草稿仍保存在原账号的浏览器空间里。</p><a class="btn" href="/login">返回登录</a></section>`;
    document.body.append(panel);
    document.getElementById('app').style.visibility = 'hidden';
  }
  async function accountApi(route, body, method) {
    const response = await fetch('/api/account/' + route, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || '操作失败'); return result;
  }
  async function showAccount(user) {
    const overlay = document.createElement('div'); overlay.className = 'account-overlay';
    overlay.innerHTML = `<section class="account-panel" role="dialog" aria-modal="true" aria-label="我的账号"><div class="account-panel-head"><h2>${escapeHTML(user.username)}</h2><button class="btn secondary" id="account-close">关闭</button></div><p class="account-hint">${user.role === 'admin' ? '管理员 · 可管理账号' : '个人创作空间'}</p><h3>修改密码</h3><form id="account-password-form"><label>当前密码<input name="current_password" type="password" autocomplete="current-password" required maxlength="128"></label><label>新密码<input name="new_password" type="password" autocomplete="new-password" required minlength="10" maxlength="128" placeholder="至少 10 个字符"></label><button class="btn secondary" type="submit">更新密码并重新登录</button></form>${user.role === 'admin' ? '<h3>账号管理</h3><div id="account-users">正在读取…</div>' : ''}<p class="account-message" role="status"></p><button class="btn danger" id="account-logout">退出登录</button></section>`;
    document.body.append(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onEscape); };
    const onEscape = event => { if (event.key === 'Escape') close(); };
    overlay.querySelector('#account-close').onclick = close;
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', onEscape);
    const message = overlay.querySelector('.account-message');
    async function saveAndRun(operation) {
      try { if (typeof ensureSavedBeforeNavigation === 'function' && !await ensureSavedBeforeNavigation()) return; await operation(); try { localStorage.setItem('novelking.activeAccount', ''); } catch {} location.assign('/login'); }
      catch (error) { message.textContent = error.message; }
    }
    overlay.querySelector('#account-logout').onclick = () => saveAndRun(() => accountApi('logout', {}));
    overlay.querySelector('form').onsubmit = event => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.target)); saveAndRun(() => accountApi('password', body)); };
    if (user.role === 'admin') {
      async function loadUsers() {
        const result = await accountApi('users');
        overlay.querySelector('#account-users').innerHTML = result.users.map(entry => `<div class="account-user-row"><div>${escapeHTML(entry.username)} <small>${entry.role === 'admin' ? '管理员' : entry.disabled ? '已停用' : '正常'}</small></div>${entry.role === 'admin' ? '' : `<div class="account-user-actions"><button class="btn small secondary" data-user-id="${entry.id}" data-disabled="${entry.disabled}">${entry.disabled ? '启用' : '停用'}</button><button class="btn small secondary" data-reset-user="${entry.id}">重置密码</button></div>`}</div>`).join('');
      }
      overlay.querySelector('#account-users').onclick = async event => {
        const toggle = event.target.closest('[data-user-id]'), reset = event.target.closest('[data-reset-user]');
        try {
          if (toggle) { await accountApi('users/' + toggle.dataset.userId, { disabled: toggle.dataset.disabled !== 'true' }, 'PATCH'); await loadUsers(); }
          if (reset) { const password = prompt('输入新密码（至少 10 个字符）。此账号现有登录将失效。'); if (password) { await accountApi('users/' + reset.dataset.resetUser, { password }, 'PATCH'); message.textContent = '密码已重置'; } }
        } catch (error) { message.textContent = error.message; }
      };
      try { await loadUsers(); } catch (error) { message.textContent = error.message; }
    }
    overlay.querySelector('#account-close').focus();
  }
  async function loadScript(source) { await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = source; script.onload = resolve; script.onerror = () => reject(Error('页面资源加载失败，请刷新')); document.body.append(script); }); }
  async function start() {
    const statusResponse = await originalFetch('/api/account/status');
    if (statusResponse.ok) {
      const response = await originalFetch('/api/account/me');
      if (response.status === 401) { location.replace('/login'); return; }
      if (!response.ok) throw Error('无法读取账号，请刷新');
      const { user } = await response.json();
      document.documentElement.dataset.hosted = 'true';
      window.NovelKingAccount = { user, hosted: true, localStorage: NovelKingAccountStorage.scope(localStorage, user.id), sessionStorage: NovelKingAccountStorage.scope(sessionStorage, user.id) };
      window.fetch = async (input, options = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
          if (locked) throw Error('当前账号已切换，请重新登录');
          const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
          headers.set('X-NovelKing-Account', user.id); options = { ...options, headers };
        }
        const result = await originalFetch(input, options);
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
          if (result.status === 401) lock('登录已过期。重新登录原账号后可继续编辑。');
          if (result.status === 409) { const body = await result.clone().json().catch(() => ({})); if (body.code === 'ACCOUNT_CHANGED') lock(body.error); }
        }
        return result;
      };
      try { localStorage.setItem('novelking.activeAccount', user.id); } catch {}
      window.addEventListener('storage', event => { if (event.key === 'novelking.activeAccount' && event.newValue !== user.id) lock('其他标签页已经退出或切换账号，这个工作台已锁定。'); });
    } else if (statusResponse.status !== 404) throw Error('账户服务暂时不可用，请刷新');
    await loadScript('/long-text.js'); await loadScript('/writing-workspace.js'); await loadScript('/file-library.js'); await loadScript('/app.js');
    if (window.NovelKingAccount) {
      document.addEventListener('click', event => { if (event.target.closest('[data-account-menu]')) showAccount(window.NovelKingAccount.user); });
    }
  }
  start().catch(error => { document.getElementById('content').textContent = error.message; });
})();
