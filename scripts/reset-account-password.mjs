import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { AccountStore } from '../accounts/store.mjs';

export function openAccountPasswordStore(env = process.env) {
  const root = path.resolve(env.NOVELKING_ACCOUNT_ROOT || fileURLToPath(new URL('../accounts-data', import.meta.url)));
  if (!env.NOVELKING_DATABASE_URL && !existsSync(path.join(root, 'accounts.db'))) throw Error('没有找到账户数据库，请设置正确的 NOVELKING_ACCOUNT_ROOT');
  return new AccountStore(root, { databaseURL: env.NOVELKING_DATABASE_URL, databaseSchema: env.NOVELKING_ACCOUNT_SCHEMA || 'nk_accounts' });
}

async function resetPasswordFromTerminal() {
  const username = process.argv[2];
  if (!username || !process.stdin.isTTY) throw Error('请先停下账户服务，再在终端执行：node scripts/reset-account-password.mjs <用户名>');
  const silentOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: silentOutput, terminal: true });
  let store;
  try {
    process.stdout.write('新密码（输入隐藏，至少 10 个字符）：');
    const password = await input.question('');
    process.stdout.write('\n再次输入：');
    const confirmation = await input.question('');
    if (password !== confirmation) throw Error('两次密码不一致');
    store = openAccountPasswordStore();
    await store.resetPasswordByOperator(username, password);
    process.stdout.write('\n密码已更新，这个账号的旧会话已全部撤销。\n');
  } finally { input.close(); store?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await resetPasswordFromTerminal();
