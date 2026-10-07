import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../storage/postgres.mjs';
import {PlatformStore} from '../platform/store.mjs';
import {PlatformRelay} from '../platform/relay.mjs';
import {createPlatformSystem} from '../platform/http.mjs';
import {ProviderVault} from '../platform/provider.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('PostgreSQL rejects a second account controller before it can release an active call',{skip:!process.env.NOVELKING_TEST_DATABASE_URL},()=>{
  const schema='nk_test_controller_'+randomUUID().replaceAll('-',''),root=fs.mkdtempSync(path.join(os.tmpdir(),'nk-controller-'));
  const first=new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL,schema);let second;
  try{
    first.exec("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,disabled INTEGER);INSERT INTO users VALUES('alice','user',0),('admin','admin',0)");
    const platform=createPlatformSystem({accountStore:{db:first},root,env:{}});
    platform.vault.save('admin',{name:'Fixture',apiKey:'fixture-pg-upstream-secret',enabled:true});
    platform.wallet.reserve('alice',{requestId:'live',fingerprint:'same',model:'deepseek-v4-flash',amountMicros:1000});
    second=new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL,schema);
    assert.equal(new ProviderVault(second,root).active().apiKey,'fixture-pg-upstream-secret');
    assert.ok(!first.prepare('SELECT key_cipher FROM platform_providers').get().key_cipher.includes('fixture-pg-upstream-secret'));
    assert.throws(()=>createPlatformSystem({accountStore:{db:second},root,env:{}}),/账户服务.*运行/);
    assert.equal(platform.wallet.wallet('alice').heldMicros,1000);
  }finally{second?.close();if(!/^nk_test_controller_[a-f0-9]{32}$/.test(schema))throw Error('Invalid cleanup schema');first.exec(`DROP SCHEMA "${schema}" CASCADE`);first.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('real PostgreSQL shared wallet grants once across clients, holds are integer and concurrent generations cannot overspend',{skip:!process.env.NOVELKING_TEST_DATABASE_URL},async()=>{
  const schema='nk_test_platform_'+randomUUID().replaceAll('-',''),first=new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL,schema);let second;
  try {
    first.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,role TEXT,disabled INTEGER DEFAULT 0);INSERT INTO users VALUES('alice','Alice','user',0)");
    const wallet=new PlatformStore(first);second=new PostgresDatabase(process.env.NOVELKING_TEST_DATABASE_URL,schema);const other=new PlatformStore(second);
    assert.equal(wallet.wallet('alice').heldMicros,0);
    assert.equal(other.wallet('alice').ledger.filter(entry=>entry.kind==='welcome').length,1);
    let release;const pending=new Promise(resolve=>release=resolve),vault={active:()=>({id:'fake',baseUrl:'https://example.com/v1',apiKey:'fixture-key'})};
    const pricing={channel_groups:[{vendor:'fixture',is_active:true,user_price_per_million_input_rmb:'0.8',user_price_per_million_output_rmb:'1.6'}]};
    const request=async url=>url.includes('/pricing')?Response.json(pricing):(await pending,new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":31,"cost_rmb":"0.00023","cost_currency":"CNY"}}\n\ndata: [DONE]\n\n'));
    const one=new PlatformRelay(wallet,vault,{request}),two=new PlatformRelay(other,vault,{request}),body={model:'deepseek-v4-flash',messages:[{role:'user',content:'hello'}],max_tokens:16384};
    const running=one.complete('alice',body,{requestId:'first'});
    await new Promise(resolve=>setTimeout(resolve,20));
    await assert.rejects(()=>two.complete('alice',body,{requestId:'second'}),/不足/);
    release();assert.equal((await running).response.novelking_billing.chargedMicros,460);
    assert.equal(other.wallet('alice').balanceMicros,99540);assert.equal(other.wallet('alice').heldMicros,0);
  }finally{second?.close();if(!/^nk_test_platform_[a-f0-9]{32}$/.test(schema))throw Error('Invalid cleanup schema');first.exec(`DROP SCHEMA "${schema}" CASCADE`);first.close();}
});
