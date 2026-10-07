import {createHash,randomUUID} from 'node:crypto';
import {MODEL_CATALOG,validateSettings} from './provider.mjs';
import {doubledCostMicros,problem} from './money.mjs';
import {requestPublic,boundedText} from './transport.mjs';

export class PlatformRelay {
  constructor(wallet,vault,{request=requestPublic}={}){this.wallet=wallet;this.vault=vault;this.request=request;this.cache=new Map();this.pendingPrices=new Map();this.active=new Map();}
  async json(provider,url,options={}) {
    const response=await this.request(provider.baseUrl+url,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+provider.apiKey},signal:options.signal||AbortSignal.timeout(10000)});
    if(!response.ok)throw problem(502, response.status===401||response.status===403?'上游 Key 无效或权限不足':'上游服务暂不可用');
    let payload;try{payload=JSON.parse(await boundedText(response));}catch(error){if(error.status)throw error;throw problem(502,'上游未返回有效 JSON');}return payload;
  }
  async probe(provider) {
    const payload=await this.json(provider,'/models');
    if(!Array.isArray(payload.data)||payload.data.length>1000)throw problem(502,'上游未返回有效模型列表');
    const ids=payload.data.map(row=>row.id);
    if(ids.some(id=>typeof id!=='string'||!id.trim()||id.length>256||id.includes(provider.apiKey)||/[\x00-\x1f]/.test(id)))throw problem(502,'上游模型列表无效');
    return {ok:true,models:[...new Set(ids)].sort(),message:'已读取模型列表；未发送收费聊天请求。'};
  }
  async balanceStatus({refresh=false}={}) {
    let provider;
    try {provider=this.vault.active();}
    catch {return {status:'disabled',availableBalance:null,currency:null,checkedAt:null,message:'尚未配置可用上游，请先保存并启用 API Key。'};}
    const key=createHash('sha256').update(JSON.stringify([provider.id,provider.baseUrl,provider.apiKey])).digest('hex');
    if(this.pendingBalance?.key===key)return this.pendingBalance.promise;
    if(!refresh&&this.balanceCache?.key===key&&Date.now()-this.balanceCache.time<60000)return this.balanceCache.snapshot;
    const promise=(async()=>{
      const snapshot={providerId:provider.id,providerName:provider.name,status:'unavailable',availableBalance:null,currency:null,checkedAt:new Date().toISOString()};
      try {
        const response=await this.request(provider.baseUrl+'/skills/balance',{headers:{Authorization:'Bearer '+provider.apiKey},signal:AbortSignal.timeout(10000)});
        if(!response.ok){
          await response.body?.cancel();
          snapshot.message=[401,403].includes(response.status)?'上游 Key 无效或没有余额查询权限。':[404,405].includes(response.status)?'此上游不支持余额查询接口。':'上游余额接口暂不可用，请稍后刷新。';
        }else{
          let payload;try{payload=JSON.parse(await boundedText(response,64*1024));}catch{payload=null;}
          const currency=payload?.currency,raw=payload?.available_balance;
          const amount=typeof raw==='string'&&currency==='USD'?raw.replace(/^\$/,''):raw;
          if(!['USD','CNY'].includes(currency)||typeof amount!=='string'||amount.length>40||!(/^-?\d+(\.\d+)?$/).test(amount)||!Number.isFinite(Number(amount))){
            snapshot.message='上游余额数据格式不完整，暂时无法读取。';
          }else Object.assign(snapshot,{status:Number(amount)>0?'available':'exhausted',availableBalance:amount,currency});
        }
      }catch{snapshot.message='无法连接上游余额接口，请稍后刷新。';}
      this.balanceCache={key,time:Date.now(),snapshot};return snapshot;
    })();
    this.pendingBalance={key,promise};
    try{return await promise;}finally{if(this.pendingBalance?.promise===promise)this.pendingBalance=null;}
  }
  async pricing(model,provider=this.vault.active()) {
    validateSettings(model,{});const key=createHash('sha256').update(JSON.stringify([provider.id,provider.baseUrl,provider.apiKey,model])).digest('hex');
    const cached=this.cache.get(key);if(cached&&Date.now()-cached.time<60000)return cached.price;
    if(this.pendingPrices.has(key))return this.pendingPrices.get(key);
    const pending=(async()=>{
      const raw=await this.json(provider,'/skills/models/'+encodeURIComponent(model)+'/pricing');
      if(!Array.isArray(raw.channel_groups)||raw.channel_groups.length>256)throw problem(502,'上游未返回有效渠道价格');
      let input=0,output=0,enabled=0;
      const channels=raw.channel_groups.map(group=>{
        const inPrice=doubledCostMicros(group.user_price_per_million_input_rmb,'CNY'),outPrice=doubledCostMicros(group.user_price_per_million_output_rmb,'CNY');
        if(typeof group.is_active!=='boolean'||typeof group.vendor!=='string'||!group.vendor||group.vendor.length>64)throw problem(502,'渠道价格数据不完整');
        if(group.is_active){enabled++;input=Math.max(input,inPrice);output=Math.max(output,outPrice);}
        return {vendor:group.vendor,lane:group.lane_no??0,enabled:group.is_active,inputMicrosPerMillion:inPrice,outputMicrosPerMillion:outPrice,
          statsSource:['live','estimated'].includes(group.stats_source)?group.stats_source:'unknown',successRate24h:Number.isFinite(group.success_rate_24h)&&group.success_rate_24h>=0&&group.success_rate_24h<=100?group.success_rate_24h:null,
          avgResponseSeconds:Number.isFinite(group.avg_response_seconds)&&group.avg_response_seconds>=0?group.avg_response_seconds:null};
      });
      if(!enabled)throw problem(503,'此模型没有可用的收费渠道');
      const price={maxInputMicrosPerMillion:input,maxOutputMicrosPerMillion:output,channels,updatedAt:new Date().toISOString(),source:'upstream',currency:'CNY'};
      this.cache.set(key,{price,time:Date.now()});return price;
    })();
    this.pendingPrices.set(key,pending);try{return await pending;}finally{this.pendingPrices.delete(key);}
  }
  async catalogue() {
    let provider;try{provider=this.vault.active();}catch(error){return {configured:false,message:error.message,policyVersion:'cash-v1-actual-x2',models:MODEL_CATALOG.map(model=>({...model,pricing:null}))};}
    // Limit price discovery to three concurrent requests, as in MapFlow.
    const models=[];
    for(let offset=0;offset<MODEL_CATALOG.length;offset+=3)models.push(...await Promise.all(MODEL_CATALOG.slice(offset,offset+3).map(async profile=>{
      try{return {...profile,pricing:await this.pricing(profile.id,provider)};}catch(error){return {...profile,pricing:null,error:error.message};}
    })));
    return {configured:true,provider:provider.name,policyVersion:'cash-v1-actual-x2',multiplierLabel:'上游实扣 × 2',models};
  }
  async complete(userId,incoming,{requestId=randomUUID(),signal}={}) {
    const provider=this.vault.active(),settings=validateSettings(incoming.model,incoming.novelking_settings||{});
    if(!Array.isArray(incoming.messages)||!incoming.messages.length||incoming.messages.length>512)throw problem(400,'消息内容不正确');
    for(const message of incoming.messages)if(!message||!['system','user','assistant','tool','developer'].includes(message.role))throw problem(400,'消息角色不正确');
    const maxTokens=Number(incoming.max_tokens??4096);
    if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>16384)throw problem(400,'输出上限须为 1–16384 token');
    if(incoming.temperature!==undefined&&(!Number.isFinite(incoming.temperature)||incoming.temperature<0||incoming.temperature>2))throw problem(400,'温度须为 0–2');
    const body={model:incoming.model,messages:incoming.messages,max_tokens:maxTokens,stream:true,stream_options:{include_usage:true},...settings,
      ...(incoming.temperature!==undefined?{temperature:incoming.temperature}:{}),...(incoming.tools?{tools:incoming.tools}:{}),...(incoming.tool_choice?{tool_choice:incoming.tool_choice}:{})};
    const encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>1024*1024)throw problem(413,'模型请求内容过大');
    const fingerprint=createHash('sha256').update(encoded).digest('hex');
    // Replay must work even if prices or the currently selected upstream changed.
    const previous=this.wallet.db.prepare('SELECT * FROM platform_calls WHERE user_id=? AND request_id=?').get(userId,requestId);
    if(previous?.status==='settled')return this.wallet.beginCall(userId,{requestId,fingerprint,model:body.model});
    if((this.active.get(userId)||0)>=2)throw problem(429,'最多同时进行两个平台模型调用');
    this.active.set(userId,(this.active.get(userId)||0)+1);
    let hold;
    try{
      hold=this.wallet.beginCall(userId,{requestId,fingerprint,model:body.model});if(hold.replayed)return hold;
      const cancellation=signal?AbortSignal.any([signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(300000);
      cancellation.throwIfAborted();
      const response=await this.request(provider.baseUrl+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+provider.apiKey},body:encoded,signal:cancellation});
      if(!response.ok){
        await response.body?.cancel();
        if(response.status===402)throw Object.assign(problem(502,'上游账户余额不足或上游额度受限，请管理员在后台查询上游余额'),{code:'upstream_balance_insufficient'});
        throw problem(502,[401,403].includes(response.status)?'上游 Key 无效或没有此模型的调用权限，请管理员检查上游配置':'上游模型请求失败，请稍后重试');
      }
      const text=await boundedText(response,8*1024*1024);cancellation.throwIfAborted();
      const parsed=parsePaidStream(text,body.model);
      const outcome=this.wallet.settle(userId,hold.id,{cost:parsed.cost,currency:'CNY',usage:parsed.response.usage,response:parsed.response});
      return {...outcome,frames:parsed.frames};
    }catch(error){
      if(hold&&!hold.replayed)this.wallet.release(userId,hold.id,'模型调用失败或取消');
      if(error.status)throw error;throw problem(502,'模型调用失败或取消，未完成的预留额度已释放');
    }finally{this.active.set(userId,Math.max(0,(this.active.get(userId)||1)-1));}
  }
}

export function parsePaidStream(text,model) {
  let done=false,content='',usage=null,cost=null,finish=null;const toolCalls=new Map(),frames=[];
  for(const block of text.split(/\r?\n\r?\n/)){
    const eventPayload=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(!eventPayload)continue;
    if(eventPayload==='[DONE]'){done=true;break;}
    let chunk;try{chunk=JSON.parse(eventPayload);}catch{throw problem(502,'上游流格式不正确');}
    if(chunk.error)throw problem(502,'上游生成失败');
    if(chunk.usage){
      if(Object.hasOwn(chunk.usage,'cost_rmb')){
        doubledCostMicros(chunk.usage.cost_rmb,chunk.usage.cost_currency);
        if(cost!==null&&String(cost)!==String(chunk.usage.cost_rmb))throw problem(502,'上游费用回执冲突');cost=chunk.usage.cost_rmb;
      }
      if(Object.hasOwn(chunk.usage,'prompt_tokens')||Object.hasOwn(chunk.usage,'completion_tokens')){
        const {prompt_tokens,completion_tokens}=chunk.usage;
        if(![prompt_tokens,completion_tokens].every(count=>Number.isSafeInteger(count)&&count>=0))throw problem(502,'上游 token 统计不完整');
        const cached=chunk.usage.prompt_cache_hit_tokens??chunk.usage.prompt_tokens_details?.cached_tokens??0;
        if(!Number.isSafeInteger(cached)||cached<0||cached>prompt_tokens)throw problem(502,'上游缓存用量不正确');
        usage={prompt_tokens,completion_tokens,total_tokens:prompt_tokens+completion_tokens,prompt_tokens_details:{cached_tokens:cached}};
      }
    }
    const choice=chunk.choices?.[0];if(choice){
      const delta=choice.delta||{};
      if(typeof delta.content==='string')content+=delta.content;
      if(choice.finish_reason)finish=choice.finish_reason;
      for(const tool of delta.tool_calls||[]){
        if(!Number.isInteger(tool.index)||tool.index<0||tool.index>127)throw problem(502,'上游工具调用无效');
        const previous=toolCalls.get(tool.index)||{id:'',type:'function',function:{name:'',arguments:''}};
        if(tool.id)previous.id=tool.id;if(tool.function?.name)previous.function.name+=tool.function.name;
        if(tool.function?.arguments)previous.function.arguments+=tool.function.arguments;toolCalls.set(tool.index,previous);
      }
      // Public chunks never contain upstream account balances or billing credentials.
      frames.push({id:chunk.id||'nk-completion',object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason:choice.finish_reason??null}]});
    }
  }
  if(!done||!usage||cost===null||(!content.trim()&&!toolCalls.size))throw problem(502,'上游未返回完整结果、用量或人民币账单');
  const message={role:'assistant',content:content||null,...(toolCalls.size?{tool_calls:[...toolCalls.values()]}:{})};
  return {cost,frames,response:{id:'nk-'+randomUUID(),object:'chat.completion',model,choices:[{index:0,message,finish_reason:finish||(toolCalls.size?'tool_calls':'stop')}],usage}};
}
