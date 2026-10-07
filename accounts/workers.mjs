import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { failure } from './store.mjs';

const safeEnvKeys = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];
export class UserWorkers {
  constructor(root, repo, { maximum = 4, aiOrigins = '', databaseURL = '', mcpOrigins = '', rankReaderURL = '', rankReaderToken = '', platformOrigin = '' } = {}) {
    this.root = root; this.repo = repo; this.maximum = maximum; this.aiOrigins = aiOrigins; this.workers = new Map();
    this.databaseURL = databaseURL;
    this.platformOrigin = platformOrigin;
    this.researchEnv = { NOVELKING_MCP_ORIGINS: mcpOrigins || 'https://mcp.exa.ai,https://mcp.tavily.com', NOVELKING_RANK_READER_URL: rankReaderURL, NOVELKING_RANK_READER_TOKEN: rankReaderToken };
    this.sweep = setInterval(() => {
      for (const [id, worker] of this.workers) if (!worker.active && !worker.starting && Date.now() - worker.lastUsed > 600000) this.stop(id);
    }, 60000).unref();
  }
  async get(userId) {
    const existing = this.workers.get(userId);
    if (existing) { await existing.ready; existing.lastUsed = Date.now(); return existing; }
    if (this.workers.size >= this.maximum) {
      const idle = [...this.workers.entries()].filter(([, value]) => !value.active && !value.starting).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (idle) this.stop(idle[0]); else throw failure(503, '当前正在处理其他写作任务，请稍后重试');
    }
    const dataRoot = path.join(this.root, 'users', userId);
    fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    const home = path.join(dataRoot, 'home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    const worker = { token, lastUsed: Date.now(), active: 0, starting: true, child: null, ready: null, port: null };
    this.workers.set(userId, worker);
    worker.ready = new Promise((resolve, reject) => {
      const env = Object.fromEntries(safeEnvKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      Object.assign(env, { PORT: '0', NOVELKING_WORKER_PORT: '0', NOVELKING_WORKER_TOKEN: token, NOVELKING_HOSTED: '1',
        NOVELSTUDIO_DATA_DIR: dataRoot, NOVELSTUDIO_OV_DISABLED: '1', NOVELSTUDIO_DSH_HOME: path.join(home, '.dsh'),
        HOME: home, USERPROFILE: home, NOVELKING_AI_ORIGINS: this.aiOrigins }, this.researchEnv);
      if (this.databaseURL) Object.assign(env, { NOVELKING_DATABASE_URL: this.databaseURL, NOVELKING_DATABASE_SCHEMA: 'nk_u_' + userId.replaceAll('-', '') });
      if (this.platformOrigin) env.NOVELKING_PLATFORM_URL = this.platformOrigin + '/internal/platform/' + userId + '/v1';
      const child = worker.child = spawn(process.execPath, ['server.js'], { cwd: this.repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const log = fs.createWriteStream(path.join(dataRoot, 'worker.log'), { flags: 'w', mode: 0o600 });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      let buffer = '', finished = false;
      const timer = setTimeout(() => { if (!finished) { finished = true; this.stop(userId); reject(failure(503, '个人工作台启动超时')); } }, 30000);
      child.stdout.on('data', chunk => {
        buffer = (buffer + chunk).slice(-8000);
        const match = buffer.match(/NOVELKING_WORKER_READY:(\d+)/);
        if (match && !finished) { finished = true; clearTimeout(timer); worker.port = Number(match[1]); worker.starting = false; resolve(); }
      });
      const failed = () => {
        log.end(); clearTimeout(timer);
        if (this.workers.get(userId) === worker) this.workers.delete(userId);
        if (!finished) { finished = true; reject(failure(503, '个人工作台启动失败，请检查服务器日志')); }
      };
      child.once('exit', failed); child.once('error', failed);
    });
    await worker.ready;
    return worker;
  }
  async proxy(req, res, userId) {
    const worker = await this.get(userId);
    worker.active++; worker.lastUsed = Date.now();
    // Forward only application headers. Cookies, Origin, proxy and capability headers stay at the gateway.
    const headers = { host: `127.0.0.1:${worker.port}`, 'x-novelking-worker': worker.token };
    for (const name of ['content-type', 'content-length', 'accept', 'x-request-id', 'x-novel-op-id']) if (req.headers[name]) headers[name] = req.headers[name];
    let settled = false;
    const finish = () => { if (!settled) { settled = true; worker.active--; worker.lastUsed = Date.now(); } };
    const upstream = http.request({ hostname: '127.0.0.1', port: worker.port, path: req.url, method: req.method, headers }, response => {
      const responseHeaders = { ...response.headers, 'cache-control': 'no-store' };
      delete responseHeaders['set-cookie']; delete responseHeaders['connection']; delete responseHeaders['transfer-encoding'];
      res.writeHead(response.statusCode, responseHeaders);
      response.pipe(res); response.once('error', () => res.destroy());
    });
    upstream.setTimeout(300000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '个人工作台暂时不可用，请重试' })); }
      else res.destroy();
      finish();
    });
    res.once('finish', finish);
    res.once('close', () => { upstream.destroy(); finish(); });
    req.once('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }
  stop(id) { const worker = this.workers.get(id); if (worker) { this.workers.delete(id); worker.child?.kill(); } }
  close() { clearInterval(this.sweep); for (const id of this.workers.keys()) this.stop(id); }
}
