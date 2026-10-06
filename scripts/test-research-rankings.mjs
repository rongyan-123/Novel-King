import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRankingPage, rankingURL, validateSnapshot, scanRanking } from '../ai/research/rankings.mjs';

test('ranking parser retains ordered books and provenance but rejects verification and changed pages', () => {
  const html = `<div class="book-img-text"><ul>
    <li><div class="book-mid-info"><h2><a href="//www.qidian.com/book/123456/">书名一</a></h2><p class="author"><a class="name">作者甲</a><a>仙侠</a></p><p class="intro">主角的故事。</p></div></li>
    <li><div class="book-mid-info"><h2><a href="/book/999111/">书名二</a></h2><p class="author"><a class="name">作者乙</a><a>都市</a></p><p class="intro">第二本。</p></div></li></ul></div>`;
  const url = rankingURL('newbooks');
  assert.equal(url, 'https://www.qidian.com/rank/signNewBkAll/');
  assert.equal(rankingURL('sanjiang'), 'https://www.qidian.com/sanjiang/');
  const snapshot = parseRankingPage(html, { url, board: 'newbooks', captured_at: '2026-10-06T00:00:00.000Z' });
  assert.deepEqual(snapshot.books.map(book => [book.rank, book.title]), [[1, '书名一'], [2, '书名二']]);
  assert.equal(snapshot.books[0].genre, '仙侠'); assert.equal(snapshot.books[0].author, '作者甲');
  assert.equal(snapshot.source_url, url); assert.equal(snapshot.books[0].url, 'https://www.qidian.com/book/123456/');
  assert.equal(snapshot.books[0].votes, undefined);
  assert.throws(() => parseRankingPage('<html>请完成安全验证 验证码</html>', { url, board: 'newbooks' }), /验证/);
  assert.throws(() => parseRankingPage('<html>Unknown new page</html>', { url, board: 'newbooks' }), /结构|榜单/);
  assert.throws(() => rankingURL('file:///secrets'), /榜单/);
  assert.throws(() => validateSnapshot({ ...snapshot, books: [{ title: '', rank: 1 }] }), /书名/);
});

test('unreadable public HTTP pages fall back to the configured browser reader with credentials and fixed board', async () => {
  const requests = [];
  const snapshot = await scanRanking('newbooks', { readerURL: 'http://ranking-reader:3798', readerToken: 'test-reader-token', fetcher: async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return new Response('<html>JavaScript required</html>');
    return Response.json({ html: '<div class="book-mid-info"><h2><a href="/book/123456/">真实来源书目</a></h2></div>', source_url: rankingURL('newbooks'), captured_at: new Date().toISOString() });
  } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'http://ranking-reader:3798/capture');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer test-reader-token');
  assert.deepEqual(JSON.parse(requests[1].options.body), { board: 'newbooks' });
  assert.equal(snapshot.method, 'public_page'); assert.equal(snapshot.books[0].title, '真实来源书目');
});

test('Sanjiang captures only the latest displayed weekly recommendation and preserves its publication period', () => {
  const html = `<li class="strongrec-list book-list-wrap"><h3 class="date-range-title">2026.09.27-2026.10.04</h3><div class="book-list"><ul><li><a class="channel">「仙侠」</a><h2><a href="/book/123456/">本期作品</a></h2><span class="rec">修仙</span></li></ul></div></li><li class="strongrec-list book-list-wrap"><h3 class="date-range-title">2026.09.20-2026.09.27</h3><div class="book-list"><ul><li><h2><a href="/book/999111/">往期作品</a></h2></li></ul></div></li>`;
  const snapshot = parseRankingPage(html, { url: rankingURL('sanjiang'), board: 'sanjiang' });
  assert.equal(snapshot.books.length, 1); assert.equal(snapshot.books[0].title, '本期作品'); assert.equal(snapshot.books[0].period, '2026.09.27-2026.10.04'); assert.equal(snapshot.books[0].genre, '仙侠');
});
