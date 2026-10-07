import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PlatformStore } from '../platform/store.mjs';
export function fixture(database = new DatabaseSync(':memory:')) {
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT,role TEXT,disabled INTEGER DEFAULT 0,created_at TEXT DEFAULT '2026-10-07');");
  for (const id of ['alice','bob','admin']) database.prepare('INSERT INTO users(id,username,role) VALUES(?,?,?)').run(id,id,id === 'admin' ? 'admin' : 'user');
  return new PlatformStore(database);
}
test('wallet welcome is once per active account; holds reduce spendable balance and failed calls restore it', () => {
  const store = fixture();
  try {
    assert.equal(store.wallet('alice').balanceMicros, 100000);
    assert.equal(store.wallet('alice').ledger.length, 1);
    const hold = store.reserve('alice', { requestId:'one', fingerprint:'a', model:'m', amountMicros:80000 });
    assert.equal(store.wallet('alice').balanceMicros,20000);
    assert.throws(() => store.reserve('alice', { requestId:'two', fingerprint:'b', model:'m', amountMicros:30000 }), /不足/);
    assert.equal(store.wallet('bob').balanceMicros,100000);
    store.release('alice',hold.id,'cancelled');
    assert.equal(store.wallet('alice').balanceMicros,100000);
    assert.throws(() => store.settle('alice',hold.id,{ cost:'0.01',currency:'CNY',usage:{prompt_tokens:1,completion_tokens:1},response:{} }), /已终止/);
    assert.equal(store.wallet('alice').ledger.length,1);
  } finally { store.db.close(); }
});
test('success settles exactly once, retries replay results, fees cap at quote and adjustments cannot spend held money', () => {
  const store=fixture();
  try {
    const hold=store.reserve('alice',{requestId:'paid',fingerprint:'f',model:'m',amountMicros:10000});
    const outcome=store.settle('alice',hold.id,{cost:'0.00023',currency:'CNY',usage:{prompt_tokens:12,completion_tokens:31},response:{choices:[{message:{content:'Hello'}}]}});
    assert.equal(outcome.chargedMicros,460); assert.equal(outcome.balanceMicros,99540);
    assert.equal(store.reserve('alice',{requestId:'paid',fingerprint:'f',model:'m',amountMicros:10000}).replayed,true);
    assert.throws(() => store.reserve('alice',{requestId:'paid',fingerprint:'changed',model:'m',amountMicros:10000}),/不能改变/);
    assert.equal(store.wallet('alice').ledger.filter(entry=>entry.kind==='usage').length,1);
    const second=store.reserve('alice',{requestId:'capped',fingerprint:'c',model:'m',amountMicros:10000});
    assert.throws(()=>store.adjust('admin','alice',{requestId:'overspend',amountFen:-9,note:'cannot spend held cash'}),/预留/);
    assert.equal(store.adjust('admin','alice',{requestId:'add',amountFen:100,note:'测试增加'}).balanceMicros,1089540);
    assert.equal(store.adjust('admin','alice',{requestId:'add',amountFen:100,note:'测试增加'}).replayed,true);
    const capped=store.settle('alice',second.id,{cost:'1',currency:'CNY',usage:{prompt_tokens:1,completion_tokens:1},response:{}});
    assert.equal(capped.chargedMicros,10000); assert.equal(capped.capped,true);
    const added=store.wallet('alice').ledger.find(entry=>entry.kind==='adjustment');
    store.reverse('admin',added.id,'撤销测试');
    assert.equal(store.wallet('alice').balanceMicros,89540);
    assert.throws(()=>store.reverse('admin',added.id,'重复撤销'),/撤销/);
  } finally {store.db.close();}
});
test('disabling an account during generation must still release the abandoned hold',()=>{
  const store=fixture();try{const hold=store.reserve('alice',{requestId:'disabled',fingerprint:'d',model:'m',amountMicros:80000});store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run('alice');store.release('alice',hold.id,'disabled');store.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run('alice');assert.equal(store.wallet('alice').heldMicros,0);assert.equal(store.wallet('alice').balanceMicros,100000);}finally{store.db.close();}
});

test('postpaid calls settle the whole bill once, persist debt, block parallel calls and resume only after debt is covered',()=>{
  const store=fixture();
  try {
    const call=store.beginCall('alice',{requestId:'postpaid',fingerprint:'same',model:'m'});
    assert.throws(()=>store.beginCall('alice',{requestId:'parallel',fingerprint:'other',model:'m'}),error=>error.status===429);
    const paid=store.settle('alice',call.id,{cost:'0.08',currency:'CNY',usage:{prompt_tokens:1,completion_tokens:1},response:{}});
    assert.equal(paid.chargedMicros,160000);assert.equal(paid.balanceMicros,-60000);assert.equal(paid.capped,false);
    assert.equal(store.beginCall('alice',{requestId:'postpaid',fingerprint:'same',model:'m'}).replayed,true);
    assert.equal(store.wallet('alice').ledger.filter(row=>row.kind==='usage').length,1);
    assert.throws(()=>store.beginCall('alice',{requestId:'empty',fingerprint:'same',model:'m'}),error=>error.status===402&&/平台额度/.test(error.message));
    assert.equal(store.adjust('admin','alice',{requestId:'partial',amountFen:1,note:'部分补款'}).balanceMicros,-50000);
    assert.equal(new PlatformStore(store.db).wallet('alice').balanceMicros,-50000);
    store.adjust('admin','alice',{requestId:'replenish',amountFen:10,note:'补足欠费'});
    const retry=store.beginCall('alice',{requestId:'new-call',fingerprint:'other',model:'m'});
    store.release('alice',retry.id,'cancelled');assert.equal(store.wallet('alice').balanceMicros,50000);
  } finally {store.db.close();}
});

test('existing nonnegative wallet schema migrates without losing balances, ledger or legacy calls',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,role TEXT,disabled INTEGER DEFAULT 0,created_at TEXT);INSERT INTO users VALUES('alice','alice','user',0,'2026-10-07');CREATE TABLE platform_wallets(user_id TEXT PRIMARY KEY REFERENCES users(id),balance_micros INTEGER NOT NULL CHECK(balance_micros BETWEEN 0 AND 9000000000000000));INSERT INTO platform_wallets VALUES('alice',7)");
  const store=new PlatformStore(db);
  try {
    assert.equal(store.wallet('alice').balanceMicros,7);
    const call=store.beginCall('alice',{requestId:'migrated',fingerprint:'f',model:'m'});
    store.settle('alice',call.id,{cost:'0.00023',currency:'CNY',usage:{prompt_tokens:1,completion_tokens:1},response:{}});
    assert.equal(new PlatformStore(db).wallet('alice').balanceMicros,-453);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  } finally {db.close();}
});
