import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PlatformStore} from '../platform/store.mjs';
import {PlatformRelay} from '../platform/relay.mjs';
const prices={channel_groups:[{vendor:'A',lane_no:1,is_active:true,user_price_per_million_input_rmb:'0.8',user_price_per_million_output_rmb:'1.6',stats_source:'live',success_rate_24h:99,avg_response_seconds:1.2},{vendor:'B',is_active:false,user_price_per_million_input_rmb:'80',user_price_per_million_output_rmb:'160',stats_source:'estimated'}]};
function fixture(){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,disabled INTEGER);INSERT INTO users VALUES('alice','user',0)");const store=new PlatformStore(db);return {db,store,vault:{active:()=>({id:'provider',baseUrl:'https://example.com/v1',apiKey:'fixture-upstream-secret'})}};}
const stream=cost=>new Response(`data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":31,"prompt_tokens_details":{"cached_tokens":8}}}\n\ndata: {"usage":${JSON.stringify(cost)}}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
test('relay reads real prices, preserves tokens on cost-only tail, bills once and hides upstream balance/key',async()=>{
  const {db,store,vault}=fixture();let calls=0;
  const relay=new PlatformRelay(store,vault,{request:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer fixture-upstream-secret');if(url.includes('/pricing'))return Response.json(prices);calls++;return stream({cost_rmb:'0.00023',cost_currency:'CNY',balance_rmb:999});}});
  try {
    const price=await relay.pricing('deepseek-v4-flash');assert.equal(price.maxInputMicrosPerMillion,1600000);assert.equal(price.channels[1].statsSource,'estimated');
    const body={model:'deepseek-v4-flash',messages:[{role:'user',content:'Hi'}],max_tokens:100,stream:true};
    const completion=await relay.complete('alice',body,{requestId:'test-1'});
    assert.equal(completion.response.choices[0].message.content,'Hello');assert.equal(completion.response.usage.prompt_tokens,12);
    assert.equal(completion.response.novelking_billing.chargedMicros,460);assert.equal(store.wallet('alice').balanceMicros,99540);
    assert.equal((await relay.complete('alice',body,{requestId:'test-1'})).replayed,true);assert.equal(calls,1);
    assert.ok(!JSON.stringify(completion).includes('balance_rmb'));assert.ok(!JSON.stringify(completion).includes('fixture-upstream-secret'));
  }finally{db.close();}
});
test('missing or conflicting bills and partial streams never save success or deduct; no-Key probe calls only models',async()=>{
  const {db,store,vault}=fixture();
  const relay=new PlatformRelay(store,vault,{request:async(url)=>url.includes('/pricing')?Response.json(prices):url.endsWith('/models')?Response.json({data:[{id:'z'},{id:'a'},{id:'a'}]}):stream({})});
  try{await assert.rejects(()=>relay.complete('alice',{model:'deepseek-v4-flash',messages:[{role:'user',content:'Hello'}],max_tokens:100},{requestId:'bad'}),/账单/);assert.equal(store.wallet('alice').balanceMicros,100000);assert.equal(store.wallet('alice').heldMicros,0);assert.deepEqual((await relay.probe(vault.active())).models,['a','z']);}finally{db.close();}
});

test('rotating a provider key immediately reads that key’s own prices',async()=>{
  const {db,store,vault}=fixture();let key='fixture-upstream-secret',reads=0;
  vault.active=()=>({id:'provider',baseUrl:'https://example.com/v1',apiKey:key});
  const relay=new PlatformRelay(store,vault,{request:async()=>{reads++;return Response.json(prices);}});
  try{await relay.pricing('deepseek-v4-flash');key='fixture-rotated-secret';await relay.pricing('deepseek-v4-flash');assert.equal(reads,2);}finally{db.close();}
});

test('a positive wallet sends with production-sized pricing instead of failing 402 on a maximum-price hold',async()=>{
  const {db,store,vault}=fixture();let calls=0;
  const relay=new PlatformRelay(store,vault,{request:async(url)=>{
    if(url.includes('/pricing'))return Response.json({channel_groups:[{vendor:'fixture',is_active:true,user_price_per_million_input_rmb:'3.4760048085',user_price_per_million_output_rmb:'10.4280144255'}]});
    calls++;return stream({cost_rmb:'0.00023',cost_currency:'CNY'});
  }});
  try {
    assert.equal(store.wallet('alice').balanceMicros,100000);
    const completion=await relay.complete('alice',{model:'deepseek-v4-flash',messages:[{role:'user',content:'Hello'}],max_tokens:4096});
    assert.equal(completion.chargedMicros,460);assert.equal(calls,1);assert.equal(store.wallet('alice').balanceMicros,99540);
  } finally {db.close();}
});

test('upstream balance preserves currency and precision, deduplicates reads and invalidates after key rotation',async()=>{
  const {db,store,vault}=fixture();let reads=0,key='fixture-first-key';
  vault.active=()=>({id:'provider',name:'Fixture',baseUrl:'https://example.com/v1',apiKey:key});
  const relay=new PlatformRelay(store,vault,{request:async(url,options)=>{
    assert.equal(url,'https://example.com/v1/skills/balance');assert.equal(options.headers.Authorization,'Bearer '+key);reads++;
    return Response.json({available_balance:'$1.181264',currency:'USD',api_key:key,balance_rmb:999});
  }});
  try {
    const [balance,duplicate]=await Promise.all([relay.balanceStatus(),relay.balanceStatus()]);
    assert.deepEqual(duplicate,balance);assert.equal(reads,1);
    assert.equal(balance.availableBalance,'1.181264');assert.equal(balance.currency,'USD');assert.equal(balance.status,'available');assert.ok(Date.parse(balance.checkedAt));
    assert.doesNotMatch(JSON.stringify(balance),/fixture-first-key|balance_rmb|999/);
    assert.deepEqual(await relay.balanceStatus(),balance);assert.equal(reads,1);
    await relay.balanceStatus({refresh:true});assert.equal(reads,2);
    key='fixture-second-key';await relay.balanceStatus();assert.equal(reads,3);
    assert.equal(store.wallet('alice').balanceMicros,100000);
  } finally {db.close();}
});

test('balance query distinguishes zero, missing, unsupported, invalid credentials and network failure without leaking upstream text',async()=>{
  const {db,store,vault}=fixture();
  try {
    for(const [response,status,amount,message] of [
      [Response.json({available_balance:'$0.000000',currency:'USD'}),'exhausted','0.000000',null],
      [Response.json({available_balance:'-$0.20',currency:'USD'}),'unavailable',null,/格式/],
      [Response.json({available_balance:'garbled',currency:'USD'}),'unavailable',null,/格式/],
      [Response.json({available_balance:'$1.00',currency:'???'}),'unavailable',null,/格式/],
      [Response.json({}),'unavailable',null,/格式/],
      [new Response('fixture-upstream-secret',{status:404}),'unavailable',null,/不支持/],
      [new Response('fixture-upstream-secret',{status:401}),'unavailable',null,/Key/],
      [new Error('fixture-upstream-secret'),'unavailable',null,/连接/]
    ]){
      const relay=new PlatformRelay(store,vault,{request:async()=>{if(response instanceof Error)throw response;return response;}});
      const balance=await relay.balanceStatus();assert.equal(balance.status,status);assert.equal(balance.availableBalance,amount);
      if(message)assert.match(balance.message,message);assert.doesNotMatch(JSON.stringify(balance),/fixture-upstream-secret/);
    }
    const unavailable=new PlatformRelay(store,{active:()=>{throw Error('not configured');}},{request:async()=>{throw Error('must not request');}});
    assert.equal((await unavailable.balanceStatus()).status,'disabled');
  } finally {db.close();}
});

test('upstream payment failure identifies the upstream account and releases the user balance',async()=>{
  const {db,store,vault}=fixture();
  const relay=new PlatformRelay(store,vault,{request:async()=>new Response('fixture-upstream-secret',{status:402})});
  try {
    await assert.rejects(()=>relay.complete('alice',{model:'deepseek-v4-flash',messages:[{role:'user',content:'Hello'}],max_tokens:256}),error=>error.code==='upstream_balance_insufficient'&&/上游.*余额/.test(error.message)&&!error.message.includes('fixture-upstream-secret'));
    assert.equal(store.wallet('alice').balanceMicros,100000);assert.equal(store.wallet('alice').heldMicros,0);
  } finally {db.close();}
});
