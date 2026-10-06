import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { AccountStore, failure, publicUser } from './accounts/store.mjs';
import { UserWorkers } from './accounts/workers.mjs';
import { migrateAdminData } from './accounts/migration.mjs';

const repo = path.dirname(fileURLToPath(import.meta.url));
const cookieName = 'novelking_session';
const authAssets = new Set(['/login', '/login.html', '/account-login.js', '/account-client.js', '/account-storage.js', '/account.css', '/appearance.js', '/styles.css']);
const basicResources = new Set(['works', 'volumes', 'plotlines', 'chapters', 'categories', 'terms', 'characters', 'relations', 'plotline_characters', 'world_entries', 'creation_tasks', 'api_configs', 'canvas', 'files', 'stats', 'search', 'export', 'chapter_versions', 'logs', 'ai_errors', 'debug', 'import', 'ai', 'research']);
const novelResources = new Set(['ping', 'story_state', 'state', 'approvals', 'adopt', 'projections', 'editing', 'novel_index', 'author_intent', 'scan', 'continuity_guard', 'continuity_exemption', 'foreshadows', 'proposals', 'chapter_blueprint', 'review', 'finalize', 'draft', 'empty_chapters', 'chapter_save', 'memory_auto_compress', 'context']);
export function hostedRouteAllowed(url, method) {
  const [, api, resource, action] = url.pathname.split('/');
  if (api !== 'api') return false;
  if (resource === 'import' && action) return false;
  if (resource === 'ai') return ['test', 'write', 'write_stream', 'personality', 'outline', 'chat', 'polish', 'expand', 'pipeline', 'canvas', 'policy', 'eval'].includes(action);
  if (resource === 'novel') return novelResources.has(action) && !(action === 'memory_auto_compress' && method !== 'GET');
  return basicResources.has(resource);
}
async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw failure(415, '请使用 JSON 格式');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw failure(413, '请求太大'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!body || Array.isArray(body) || typeof body !== 'object') throw Error(); return body; }
  catch { throw failure(400, '请求格式不正确'); }
}
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
function sessionToken(req) { return String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || ''; }

export async function createAccountServer(env = process.env) {
  const port = Number(env.PORT || 3741);
  const publicUrl = new URL(env.NOVELKING_PUBLIC_ORIGIN || `http://localhost:${port}`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.pathname !== '/' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || (publicUrl.protocol !== 'https:' && !(loopback && publicUrl.protocol === 'http:'))) throw Error('NOVELKING_PUBLIC_ORIGIN 须为 HTTPS 域名，或本机 HTTP 调试地址');
  const root = path.resolve(env.NOVELKING_ACCOUNT_ROOT || path.join(repo, 'accounts-data'));
  const store = new AccountStore(root, { captchaTtl: Math.max(100, Math.min(300000, Number(env.NOVELKING_CAPTCHA_TTL_MS) || 120000)), databaseURL: env.NOVELKING_DATABASE_URL, databaseSchema: env.NOVELKING_ACCOUNT_SCHEMA || 'nk_accounts' });
  await store.bootstrap(env.NOVELKING_ADMIN_USER, env.NOVELKING_ADMIN_PASSWORD);
  const migration = await migrateAdminData(store, env.NOVELKING_LEGACY_DATA_DIR);
  if (migration.migrated) console.log('旧作品、资料和画布已复制到管理员的个人数据库，原目录未改动');
  const workers = new UserWorkers(root, repo, { maximum: Math.max(1, Math.min(32, Number(env.NOVELKING_MAX_WORKERS) || 4)), aiOrigins: env.NOVELKING_AI_ORIGINS || 'https://api.deepseek.com,https://api.openai.com', databaseURL: env.NOVELKING_DATABASE_URL,
    mcpOrigins: env.NOVELKING_MCP_ORIGINS, rankReaderURL: env.NOVELKING_RANK_READER_URL, rankReaderToken: env.NOVELKING_RANK_READER_TOKEN });
  const setSession = (res, token) => res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 14 * 86400 : 0}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`);
  const proxyAddresses = new Set(String(env.NOVELKING_TRUSTED_PROXIES || '').split(',').filter(Boolean));
  function clientIp(req) {
    const peer = req.socket.remoteAddress;
    if (proxyAddresses.has(peer)) { const forwarded = String(req.headers['x-forwarded-for'] || '').trim(); if (isIP(forwarded)) return forwarded; }
    return peer;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.headers.host !== publicUrl.host) throw failure(403, '请求域名不匹配');
      const url = new URL(req.url, publicUrl);
      if (url.origin !== publicUrl.origin || /%2f|%5c|\\/i.test(url.pathname)) throw failure(400, '请求路径不合法');
      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (mutating && (req.headers.origin !== publicUrl.origin || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])))) throw failure(403, '请从本站页面提交操作');
      const ip = clientIp(req);
      if (url.pathname === '/api/account/status' && req.method === 'GET') return send(res, 200, { enabled: true, registration_open: env.NOVELKING_REGISTRATION !== 'closed' });
      if (url.pathname === '/api/account/challenge' && req.method === 'GET') {
        if (env.NOVELKING_REGISTRATION === 'closed') throw failure(403, '注册已关闭');
        return send(res, 200, store.challenge(ip));
      }
      if (url.pathname === '/api/account/register' && req.method === 'POST') {
        if (env.NOVELKING_REGISTRATION === 'closed') throw failure(403, '注册已关闭');
        store.limit('register:' + ip, 10, 3600000);
        const body = await jsonBody(req);
        store.consumeChallenge(ip, body.challenge_id, body.answer);
        store.limit('registration-daily:' + ip, 5, 86400000);
        const user = await store.createUser(body.username, body.password);
        setSession(res, store.newSession(user)); return send(res, 201, { user: publicUser(user) });
      }
      if (url.pathname === '/api/account/login' && req.method === 'POST') {
        const body = await jsonBody(req);
        const user = await store.login(ip, body.username, body.password);
        setSession(res, store.newSession(user)); return send(res, 200, { user: publicUser(user) });
      }
      if (authAssets.has(url.pathname)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw failure(405, '请求方式不支持');
        const filename = url.pathname === '/login' ? 'login.html' : url.pathname.slice(1);
        res.writeHead(200, { 'Content-Type': filename.endsWith('.css') ? 'text/css; charset=utf-8' : filename.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? '' : fs.readFileSync(path.join(repo, 'public', filename)));
      }
      const token = sessionToken(req), user = store.session(token);
      if (!user) {
        if (url.pathname.startsWith('/api/')) throw failure(401, '请先登录');
        res.writeHead(302, { Location: '/login' }); return res.end();
      }
      store.limit('requests:' + user.id, 1200, 60000);
      if (req.headers['x-novelking-account'] && req.headers['x-novelking-account'] !== user.id) {
        return send(res, 409, { error: '当前账号已切换，请重新打开工作台。旧账号的本地草稿仍保留。', code: 'ACCOUNT_CHANGED' });
      }
      if (url.pathname === '/api/account/me' && req.method === 'GET') return send(res, 200, { user: publicUser(user), hosted: true });
      if (url.pathname === '/api/account/logout' && req.method === 'POST') { store.logout(token); setSession(res, ''); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/account/password' && req.method === 'POST') {
        store.limit('password:' + user.id, 5, 900000);
        const body = await jsonBody(req); await store.changePassword(user, body.current_password, body.new_password);
        setSession(res, ''); return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/account/users' || url.pathname.startsWith('/api/account/users/')) {
        if (user.role !== 'admin') throw failure(403, '只有管理员可以管理账号');
        if (url.pathname === '/api/account/users' && req.method === 'GET') return send(res, 200, { users: store.db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(publicUser) });
        if (req.method === 'PATCH' && /^\/api\/account\/users\/[a-f0-9-]{36}$/.test(url.pathname)) {
          const id = url.pathname.split('/').pop(); const body = await jsonBody(req);
          const result = await store.manageUser(user, id, body);
          if (result.disabled || body.password) workers.stop(id);
          return send(res, 200, { user: result });
        }
        throw failure(405, '请求方式不支持');
      }
      if (url.pathname === '/api/harness/status' && req.method === 'GET') return send(res, 200, { available: false, hosted: true, message: '服务器版暂未开放 DSH 主机工具' });
      if (url.pathname.startsWith('/api/') && !hostedRouteAllowed(url, req.method)) throw failure(403, '服务器版未开放此主机工具，请使用文件库上传资料');
      if (Number(req.headers['content-length']) > 32 * 1024 * 1024) throw failure(413, '请求太大');
      await workers.proxy(req, res, user.id);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfter || 5));
      if (!error.status) console.error('账户服务请求失败：', error.message);
      send(res, error.status || 500, { error: error.status ? error.message : '服务器暂时无法完成请求' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return { server, store, workers, port, host: env.NOVELKING_BIND || '127.0.0.1', close: () => { workers.close(); store.close(); server.close(); server.closeAllConnections(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createAccountServer();
  app.server.listen(app.port, app.host, () => console.log(`Novel-King 账户服务：${process.env.NOVELKING_PUBLIC_ORIGIN || `http://localhost:${app.port}`}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close(); setTimeout(() => process.exit(0), 100).unref(); });
}
