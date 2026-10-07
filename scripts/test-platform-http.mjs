import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createAccountServer} from '../account-server.mjs';
let app,origin,admin,user;const password='Fixture-password-2026',directory=fs.mkdtempSync(path.join(os.tmpdir(),'nk-platform-http-'));
let modelCalls=0;
async function request(route,{method='GET',body,cookie=user}={}) {
  const response=await fetch(origin+route,{method,headers:{Origin:origin,Cookie:cookie||'',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
before(async()=>{
  const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));origin='http://127.0.0.1:'+port;
  app=await createAccountServer({PORT:String(port),NOVELKING_PUBLIC_ORIGIN:origin,NOVELKING_ACCOUNT_ROOT:directory,NOVELKING_ADMIN_USER:'owner',NOVELKING_ADMIN_PASSWORD:password},{platformRequest:async(url,options)=>{
    if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-v4-flash'}]});
    if(url.includes('/pricing'))return Response.json({channel_groups:[{vendor:'fixture',is_active:true,user_price_per_million_input_rmb:'0.8',user_price_per_million_output_rmb:'1.6',stats_source:'unknown'}]});
    modelCalls++;
    if(JSON.parse(options.body).messages[0].content==='tool-round')return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"fixture-call","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":31,"cost_rmb":"0.00023","cost_currency":"CNY"}}\n\ndata: [DONE]\n\n');
    return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":31}}\n\ndata: {"usage":{"cost_rmb":"0.00023","cost_currency":"CNY"}}\n\ndata: [DONE]\n\n');
  }});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  admin=(await request('/api/account/login',{method:'POST',body:{username:'owner',password},cookie:''})).cookie;
  const challenge=(await request('/api/account/challenge',{cookie:''})).body,[left,operator,right]=challenge.question.split(' ');
  user=(await request('/api/account/register',{method:'POST',body:{username:'alice',password,challenge_id:challenge.id,answer:operator==='+'?Number(left)+Number(right):Number(left)*Number(right)},cookie:''})).cookie;
});
after(async()=>{const exited=[...app.workers.workers.values()].map(worker=>new Promise(resolve=>worker.child?.once('exit',resolve)));app?.close();await Promise.all(exited);fs.rmSync(directory,{recursive:true,force:true});});
test('platform administration requires admin role, password and never returns private keys',async()=>{
  assert.equal((await request('/api/platform/wallet',{cookie:''})).status,401);
  assert.equal((await request('/api/platform/admin/overview')).status,403);
  assert.equal((await request('/api/platform/admin/overview',{cookie:admin})).status,200);
  const fields={name:'爱你 AI',apiKey:'fixture-private-upstream-key',baseUrl:'https://anyai.token6688.com/v1',enabled:true};
  assert.equal((await request('/api/platform/admin/providers',{method:'POST',cookie:admin,body:fields})).status,400);
  const saved=await request('/api/platform/admin/providers',{method:'POST',cookie:admin,body:{...fields,password}});assert.equal(saved.status,201);
  assert.ok(!JSON.stringify(saved.body).includes(fields.apiKey));
  assert.equal((await request('/api/platform/admin/provider-probe',{method:'POST',cookie:admin,body:{password}})).body.ok,true);
  assert.equal(modelCalls,0);
  assert.equal((await request('/api/platform/wallet')).body.balanceMicros,100000);
});
test('existing model selection, writing and DSH use the platform relay without exposing upstream key or changing personal config behavior',async()=>{
  const response=await request('/api/api_configs');assert.equal(response.status,200);
  const config=response.body.find(entry=>entry.access_mode==='platform'&&entry.model==='deepseek-v4-flash');assert.ok(config);
  assert.ok(!JSON.stringify(response.body).includes('fixture-private-upstream-key'));
  const probe=await request('/api/ai/test',{method:'POST',body:{config_id:config.id}});assert.equal(probe.status,200);assert.equal(modelCalls,0);
  const chat=await request('/api/ai/chat',{method:'POST',body:{config_id:config.id,messages:[{role:'user',content:'Hi'}],max_tokens:100}});
  assert.equal(chat.status,200,JSON.stringify(chat.body));assert.equal(chat.body.reply,'Hello');assert.equal(chat.body.raw.novelking_billing.chargedMicros,460);
  assert.equal((await request('/api/platform/wallet')).body.balanceMicros,99540);
  assert.equal((await request('/api/api_configs/'+config.id,{method:'DELETE'})).status,403);
  const research=await request('/api/research/runs',{method:'POST',body:{config_id:config.id,skill:'ranking-research',prompt:'只回复 Hello'}});
  assert.equal(research.status,201,JSON.stringify(research.body));assert.equal(research.body.status,'complete');
  assert.equal((await request('/api/platform/wallet')).body.balanceMicros,99080);
});
test('administrator sees users and real usage, manages announcements, feedback and invitations, and configures model settings',async()=>{
  const users=await request('/api/platform/admin/users?search=alice',{cookie:admin});assert.equal(users.status,200);assert.equal(users.body.users.length,1);
  const alice=users.body.users[0];assert.equal(alice.username,'alice');assert.equal(alice.charged_micros,920);assert.ok(!JSON.stringify(alice).includes('password_hash'));
  assert.equal((await request('/api/platform/admin/requests',{cookie:admin})).body.calls.length,2);
  assert.equal((await request('/api/platform/admin/ledger',{cookie:admin})).status,200);
  const announcement=await request('/api/platform/admin/announcements',{method:'POST',cookie:admin,body:{password,title:'测试公告',content:'维护说明',published:true}});assert.equal(announcement.status,201);
  assert.equal((await request('/api/platform/announcements')).body.announcements[0].title,'测试公告');
  const feedback=await request('/api/platform/feedback',{method:'POST',body:{message:'测试反馈'}});assert.equal(feedback.status,201);
  assert.equal((await request('/api/platform/admin/feedback',{method:'PATCH',cookie:admin,body:{password,id:feedback.body.id,reply:'已收到',status:'replied'}})).status,200);
  assert.equal((await request('/api/platform/feedback')).body.feedback[0].reply,'已收到');
  assert.equal((await request('/api/platform/admin/invitations',{method:'POST',cookie:admin,body:{password,maxUses:1}})).status,201);
  const preference=await request('/api/platform/preferences',{method:'POST',body:{model:'deepseek-v4-flash',settings:{thinking:'false'}}});assert.equal(preference.status,200);
  assert.deepEqual((await request('/api/platform/preferences?model=deepseek-v4-flash')).body.settings,{thinking:'false'});
  assert.equal((await request('/api/platform/admin/model-policy',{method:'PUT',cookie:admin,body:{password,models:['deepseek-v4-flash']}})).status,200);
  const catalogue=(await request('/api/platform/models')).body;
  assert.equal(catalogue.models.find(model=>model.id==='deepseek-v4-flash').enabled,true);
  assert.equal(catalogue.models.find(model=>model.id==='gpt-5.4').enabled,false);
  assert.equal((await request('/api/platform/admin/audit',{cookie:admin})).status,200);
  const disabled=await request('/api/platform/admin/users/'+alice.id,{method:'PATCH',cookie:admin,body:{password,disabled:true}});assert.equal(disabled.status,200);
  assert.equal((await request('/api/platform/wallet')).status,401);
  assert.equal((await request('/api/platform/admin/users/'+alice.id,{method:'PATCH',cookie:admin,body:{password,disabled:false}})).status,200);
});

test('public users cannot impersonate a worker at the internal platform gateway',async()=>{
  const users=(await request('/api/platform/admin/users?search=alice',{cookie:admin})).body.users;
  const response=await request('/internal/platform/'+users[0].id+'/v1/chat/completions',{method:'POST',cookie:admin,body:{model:'deepseek-v4-flash',messages:[{role:'user',content:'Hi'}],user_id:users[0].id,cost_rmb:0}});
  assert.equal(response.status,403);
  assert.equal(modelCalls,2);
});
test('required invitations are consumed atomically and invalid or exhausted codes cannot create accounts',async()=>{
  const invite=(await request('/api/platform/admin/invitations',{method:'POST',cookie:admin,body:{password,maxUses:1}})).body;
  assert.equal((await request('/api/platform/admin/invite-policy',{method:'PUT',cookie:admin,body:{password,required:true}})).status,200);
  assert.equal((await request('/api/account/status',{cookie:''})).body.invitation_required,true);
  async function signup(username,code){const {body:challenge}=await request('/api/account/challenge',{cookie:''});const [a,op,b]=challenge.question.split(' ');return request('/api/account/register',{method:'POST',cookie:'',body:{username,password,invitation_code:code,challenge_id:challenge.id,answer:op==='+'?Number(a)+Number(b):Number(a)*Number(b)}});}
  assert.equal((await signup('invite-bad','bad')).status,400);
  assert.equal((await signup('invite-ok',invite.code)).status,201);
  assert.equal((await signup('invite-repeat',invite.code)).status,400);
  assert.equal((await request('/api/platform/admin/users?search=invite-repeat',{cookie:admin})).body.users.length,0);
});

test('replaying a streamed tool call preserves OpenAI tool indexes and bills only the first call',async()=>{
  user=(await request('/api/account/login',{method:'POST',body:{username:'alice',password},cookie:''})).cookie;
  await request('/api/api_configs');
  const alice=(await request('/api/platform/admin/users?search=alice',{cookie:admin})).body.users[0],worker=app.workers.workers.get(alice.id);
  const beforeCalls=modelCalls;
  async function streamed(){const response=await fetch(origin+'/internal/platform/'+alice.id+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+worker.token,'idempotency-key':'streamed-tool-replay'},body:JSON.stringify({model:'deepseek-v4-flash',messages:[{role:'user',content:'tool-round'}],max_tokens:100,stream:true})});assert.equal(response.status,200);return (await response.text()).split('\n\n').filter(frame=>frame.startsWith('data: {')).map(frame=>JSON.parse(frame.slice(6)));}
  for(let index=0;index<2;index++){const frames=await streamed(),tool=frames.flatMap(frame=>frame.choices?.[0]?.delta.tool_calls||[])[0];assert.equal(tool.index,0);assert.equal(tool.function.name,'lookup');}
  assert.equal(modelCalls,beforeCalls+1);
  assert.equal((await request('/api/platform/wallet')).body.balanceMicros,98620);
});
