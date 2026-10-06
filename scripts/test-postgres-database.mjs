import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../storage/postgres.mjs';
import { createDatabase } from '../storage/database.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('PostgreSQL actually persists SQLite-shaped queries and isolated transactions', () => {
  assert.ok(process.env.NOVELKING_TEST_DATABASE_URL, 'Run against the dedicated test database');
  const prefix = 'nk_test_' + randomUUID().replaceAll('-', '');
  const first = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, prefix);
  const other = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, prefix + '_b');
  try {
    for (const database of [first, other]) database.exec(`
      CREATE TABLE IF NOT EXISTS works(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TEXT DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS chapters(id INTEGER PRIMARY KEY AUTOINCREMENT,work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,content TEXT);
    `);
    const inserted = first.prepare('INSERT INTO works(title) VALUES(?)').run("小说? '原文'");
    assert.equal(inserted.lastInsertRowid, 1);
    assert.equal(first.prepare('SELECT * FROM works WHERE id=?').get(1).title, "小说? '原文'");
    assert.match(first.prepare('SELECT * FROM works').get().created_at, /^\d{4}-\d\d-\d\dT.*Z$/);
    other.prepare('INSERT INTO works(title) VALUES(?)').run('其他账号');
    assert.equal(other.prepare('SELECT title FROM works WHERE id=?').get(1).title, '其他账号');
    first.exec('BEGIN');
    first.prepare('INSERT INTO chapters(work_id,content) VALUES(?,?)').run(1, '不会保留');
    first.exec('SAVEPOINT inner_save');
    first.prepare('UPDATE works SET title=? WHERE id=?').run('不会保留', 1);
    first.exec('ROLLBACK TO inner_save'); first.exec('RELEASE inner_save');
    first.exec('ROLLBACK');
    assert.equal(first.prepare('SELECT count(*) AS n FROM chapters').get().n, 0);
    assert.equal(first.isTransaction, false);
    first.exec("CREATE VIRTUAL TABLE IF NOT EXISTS library_index_fts USING fts5(tokens,doc_id UNINDEXED,tokenize='unicode61')");
    first.prepare('INSERT INTO library_index_fts(tokens,doc_id) VALUES(?,?)').run('仙侠 开篇 冲突', 10);
    first.prepare('INSERT INTO library_index_fts(tokens,doc_id) VALUES(?,?)').run('都市 校园', 20);
    const hits = first.prepare('SELECT doc_id,bm25(library_index_fts) AS rank FROM library_index_fts WHERE library_index_fts MATCH ? ORDER BY rank LIMIT ?').all('"仙侠" OR "冲突"', 5);
    assert.equal(hits.length, 1); assert.equal(hits[0].doc_id, 10); assert.ok(hits[0].rank < 0);
    assert.equal(first.prepare('PRAGMA table_info(works)').all().find(column => column.name === 'id').pk, 1);
    first.prepare('INSERT OR IGNORE INTO works(id,title) VALUES(?,?)').run(1, '不覆盖');
    assert.equal(first.prepare('SELECT title FROM works WHERE id=?').get(1).title, "小说? '原文'");
    first.close();
    const reopened = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, prefix);
    try { assert.equal(reopened.prepare('SELECT title FROM works WHERE id=?').get(1).title, "小说? '原文'"); }
    finally { reopened.close(); }
  } finally {
    first.close(); other.exec(`DROP SCHEMA "${prefix}" CASCADE`); other.exec(`DROP SCHEMA "${prefix}_b" CASCADE`); other.close();
  }
});

test('migration retains SQLite double precision and self-references to rows inserted later', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-pg-precision-'));
  const filename = path.join(directory, 'novel.db'), schema = 'nk_test_' + randomUUID().replaceAll('-', '');
  const source = new DatabaseSync(filename);
  source.exec(`CREATE TABLE preferences(id INTEGER PRIMARY KEY,temperature REAL);INSERT INTO preferences VALUES(1,0.8123456789);
    CREATE TABLE folders(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES folders(id));INSERT INTO folders VALUES(2,NULL);INSERT INTO folders VALUES(1,2);`);
  source.close(); let migrated;
  try {
    migrated = createDatabase(filename, { url: process.env.NOVELKING_TEST_DATABASE_URL, schema });
    assert.equal(migrated.prepare('SELECT temperature FROM preferences').get().temperature, 0.8123456789);
    assert.equal(migrated.prepare('SELECT parent_id FROM folders WHERE id=1').get().parent_id, 2);
  } finally {
    migrated?.close(); const cleanup = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    cleanup.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); cleanup.close();
  }
});

test('SQLite migration preserves rows, IDs, references and next generated ID without touching the original', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novelking-pg-migrate-'));
  const filename = path.join(directory, 'novel.db');
  const schema = 'nk_test_' + randomUUID().replaceAll('-', '');
  const source = new DatabaseSync(filename);
  source.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL);
    CREATE TABLE chapters(id INTEGER PRIMARY KEY AUTOINCREMENT,work_id INTEGER NOT NULL REFERENCES works(id),content TEXT);
    INSERT INTO works VALUES(42,'原作品'); INSERT INTO chapters VALUES(91,42,'中文正文\n第二段');`);
  source.exec("CREATE VIRTUAL TABLE library_index_fts USING fts5(tokens,doc_id UNINDEXED); INSERT INTO library_index_fts(tokens,doc_id) VALUES('仙侠 剧情',91)");
  source.close();
  const originalBytes = fs.readFileSync(filename);
  const migrated = createDatabase(filename, { url: process.env.NOVELKING_TEST_DATABASE_URL, schema });
  try {
    assert.equal(migrated.kind, 'postgres');
    assert.equal(migrated.prepare('SELECT content FROM chapters WHERE id=?').get(91).content, '中文正文\n第二段');
    assert.equal(migrated.prepare('INSERT INTO works(title) VALUES(?)').run('新作品').lastInsertRowid, 43);
    assert.equal(migrated.prepare('SELECT doc_id FROM library_index_fts WHERE library_index_fts MATCH ?').get('"仙侠"').doc_id, 91);
    assert.throws(() => migrated.prepare('INSERT INTO chapters(work_id,content) VALUES(?,?)').run(999, '无父作品'));
    assert.deepEqual(fs.readFileSync(filename), originalBytes);
    migrated.close();
    const again = createDatabase(filename, { url: process.env.NOVELKING_TEST_DATABASE_URL, schema });
    try { assert.equal(again.prepare('SELECT count(*) AS n FROM works').get().n, 2); }
    finally { again.close(); }
  } finally {
    const cleanup = new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL, schema);
    cleanup.exec(`DROP SCHEMA "${schema}" CASCADE`); cleanup.close(); migrated.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
