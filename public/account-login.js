(() => {
  const $ = selector => document.querySelector(selector);
  let registering = false, challengeId = null, busy = false, challengeVersion = 0, invitationRequired = false;
  async function api(route, body) {
    const response = await fetch('/api/account/' + route, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '暂时无法完成操作');
    return result;
  }
  async function refreshChallenge() {
    challengeId = null; $('#captcha-answer').value = ''; $('#captcha-question').textContent = '正在出题…';
    const version = ++challengeVersion;
    try { const result = await api('challenge'); if (version !== challengeVersion) return; challengeId = result.id; $('#captcha-question').textContent = result.question; }
    catch (error) { if (version === challengeVersion) { $('#captcha-question').textContent = '出题失败'; $('#auth-message').textContent = error.message; } }
  }
  function switchMode(next) {
    if (busy) return;
    registering = next; $('#login-tab').setAttribute('aria-selected', String(!next)); $('#register-tab').setAttribute('aria-selected', String(next));
    $('#auth-heading').textContent = next ? '开启你的创作空间' : '继续你的故事';
    $('#auth-submit').textContent = next ? '注册并进入' : '登录';
    $('#captcha-row').hidden = $('#confirm-row').hidden = !next;
    $('#invitation-row').hidden = !next;
    $('#invitation-code').required = next && invitationRequired;
    $('#captcha-answer').required = $('#confirm-password').required = next;
    $('#password').minLength = next ? 10 : 1;
    $('#password').autocomplete = next ? 'new-password' : 'current-password';
    $('#password').placeholder = next ? '至少 10 个字符' : '请输入密码';
    $('#auth-message').textContent = '';
    if (next) refreshChallenge();
  }
  $('#login-tab').addEventListener('click', () => switchMode(false));
  $('#register-tab').addEventListener('click', () => switchMode(true));
  $('#refresh-captcha').addEventListener('click', refreshChallenge);
  $('#show-password').addEventListener('click', () => { const showing = $('#password').type === 'password'; $('#password').type = showing ? 'text' : 'password'; $('#show-password').textContent = showing ? '隐藏' : '显示'; });
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    if (registering && $('#password').value !== $('#confirm-password').value) { $('#auth-message').textContent = '两次密码输入不一致'; return; }
    if (registering && !challengeId) { $('#auth-message').textContent = '请先获取计算题'; return; }
    busy = true; $('#auth-submit').disabled = true; $('#auth-message').textContent = registering ? '正在创建个人空间…' : '正在登录…';
    try {
      const body = { username: $('#username').value, password: $('#password').value };
      if (registering) Object.assign(body, { challenge_id: challengeId, answer: $('#captcha-answer').value, invitation_code: $('#invitation-code').value || undefined });
      const result = await api(registering ? 'register' : 'login', body);
      try { localStorage.setItem('novelking.activeAccount', result.user.id); } catch {}
      location.assign('/');
    } catch (error) { $('#auth-message').textContent = error.message; if (registering) await refreshChallenge(); }
    finally { busy = false; $('#auth-submit').disabled = false; }
  });
  api('status').then(result => { $('#register-tab').hidden = !result.registration_open; invitationRequired = result.invitation_required; $('#invitation-code').placeholder = invitationRequired ? '请输入管理员提供的邀请码' : '选填'; }).catch(error => { $('#auth-message').textContent = error.message; });
})();
