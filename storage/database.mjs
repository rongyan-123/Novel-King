import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PostgresDatabase } from './postgres.mjs';

export function createDatabase(filename, { url = process.env.NOVELKING_DATABASE_URL, schema = process.env.NOVELKING_DATABASE_SCHEMA || 'nk_local' } = {}) {
  if (!url) return new DatabaseSync(filename);
  const database = new PostgresDatabase(url, schema);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS nk_migration(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
    if (fs.existsSync(filename) && !database.prepare("SELECT value FROM nk_migration WHERE key='sqlite_import'").get()) importSqlite(database, filename);
    return database;
  } catch (error) { database.close(); throw error; }
}

function importSqlite(target, filename) {
  const source = new DatabaseSync(filename, { readOnly: true });
  try {
    if (source.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('SQLite migration input failed integrity check');
    source.exec('BEGIN');
    const tables = source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'library_index_fts%' ORDER BY name").all();
    const names = new Set(tables.map(table => table.name));
    const byName = new Map(tables.map(table => [table.name, table]));
    const ordered = [], done = new Set(), visiting = new Set();
    function visit(name) {
      if (done.has(name)) return;
      if (visiting.has(name)) throw Error('SQLite migration has a cyclic foreign-key schema: ' + name);
      visiting.add(name);
      for (const foreign of source.prepare(`PRAGMA foreign_key_list("${name}")`).all()) if (foreign.table !== name && names.has(foreign.table)) visit(foreign.table);
      visiting.delete(name); done.add(name); ordered.push(byName.get(name));
    }
    for (const table of tables) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name)) throw Error('Unsupported SQLite table name');
      visit(table.name);
    }
    target.exec('BEGIN');
    try {
      for (const table of ordered) {
        const exists = target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table.name);
        if (exists && target.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get().n) throw Error('Migration refuses to overwrite nonempty target table: ' + table.name);
        target.exec(table.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS '));
      }
      target.exec('SET CONSTRAINTS ALL DEFERRED');
      let rowCount = 0;
      const checksum = createHash('sha256');
      for (const table of ordered) {
        const columns = source.prepare(`PRAGMA table_info("${table.name}")`).all();
        const ordering = columns.filter(column => column.pk).sort((left, right) => left.pk - right.pk).map(column => `"${column.name}"`);
        const orderClause = ordering.length ? ' ORDER BY ' + ordering.join(',') : '';
        const rows = source.prepare(`SELECT * FROM "${table.name}"${orderClause}`).all();
        const quoted = columns.map(column => `"${column.name}"`);
        const insert = target.prepare(`INSERT INTO "${table.name}"(${quoted.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
        for (const row of rows) { insert.run(...columns.map(column => row[column.name])); checksum.update(JSON.stringify(row)); }
        if (target.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get().n !== rows.length) throw Error('Migration row count mismatch: ' + table.name);
        const copied = target.prepare(`SELECT ${quoted.join(',')} FROM "${table.name}"${orderClause}`).all();
        if (createHash('sha256').update(JSON.stringify(rows.map(row => columns.map(column => row[column.name])))).digest('hex')
          !== createHash('sha256').update(JSON.stringify(copied.map(row => columns.map(column => row[column.name])))).digest('hex')) throw Error('Migration content checksum mismatch: ' + table.name);
        const generated = columns.find(column => column.name === 'id' && column.pk && /INTEGER/i.test(column.type));
        if (generated) target.prepare(`SELECT setval(pg_get_serial_sequence(?, 'id'),coalesce(max(id),1),count(*)>0) FROM "${table.name}"`).get(table.name);
        rowCount += rows.length;
      }
      if (source.prepare("SELECT name FROM sqlite_master WHERE name='library_index_fts'").get()) {
        target.exec('CREATE VIRTUAL TABLE IF NOT EXISTS library_index_fts USING fts5(tokens,doc_id UNINDEXED)');
        if (target.prepare('SELECT count(*) AS n FROM library_index_fts').get().n) throw Error('Migration refuses to overwrite lexical index');
        for (const row of source.prepare('SELECT tokens,doc_id FROM library_index_fts').all()) target.prepare('INSERT INTO library_index_fts(tokens,doc_id) VALUES(?,?)').run(row.tokens, Number(row.doc_id));
      }
      target.exec('SET CONSTRAINTS ALL IMMEDIATE');
      for (const index of source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) target.exec(index.sql.replace(/^CREATE (UNIQUE )?INDEX /i, 'CREATE $1INDEX IF NOT EXISTS '));
      target.prepare('INSERT INTO nk_migration(key,value) VALUES(?,?)').run('sqlite_import', JSON.stringify({ tables: ordered.length, rows: rowCount, checksum: checksum.digest('hex'), at: new Date().toISOString() }));
      target.exec('COMMIT');
    } catch (error) { target.exec('ROLLBACK'); throw error; }
    source.exec('COMMIT');
  } finally { source.close(); }
}
