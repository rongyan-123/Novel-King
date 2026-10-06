import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
test('vendored DSH bundle matches its fingerprint and retains bundled third-party copyright notices', () => {
  const directory = new URL('../vendor/dsh-research/', import.meta.url), manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', directory)));
  assert.equal(createHash('sha256').update(fs.readFileSync(new URL('runtime.mjs', directory))).digest('hex'), manifest.sha256);
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery', 'eventsource-parser']) {
    const dependency = manifest.dependencies?.find(item => item.name === name); assert.ok(dependency, 'Missing license record: ' + name);
    assert.match(fs.readFileSync(new URL(dependency.license_file, directory), 'utf8'), /MIT|Permission is hereby granted/);
  }
});
