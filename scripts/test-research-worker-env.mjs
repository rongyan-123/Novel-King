import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserWorkers } from '../accounts/workers.mjs';
test('hosted workers receive administrator MCP and ranking-service configuration without inheriting unrelated secrets', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-worker-env-'));
  fs.writeFileSync(path.join(directory, 'server.js'), `require('fs').writeFileSync(process.env.NOVELSTUDIO_DATA_DIR+'/environment.json',JSON.stringify({mcp:process.env.NOVELKING_MCP_ORIGINS,reader:process.env.NOVELKING_RANK_READER_URL,token:process.env.NOVELKING_RANK_READER_TOKEN,unrelated:process.env.UNRELATED_SECRET}));console.log('NOVELKING_WORKER_READY:12345');setInterval(()=>{},1000);`);
  process.env.UNRELATED_SECRET = 'must-not-inherit';
  const workers = new UserWorkers(directory, directory, { mcpOrigins: 'https://mcp.example.test', rankReaderURL: 'http://ranking-reader:3798', rankReaderToken: 'fixture-reader-secret' });
  try {
    await workers.get('fixture-user');
    const observed = JSON.parse(fs.readFileSync(path.join(directory, 'users/fixture-user/environment.json')));
    assert.equal(observed.mcp, 'https://mcp.example.test'); assert.equal(observed.reader, 'http://ranking-reader:3798'); assert.equal(observed.token, 'fixture-reader-secret'); assert.equal(observed.unrelated, undefined);
  } finally { workers.close(); delete process.env.UNRELATED_SECRET; }
});
