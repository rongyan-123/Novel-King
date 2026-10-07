import fs from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {PlatformStore} from './store.mjs';
import {ProviderVault,MODEL_CATALOG} from './provider.mjs';
import {RechargeStore} from './recharge.mjs';
import {PlatformRelay} from './relay.mjs';
import {VmqGateway} from './vmq.mjs';
import {Administration} from './admin.mjs';
import {problem} from './money.mjs';

export const sendPlatform=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
export async function platformBody(req,maximum=8192) {
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw problem(415,'请提交 JSON');
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maximum)throw problem(413,'请求太大');chunks.push(chunk);}
  try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw Error();return parsed;}catch{throw problem(400,'JSON 格式不正确');}
}
export function createPlatformSystem({accountStore,root,env,request}) {
  // One controller owns crash recovery; PostgreSQL releases this lock on disconnect.
  if(accountStore.db.kind==='postgres'&&!accountStore.db.prepare('SELECT pg_try_advisory_lock(hashtext(current_database()),hashtext(?)) AS acquired').get(accountStore.db.schema+':platform-controller').acquired)throw Error('此数据库的账户服务已经运行，请使用单个账户服务实例');
  const wallet=new PlatformStore(accountStore.db),vault=new ProviderVault(accountStore.db,root),recharge=new RechargeStore(wallet),relay=new PlatformRelay(wallet,vault,{request});
  const administration=new Administration(wallet);
  let vmq=null;
  if(env.NOVELKING_VMQ_CONFIG_FILE){try{vmq=new VmqGateway(recharge,JSON.parse(fs.readFileSync(env.NOVELKING_VMQ_CONFIG_FILE,'utf8')));}catch{throw Error('Novel-King VMQ 私有配置文件无效');}}
  wallet.recoverAbandoned();
  // Backfill existing active accounts using the same once-only grant as new accounts.
  for(const user of accountStore.db.prepare('SELECT id FROM users WHERE disabled=0').all())wallet.wallet(user.id);
  async function internal(req,res,url,workers) {
    const match=/^\/internal\/platform\/([a-f0-9-]{36})\/v1\/(models|chat\/completions)$/.exec(url.pathname);
    if(!match)throw problem(404,'平台内部路由不存在');
    const worker=workers.workers.get(match[1]),provided=String(req.headers.authorization||'').replace(/^Bearer /,'');
    const address=req.socket.remoteAddress;
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||!worker||provided.length!==worker.token.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(worker.token)))throw problem(403,'平台调用身份无效');
    const user=accountStore.db.prepare('SELECT id,disabled FROM users WHERE id=?').get(match[1]);if(!user||user.disabled)throw problem(403,'账号已停用');
    if(match[2]==='models'){
      if(req.method!=='GET')throw problem(405,'请求方式不支持');
      vault.active();return sendPlatform(res,200,{object:'list',data:administration.modelPolicy().map(id=>({id,object:'model'}))});
    }
    if(req.method!=='POST')throw problem(405,'请求方式不支持');
    const body=await platformBody(req,1024*1024),controller=new AbortController();
    if(!administration.modelPolicy().includes(body.model))throw problem(403,'管理员未开放此平台模型');
    body.novelking_settings=administration.preference(user.id,body.model).settings;
    const closed=()=>{if(!res.writableEnded)controller.abort();};res.once('close',closed);
    try{
      const completion=await relay.complete(user.id,body,{requestId:req.headers['idempotency-key']||randomUUID(),signal:controller.signal});
      if(body.stream){
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
        const message=completion.response.choices[0].message;
        const replayDelta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((tool,index)=>({...tool,index}))}:{})};
        const frames=completion.frames||[{id:completion.response.id,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta:replayDelta,finish_reason:completion.response.choices[0].finish_reason}]}];
        for(const frame of frames)res.write('data: '+JSON.stringify(frame)+'\n\n');
        res.write('data: '+JSON.stringify({choices:[],usage:completion.response.usage,novelking_billing:completion.response.novelking_billing})+'\n\n');res.end('data: [DONE]\n\n');
      }else sendPlatform(res,200,completion.response);
    }finally{res.removeListener('close',closed);}
  }
  async function http(req,res,url,user,workers) {
    const parts=url.pathname.split('/').slice(3),section=parts[0],action=parts[1],id=parts[2];
    if(section==='wallet'&&req.method==='GET')return sendPlatform(res,200,{...wallet.wallet(user.id),channels:recharge.listChannels(),topups:recharge.list(user.id),automaticPayment:Boolean(vmq)});
    if(section==='models'&&req.method==='GET'){
      const catalogue=await relay.catalogue(),enabled=administration.modelPolicy();
      return sendPlatform(res,200,{...catalogue,models:catalogue.models.map(model=>({...model,enabled:enabled.includes(model.id)}))});
    }
    if(section==='preferences'){
      if(req.method==='GET')return sendPlatform(res,200,administration.preference(user.id,url.searchParams.get('model')));
      if(req.method==='POST'){const body=await platformBody(req);return sendPlatform(res,200,administration.preference(user.id,body.model,body));}
    }
    if(section==='announcements'&&req.method==='GET')return sendPlatform(res,200,{announcements:administration.announcements()});
    if(section==='feedback'){
      if(req.method==='GET')return sendPlatform(res,200,{feedback:accountStore.db.prepare('SELECT id,message,reply,status,created_at FROM platform_feedback WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(user.id)});
      if(req.method==='POST'){accountStore.limit('feedback:'+user.id,10,3600000);return sendPlatform(res,201,administration.feedback(user.id,await platformBody(req)));}
    }
    if(section==='calls'&&req.method==='GET')return sendPlatform(res,200,{calls:accountStore.db.prepare('SELECT id,request_id,model,status,charged_micros,usage_json,capped,created_at,error FROM platform_calls WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id)});
    if(section==='topups'){
      if(!action&&req.method==='POST'){let order=recharge.create(user.id,await platformBody(req));if(vmq)order=await vmq.attach(order);return sendPlatform(res,201,order);}
      if(action&&id==='declare'&&req.method==='POST'){const body=await platformBody(req);if(typeof body.paid!=='boolean')throw problem(400,'付款状态不正确');return sendPlatform(res,200,recharge.declare(user.id,action,body.paid));}
      if(action&&id==='display'&&req.method==='POST'){const body=await platformBody(req);return sendPlatform(res,200,recharge.display(user.id,action,body.action,body.windowId));}
    }
    if(section==='payment-image'&&req.method==='GET'){
      const image=recharge.image(user.id,action),match=/^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(image);
      res.writeHead(200,{'Content-Type':match[1],'Cache-Control':'no-store'});return res.end(Buffer.from(match[2],'base64'));
    }
    if(section==='admin'){
      wallet.requireAdmin(user.id);
      const db=accountStore.db;
      if(req.method==='GET'){
        if(action==='overview')return sendPlatform(res,200,{users:db.prepare('SELECT COUNT(*) AS count FROM users').get().count,activeUsers:db.prepare('SELECT COUNT(*) AS count FROM users WHERE disabled=0').get().count,
          pendingTopups:db.prepare("SELECT COUNT(*) AS count FROM platform_topups WHERE status='awaiting_review'").get().count,walletBalanceMicros:db.prepare('SELECT COALESCE(SUM(balance_micros),0) AS amount FROM platform_wallets').get().amount,
          modelCalls:db.prepare("SELECT COUNT(*) AS count FROM platform_calls WHERE status='settled'").get().count,consumedMicros:db.prepare('SELECT COALESCE(SUM(charged_micros),0) AS amount FROM platform_calls').get().amount});
        if(action==='providers')return sendPlatform(res,200,{providers:vault.list()});
        if(action==='model-policy')return sendPlatform(res,200,{models:administration.modelPolicy(),catalogue:MODEL_CATALOG});
        if(['users','ledger','topups','requests','audit','feedback','announcements','invitations'].includes(action))return sendPlatform(res,200,administration.list(action,url));
        if(action==='channels')return sendPlatform(res,200,{channels:recharge.listChannels().map(channel=>({...channel,imageData:db.prepare('SELECT image_data FROM platform_qr WHERE id=?').get(channel.qr_id).image_data}))});
      }
      const body=await platformBody(req,action==='channels'?3*1024*1024:8192);
      await accountStore.verifyAdminPassword(user,body.password);
      if(action==='providers'&&['POST','PUT'].includes(req.method)){const saved=vault.save(user.id,body);wallet.audit(user.id,'provider.save',saved.id,'保存上游配置');relay.cache.clear();return sendPlatform(res,req.method==='POST'?201:200,saved);}
      if(action==='provider-activate'&&req.method==='POST'){const completion=vault.activate(user.id,body.id);wallet.audit(user.id,'provider.activate',body.id,'切换当前上游');return sendPlatform(res,200,{providers:completion});}
      if(action==='provider-probe'&&req.method==='POST')return sendPlatform(res,200,await relay.probe(vault.active()));
      if(action==='channels'&&req.method==='POST')return sendPlatform(res,201,recharge.uploadChannel(user.id,body.channel,body.imageData));
      if(action==='adjust'&&req.method==='POST')return sendPlatform(res,200,wallet.adjust(user.id,body.userId,body));
      if(action==='reverse'&&req.method==='POST')return sendPlatform(res,200,wallet.reverse(user.id,body.entryId,body.note));
      if(action==='review'&&req.method==='POST')return sendPlatform(res,200,recharge.review(user.id,body.topupId,body));
      if(action==='users'&&id&&req.method==='PATCH'){
        const edited=await accountStore.manageUser(user,id,{...(typeof body.disabled==='boolean'?{disabled:body.disabled}:{}),...(body.newPassword?{password:body.newPassword}:{})});
        if(edited.disabled||body.newPassword)workers.stop(id);wallet.audit(user.id,'user.manage',id,body.newPassword?'重置密码':edited.disabled?'停用':'恢复');return sendPlatform(res,200,edited);
      }
      if(action==='announcements'&&['POST','PUT'].includes(req.method))return sendPlatform(res,201,administration.announcement(user.id,body));
      if(action==='feedback'&&req.method==='PATCH')return sendPlatform(res,200,administration.reply(user.id,body));
      if(action==='invitations'&&['POST','PATCH'].includes(req.method))return sendPlatform(res,201,administration.invitation(user.id,body));
      if(action==='invite-policy'&&req.method==='PUT'){
        if(typeof body.required!=='boolean')throw problem(400,'注册策略不正确');db.prepare("INSERT INTO platform_settings(key,value) VALUES('invite_required',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(body.required));wallet.audit(user.id,'registration.policy',null,'更新邀请码要求');return sendPlatform(res,200,{required:body.required});
      }
      if(action==='model-policy'&&req.method==='PUT')return sendPlatform(res,200,administration.setModelPolicy(user.id,body.models));
    }
    throw problem(404,'平台页面接口不存在');
  }
  return {wallet,vault,recharge,relay,vmq,administration,internal,http};
}
