import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rankingURL } from './rankings.mjs';

export async function capturePublicRanking(url) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.NOVELKING_CHROMIUM_PATH || undefined,
    headless: true, args: process.env.NOVELKING_BROWSER_CONTAINER === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [] });
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('.book-mid-info, .strongrec-list.book-list-wrap', { timeout: 10000 }).catch(() => {});
    if (new URL(page.url()).origin !== new URL(url).origin) throw new Error('榜单网页跳转到其他网站，本次停止读取');
    return await page.content();
  } finally { await browser.close(); }
}

export function createRankingReader({ token = process.env.NOVELKING_RANK_READER_TOKEN, capture = capturePublicRanking } = {}) {
  if (!token || token.length < 16) throw new Error('榜单采集服务需要至少 16 字符的访问令牌');
  const digest = value => createHash('sha256').update(value).digest();
  const expected = digest('Bearer ' + token);
  let busy = false, lastCapture = 0;
  return http.createServer(async (request, response) => {
    const reply = (status, payload) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(payload)); };
    if (request.url === '/health' && request.method === 'GET') return reply(200, { ok: true });
    if (!timingSafeEqual(expected, digest(request.headers.authorization || ''))) return reply(401, { error: '需要采集服务凭据' });
    if (request.url !== '/capture' || request.method !== 'POST') return reply(404, { error: '接口不存在' });
    let payload, size = 0;
    try {
      const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 4096) return reply(413, { error: '请求过大' }); chunks.push(chunk); }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return reply(400, { error: '请求需要有效 JSON' }); }
    let url;
    try { url = rankingURL(payload.board); } catch { return reply(400, { error: '请选择有效的公开榜单' }); }
    if (busy || Date.now() - lastCapture < 10000) return reply(429, { error: '榜单采集间隔为 10 秒，请稍后重试' });
    busy = true; lastCapture = Date.now();
    try {
      const html = await capture(url);
      if (typeof html !== 'string' || Buffer.byteLength(html) > 4 * 1024 * 1024) throw new Error('榜单网页超过读取上限');
      reply(200, { html, source_url: url, captured_at: new Date().toISOString() });
    } catch (error) { reply(422, { error: String(error.message || '公开榜单读取失败').slice(0, 500) }); }
    finally { busy = false; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createRankingReader().listen(Number(process.env.PORT || 3798), process.env.HOST || '127.0.0.1', () => console.log('Novel-King public ranking reader ready'));
}
