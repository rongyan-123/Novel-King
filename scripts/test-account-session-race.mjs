import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AccountStore } from '../accounts/store.mjs';
test('验证旧密码之后账号被重置，不能再用旧验证结果签发会话', async () => {
  const store = new AccountStore(mkdtempSync(`${tmpdir()}/novel-session-race-`));
  try {
    await store.bootstrap('owner', 'fixture-admin-password');
    const user = await store.createUser('writer', 'fixture-old-password');
    const originalSession = store.newSession(user);
    await store.changePassword(user, 'fixture-old-password', 'fixture-new-password');
    assert.equal(store.session(originalSession), undefined);
    assert.throws(() => store.newSession(user), error => error.status === 401);
  } finally { store.close(); }
});
test('服务器持有者可重置管理员密码，原会话全部失效', async () => {
  const store = new AccountStore(mkdtempSync(`${tmpdir()}/novel-account-recovery-`));
  try {
    await store.bootstrap('owner', 'fixture-admin-password');
    const admin = await store.login('fixture-ip', 'owner', 'fixture-admin-password');
    const session = store.newSession(admin);
    await store.resetPasswordByOperator('owner', 'fixture-recovered-password');
    assert.equal(store.session(session), undefined);
    await assert.rejects(store.login('fixture-ip', 'owner', 'fixture-admin-password'), error => error.status === 401);
    assert.equal((await store.login('fixture-ip', 'owner', 'fixture-recovered-password')).role, 'admin');
  } finally { store.close(); }
});
