import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRankingReader } from '../ai/research/ranking-reader.mjs';

test('dedicated ranking reader requires service credentials, uses fixed public URLs and rejects simultaneous captures', async () => {
  let release; const captured = new Promise(resolve => release = resolve); const urls = [];
  const app = createRankingReader({ token: 'fixture-reader-token', capture: async url => { urls.push(url); await captured; return '<html>ranking</html>'; } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = board => fetch(base + '/capture', { method: 'POST', headers: { Authorization: 'Bearer fixture-reader-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ board }) });
  try {
    assert.equal((await fetch(base + '/capture', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await post('http://localhost/private')).status, 400);
    const pending = post('newbooks');
    for (let attempt = 0; attempt < 50 && !urls.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await post('monthly')).status, 429);
    release(); const response = await pending;
    assert.equal(response.status, 200); assert.equal((await response.json()).html, '<html>ranking</html>');
    assert.deepEqual(urls, ['https://www.qidian.com/rank/signNewBkAll/']);
  } finally { release(); app.close(); app.closeAllConnections(); }
});
