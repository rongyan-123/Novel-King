import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {problem} from './money.mjs';

export const DEFAULT_UPSTREAM='https://anyai.token6688.com/v1';
const toggle=name=>({name,kind:'switch',options:[]}),select=(name,options)=>({name,kind:'select',options});
const thinking=select('thinking',['true','false']);
export const MODEL_CATALOG=[
  {id:'deepseek-v4-flash',provider:'DeepSeek',settings:[thinking]},
  {id:'deepseek-v4-pro',provider:'DeepSeek',settings:[thinking,select('reasoning_effort',['low','high'])]},
  {id:'gpt-5.4-nano',provider:'OpenAI',settings:[toggle('web_search')]},
  {id:'gpt-5.4-mini',provider:'OpenAI',settings:[toggle('web_search')]},
  {id:'gpt-5.4',provider:'OpenAI',settings:[toggle('enable_thinking'),select('reasoning_effort',['low','medium','high','xhigh']),toggle('web_search')]},
  {id:'claude-sonnet-4-6',provider:'Anthropic',settings:[toggle('enable_thinking'),thinking,toggle('web_search')]},
  {id:'gemini-3.8-flash',provider:'Google',settings:[toggle('enable_thinking'),select('thinking_budget',['none','minimal','low','medium','high']),toggle('web_search')]},
  {id:'qwen3.8-flash',provider:'Qwen',settings:[toggle('enable_thinking')]},
  {id:'kimi-k3',provider:'Moonshot',settings:[toggle('enable_thinking'),toggle('web_search')]}
];
export function validateSettings(model,settings={}) {
  const profile=MODEL_CATALOG.find(item=>item.id===model);
  if (!profile || !settings || Array.isArray(settings) || typeof settings!=='object') throw problem(400,'模型或参数不正确');
  for (const [name,value] of Object.entries(settings)) {
    const spec=profile.settings.find(item=>item.name===name);
    if (!spec || (spec.kind==='switch' ? typeof value!=='boolean' : !spec.options.includes(value))) throw problem(400,'此模型不支持参数：'+name);
  }
  return {...settings};
}
export function upstreamBase(value) {
  let parsed;try {parsed=new URL(value);} catch {throw problem(400,'请输入有效上游地址');}
  if (parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.replace(/\/$/,'')!=='/v1' || !/^[a-z0-9.-]+$/i.test(parsed.hostname) || parsed.hostname==='localhost' || parsed.hostname.endsWith('.local') || /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) throw problem(400,'上游须为公开 HTTPS 的 /v1 地址');
  return parsed.href.replace(/\/$/,'');
}

export class ProviderVault {
  constructor(db,root) {
    this.db=db;
    const directory=path.join(root,'private'); fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const filename=path.join(directory,'platform-master.key');
    try {fs.writeFileSync(filename,randomBytes(32),{flag:'wx',mode:0o600});} catch(error) {if(error.code!=='EEXIST')throw error;}
    this.master=fs.readFileSync(filename);
    if(this.master.length!==32)throw Error('平台私有主密钥文件无效');
    db.exec(`CREATE TABLE IF NOT EXISTS platform_providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,key_cipher TEXT NOT NULL,key_suffix TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  requireAdmin(actor) {
    const user=this.db.prepare('SELECT role,disabled FROM users WHERE id=?').get(actor);
    if(!user || user.role!=='admin' || user.disabled)throw problem(403,'只有管理员可以管理上游 Key');
  }
  encrypt(secret) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.master,iv);
    const encrypted=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  }
  decrypt(encoded) {
    const bytes=Buffer.from(encoded,'base64'),cipher=createDecipheriv('aes-256-gcm',this.master,bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
  }
  list() {
    const active=this.db.prepare("SELECT value FROM platform_settings WHERE key='active_provider'").get()?.value;
    return this.db.prepare('SELECT id,name,base_url,key_suffix,enabled,created_at,updated_at FROM platform_providers ORDER BY created_at,id').all()
      .map(row=>({...row,enabled:Boolean(row.enabled),active:row.id===active,hasKey:true,keyMask:'••••'+row.key_suffix,key_suffix:undefined}));
  }
  save(actor,body) {
    this.requireAdmin(actor);
    const previous=body.id ? this.db.prepare('SELECT * FROM platform_providers WHERE id=?').get(body.id) : null;
    if(body.id && !previous)throw problem(404,'上游配置不存在');
    const name=String(body.name||'').trim(),base=upstreamBase(body.baseUrl||previous?.base_url||DEFAULT_UPSTREAM),secret=body.apiKey===null ? null : String(body.apiKey||'');
    if(!name || name.length>80 || typeof body.enabled!=='boolean' || (secret!==null && (secret.length<8 || Buffer.byteLength(secret)>512 || /\s|[\x00-\x1f]/.test(secret))) || (secret===null && !previous))throw problem(400,'请输入名称、有效 Key（至少 8 个字符）和启用状态');
    const id=previous?.id||randomUUID(),timestamp=new Date().toISOString();
    this.db.prepare(`INSERT INTO platform_providers(id,name,base_url,key_cipher,key_suffix,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,key_cipher=excluded.key_cipher,key_suffix=excluded.key_suffix,enabled=excluded.enabled,updated_at=excluded.updated_at`)
      .run(id,name,base,secret===null?previous.key_cipher:this.encrypt(secret),secret===null?previous.key_suffix:secret.slice(-4),Number(body.enabled),previous?.created_at||timestamp,timestamp);
    if(body.enabled && !this.db.prepare("SELECT value FROM platform_settings WHERE key='active_provider'").get())this.activate(actor,id);
    return this.list().find(row=>row.id===id);
  }
  activate(actor,id) {
    this.requireAdmin(actor);
    if(!this.db.prepare('SELECT id FROM platform_providers WHERE id=? AND enabled=1').get(id))throw problem(400,'该上游不存在或已停用');
    this.db.prepare("INSERT INTO platform_settings(key,value) VALUES('active_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
    return this.list();
  }
  active() {
    const id=this.db.prepare("SELECT value FROM platform_settings WHERE key='active_provider'").get()?.value;
    const row=this.db.prepare('SELECT * FROM platform_providers WHERE id=? AND enabled=1').get(id||'');
    if(!row)throw problem(503,'管理员尚未配置可用上游，或当前上游已停用');
    return {id:row.id,name:row.name,baseUrl:row.base_url,apiKey:this.decrypt(row.key_cipher)};
  }
}
