import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PlatformStore} from '../platform/store.mjs';
import {RechargeStore} from '../platform/recharge.mjs';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7mgAAAAASUVORK5CYII=';
function setup(){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,role TEXT,disabled INTEGER); INSERT INTO users VALUES('admin','admin','admin',0),('alice','alice','user',0),('bob','bob','user',0)");const wallet=new PlatformStore(db);return {db,wallet,recharge:new RechargeStore(wallet)};}
test('topup is isolated and idempotent; declaring paid never credits and review requires unique receipt',()=>{
  const {db,wallet,recharge}=setup();
  try {
    recharge.uploadChannel('admin','wechat',image);
    const order=recharge.create('alice',{requestId:'first',amountFen:100,channel:'wechat'});
    assert.equal(recharge.create('alice',{requestId:'first',amountFen:100,channel:'wechat'}).id,order.id);
    assert.throws(()=>recharge.get('bob',order.id),/不存在/);
    assert.throws(()=>recharge.create('alice',{requestId:'first',amountFen:200,channel:'wechat'}),/改变/);
    recharge.declare('alice',order.id,true); assert.equal(wallet.wallet('alice').balanceMicros,100000);
    recharge.review('admin',order.id,{approve:true,receipt:'fixture-receipt',note:''});
    assert.equal(wallet.wallet('alice').balanceMicros,1100000);
    recharge.review('admin',order.id,{approve:true,receipt:'fixture-receipt',note:''});
    assert.equal(wallet.wallet('alice').ledger.filter(entry=>entry.kind==='topup').length,1);
    const duplicate=recharge.create('bob',{requestId:'second',amountFen:100,channel:'wechat'});recharge.declare('bob',duplicate.id,true);
    assert.throws(()=>recharge.review('admin',duplicate.id,{approve:true,receipt:'fixture-receipt',note:''}),/凭证/);
    assert.equal(wallet.wallet('bob').balanceMicros,100000);
  } finally {db.close();}
});
test('payment display is FIFO, owner bound, twenty seconds, and repeated joins cannot extend it',()=>{
  const {db,recharge}=setup();try{
    recharge.uploadChannel('admin','wechat',image);
    const first=recharge.create('alice',{requestId:'a',amountFen:100,channel:'wechat'}),second=recharge.create('bob',{requestId:'b',amountFen:100,channel:'wechat'});
    const active=recharge.display('alice',first.id,'join',null,100000);
    assert.equal(active.status,'active');assert.equal(active.expiresAt,120000);
    assert.equal(recharge.display('alice',first.id,'join',active.windowId,101000).expiresAt,120000);
    const waiting=recharge.display('bob',second.id,'join',null,101000);assert.equal(waiting.status,'waiting');assert.equal(waiting.imageUrl,null);
    assert.throws(()=>recharge.image('bob',active.windowId,101000),/不存在/);
    recharge.display('bob',second.id,'poll',waiting.windowId,111000);
    assert.equal(recharge.display('bob',second.id,'poll',waiting.windowId,121000).status,'active');
  }finally{db.close();}
});
