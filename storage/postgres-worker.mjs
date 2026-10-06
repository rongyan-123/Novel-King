import { workerData, parentPort } from 'node:worker_threads';
import pg from 'pg';

pg.types.setTypeParser(20, value => {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) throw Error('Database integer exceeds JavaScript safe range');
  return integer;
});
const client = new pg.Client({ connectionString: workerData.connectionString, connectionTimeoutMillis: 10000,
  statement_timeout: 20000, application_name: 'novelking-' + workerData.schema });
const status = new Int32Array(workerData.signal);
const port = workerData.port;
function reply(response) {
  port.postMessage(response); Atomics.store(status, 0, 1); Atomics.notify(status, 0);
}
try {
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${workerData.schema}"`);
  await client.query(`SET search_path TO "${workerData.schema}", public`);
  await client.query(`CREATE OR REPLACE VIEW sqlite_master AS
    SELECT tablename AS name, 'table'::text AS type, NULL::text AS sql FROM pg_tables WHERE schemaname=current_schema()
    UNION ALL SELECT indexname, 'index', NULL FROM pg_indexes WHERE schemaname=current_schema()`);
  reply({ ready: true });
} catch (error) { reply({ error: error.message, code: error.code }); await client.end().catch(() => {}); process.exit(1); }

port.on('message', async request => {
  try {
    if (request.close) { await client.end(); reply({ closed: true }); port.close(); return; }
    if (request.columns) {
      const columns = await client.query(`SELECT c.ordinal_position-1 AS cid,c.column_name AS name,
        c.data_type AS type,CASE WHEN c.is_nullable='NO' THEN 1 ELSE 0 END AS "notnull",c.column_default AS dflt_value,
        CASE WHEN EXISTS(SELECT 1 FROM information_schema.table_constraints t
          JOIN information_schema.key_column_usage k USING(constraint_catalog,constraint_schema,constraint_name)
          WHERE t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.constraint_type='PRIMARY KEY' AND k.column_name=c.column_name) THEN 1 ELSE 0 END AS pk
        FROM information_schema.columns c WHERE c.table_schema=current_schema() AND c.table_name=$1 ORDER BY c.ordinal_position`, [request.columns]);
      reply({ rows: columns.rows, rowCount: columns.rowCount }); return;
    }
    let sql = request.sql;
    if (request.insertTable && !/\bRETURNING\b/i.test(sql)) {
      const key = await client.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid
        AND a.attnum=ANY(i.indkey) WHERE i.indrelid=to_regclass($1) AND i.indisprimary
        AND a.attname='id' AND a.atttypid IN (20,21,23)`, [request.insertTable]);
      if (key.rows.length) sql += ' RETURNING id';
    }
    const query = await client.query(sql, request.parameters);
    reply({ rows: query.rows || [], rowCount: query.rowCount || 0 });
  } catch (error) {
    reply({ error: error.code === '42701' ? 'duplicate column: ' + error.message : error.message, code: error.code });
  }
});
// A parent crash must not retain a database session or transaction indefinitely.
parentPort.on('close', () => { client.end().catch(() => {}); });
