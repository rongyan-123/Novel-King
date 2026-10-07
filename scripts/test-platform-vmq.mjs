import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PlatformStore} from '../platform/store.mjs';
import {RechargeStore} from '../platform/recharge.mjs';
import {VmqGateway} from '../platform/vmq.mjs';
const qr='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7mgAAAAASUVORK5CYII=';
test('VMQ matches signed callbacks against a paid upstream order, credits actual fen once, rejects forgeries',async()=>{
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,disabled INTEGER); INSERT INTO users VALUES('admin','admin',0),('alice','user',0)");
  const wallet=new PlatformStore(db),recharge=new RechargeStore(wallet);recharge.uploadChannel('admin','wechat',qr);
  const topup=recharge.create('alice',{requestId:'vmq',amountFen:100,channel:'wechat'}),key='fixture-private-vmq-key';let paid=false;
  const order={payId:topup.id,orderId:'fixture-order',payType:1,price:1,reallyPrice:1.03,state:0,timeOut:5,date:Date.now(),payDate:Date.now()};
  const vmq=new VmqGateway(recharge,{baseUrl:'http://vmq:8080',key,notifyUrl:'https://novel.example/api/platform/vmq/notify',returnUrl:'https://novel.example/'},{request:async()=>Response.json({code:1,data:{...order,state:paid?1:0}})});
  try {
    await vmq.attach(topup);
    const callback={payId:topup.id,param:'novelking-v1',type:'1',price:'1.00',reallyPrice:'1.03'};
    callback.sign=createHash('md5').update(callback.payId+callback.param+callback.type+callback.price+callback.reallyPrice+key).digest('hex');
    await assert.rejects(()=>vmq.notify({...callback,sign:'0'.repeat(32)}));
    await assert.rejects(()=>vmq.notify(callback));assert.equal(wallet.wallet('alice').balanceMicros,100000);
    paid=true;await vmq.notify(callback);assert.equal(wallet.wallet('alice').balanceMicros,1130000);
    await vmq.notify(callback);assert.equal(wallet.wallet('alice').ledger.filter(entry=>entry.kind==='topup').length,1);
    await assert.rejects(()=>vmq.notify({...callback,reallyPrice:'2.00'}));
  }finally{db.close();}
});
