import { load } from 'cheerio';

export const BOARDS = Object.freeze([
  { id: 'newbooks', name: '签约新书榜', path: 'signNewBkAll' },
  { id: 'potential', name: '潜力榜', path: 'potential' },
  { id: 'publicnewbooks', name: '未签约新书榜', path: 'pubnewbook' },
  { id: 'monthly', name: '月票榜', path: 'yuepiao' },
  { id: 'bestsellers', name: '畅销榜', path: 'hotsales' },
  { id: 'recommendations', name: '推荐榜', path: 'recom' },
  { id: 'sanjiang', name: '三江推荐', url: 'https://www.qidian.com/sanjiang/' },
]);
const failure = message => Object.assign(new Error(message), { status: 422 });
export function rankingURL(board) {
  const selected = BOARDS.find(candidate => candidate.id === board);
  if (!selected) throw failure('请选择有效榜单');
  if (selected.url) return selected.url;
  return 'https://www.qidian.com/rank/' + selected.path + '/';
}
export function validateSnapshot(snapshot) {
  if (!snapshot || !BOARDS.some(board => board.id === snapshot.board)) throw failure('请选择有效榜单');
  const source = new URL(String(snapshot.source_url || ''));
  if (source.protocol !== 'https:' || source.username || source.password || source.search.length > 1000) throw failure('榜单来源须为 HTTPS 网页地址');
  const capturedAt = new Date(snapshot.captured_at || Date.now());
  if (!Number.isFinite(capturedAt.getTime()) || capturedAt > new Date(Date.now() + 300000)) throw failure('采集时间不正确');
  if (!Array.isArray(snapshot.books) || !snapshot.books.length || snapshot.books.length > 200) throw failure('快照需要 1–200 本书');
  const seen = new Set();
  const books = snapshot.books.map((book, index) => {
    const title = String(book.title || '').trim();
    if (!title || title.length > 200) throw failure('书名不可为空，且须少于 200 字');
    const rank = Number(book.rank || index + 1);
    if (!Number.isInteger(rank) || rank < 1 || rank > 1000 || seen.has(rank)) throw failure('排名需要唯一的正整数');
    seen.add(rank);
    let url = String(book.url || '');
    if (url) { const target = new URL(url); if (target.protocol !== 'https:' || target.username || target.password) throw failure('书籍链接须为 HTTPS'); url = target.href; }
    return { rank, title, author: String(book.author || '').slice(0, 200), genre: String(book.genre || '').slice(0, 100),
      synopsis: String(book.synopsis || '').slice(0, 3000), url, ...(book.period ? { period: String(book.period).slice(0, 100) } : {}) };
  }).sort((left, right) => left.rank - right.rank);
  return { board: snapshot.board, source_url: source.href, captured_at: capturedAt.toISOString(), books,
    method: snapshot.method === 'public_page' ? 'public_page' : 'manual_import' };
}
export function parseRankingPage(html, { url, board, captured_at = new Date().toISOString() }) {
  const $ = load(html);
  const pageText = $('body').text();
  if (/安全验证|访问验证|滑动验证|请输入验证码|刷新验证码|请完成.*验证|captcha|access denied/i.test(pageText)) throw failure('起点要求完成访问验证，请在浏览器查看榜单后导入快照');
  const books = [], ids = new Set();
  if (board === 'sanjiang') {
    const latest = $('.strongrec-list.book-list-wrap').first(), period = latest.find('.date-range-title').text().trim();
    latest.find('.book-list li').each((_index, node) => {
      const item = $(node), link = item.find('h2 a').first(), match = String(link.attr('href') || '').match(/\/book\/(\d+)/);
      if (!match || ids.has(match[1])) return;
      ids.add(match[1]); books.push({ rank: books.length + 1, title: link.text().trim(), genre: item.find('.channel').text().replace(/[「」]/g, '').trim(), synopsis: item.find('.rec').text().trim(), author: '', period, url: 'https://www.qidian.com/book/' + match[1] + '/' });
    });
  }
  if (board !== 'sanjiang') $('.book-mid-info').each((_index, node) => {
    const item = $(node), link = item.find('h2 a').first();
    const href = String(link.attr('href') || ''); const match = href.match(/\/book\/(\d+)/);
    if (!match || ids.has(match[1])) return;
    ids.add(match[1]);
    books.push({ rank: books.length + 1, title: link.text().trim(), author: item.find('.author .name').text().trim(),
      genre: item.find('.author a').not('.name,.go-sub-type').first().text().trim(), synopsis: item.find('.intro').text().trim(),
      url: 'https://www.qidian.com/book/' + match[1] + '/' });
  });
  if (!books.length) throw failure('没有识别出榜单条目，可能是页面结构变化或访问受限；本次没有保存快照');
  return validateSnapshot({ board, source_url: url, captured_at, books, method: 'public_page' });
}
let lastRequest = 0;
export async function scanRanking(board, { signal, fetcher = fetch, readerURL = process.env.NOVELKING_RANK_READER_URL, readerToken = process.env.NOVELKING_RANK_READER_TOKEN } = {}) {
  const url = rankingURL(board);
  if (Date.now() - lastRequest < 10000) throw Object.assign(new Error('公开榜单采集间隔为 10 秒，请稍后再试'), { status: 429 });
  lastRequest = Date.now();
  try {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetcher(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'User-Agent': 'Novel-King/1.0 (author research; low-frequency public rankings)', Accept: 'text/html' } });
  if (!response.ok) throw failure(`榜单网站返回 ${response.status}，请使用导入快照`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw failure('榜单页面超过读取上限'); chunks.push(chunk); }
  return parseRankingPage(Buffer.concat(chunks).toString('utf8'), { url, board });
  } catch (error) {
    if (signal?.aborted || !readerURL || !readerToken) throw error;
    const timeout = AbortSignal.timeout(55000);
    const response = await fetcher(readerURL.replace(/\/$/, '') + '/capture', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + readerToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ board }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 5 * 1024 * 1024) throw failure('榜单采集响应超过读取上限'); chunks.push(chunk); }
    const captured = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw Object.assign(new Error(captured.error || '浏览器采集失败'), { status: response.status });
    if (captured.source_url !== url || typeof captured.html !== 'string') throw failure('榜单采集来源不匹配');
    return parseRankingPage(captured.html, { url, board, captured_at: captured.captured_at });
  }
}
