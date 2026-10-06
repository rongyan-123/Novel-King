import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
test('服务器版关闭 DSH 检测与执行入口，后台调用也无法启动主机工具', async () => {
  process.env.NOVELKING_HOSTED = '1';
  const harness = await import('../harness.js');
  assert.equal(harness.isHarnessAvailable(), false);
  await assert.rejects(harness.runHarnessTaskWithProgress('fixture'), error => error.status === 403);
});
test('服务器模式导入 DSH 模块不能恢复其他实例的全局模型补丁', () => {
  const root = mkdtempSync(`${tmpdir()}/novel-hosted-harness-`);
  const home = root + '/dsh'; mkdirSync(home + '/profiles', { recursive: true });
  writeFileSync(home + '/settings.yaml', 'fixture-patched');
  writeFileSync(root + '/novel-studio-harness-settings-backup.json', JSON.stringify({ patched: 'fixture-patched', original: 'fixture-original' }));
  const harnessUrl = new URL('../harness.js', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(harnessUrl)})`], {
    env: { ...process.env, NOVELKING_HOSTED: '1', NOVELSTUDIO_DSH_HOME: home, TEMP: root, TMP: root, TMPDIR: root }, stdio: 'pipe',
  });
  assert.equal(readFileSync(home + '/settings.yaml', 'utf8'), 'fixture-patched');
});
