import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw Error('迁移资料不能包含符号链接：' + source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) copyDirectory(path.join(source, name), path.join(target, name));
  } else if (stat.isFile()) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}
export async function migrateAdminData(store, sourceDir) {
  if (!sourceDir || store.db.prepare("SELECT value FROM account_settings WHERE key='legacy_migrated'").get()) return { migrated: false };
  const source = fs.realpathSync(sourceDir);
  const owner = store.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get();
  if (!owner) throw Error('迁移前必须创建管理员');
  const usersRoot = path.join(store.root, 'users');
  fs.mkdirSync(usersRoot, { recursive: true, mode: 0o700 });
  const target = path.join(usersRoot, owner.id);
  if (fs.existsSync(target)) throw Error('管理员目录已存在，拒绝覆盖。请先备份并使用单独的迁移目录');
  const staging = path.join(usersRoot, owner.id + '.migration-' + randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  const sourceFile = path.join(source, 'novel.db');
  if (fs.lstatSync(sourceFile).isSymbolicLink()) throw Error('原数据库不能是符号链接');
  const database = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    const snapshot = path.join(staging, 'novel.db').replaceAll("'", "''");
    database.exec(`VACUUM INTO '${snapshot}'`);
    const check = new DatabaseSync(path.join(staging, 'novel.db'), { readOnly: true });
    try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('旧库快照校验失败'); } finally { check.close(); }
    for (const name of ['file-library', 'backups', 'debug']) copyDirectory(path.join(source, name), path.join(staging, name));
    fs.renameSync(staging, target);
    store.db.prepare("INSERT INTO account_settings(key,value) VALUES('legacy_migrated',?)").run(JSON.stringify({ administrator: owner.id, source, at: new Date().toISOString() }));
    return { migrated: true, administrator: owner.id };
  } finally { database.close(); }
}
