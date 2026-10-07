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
