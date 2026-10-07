import {randomUUID,randomBytes} from 'node:crypto';
import {problem} from './money.mjs';
import {MODEL_CATALOG,validateSettings} from './provider.mjs';
export class Administration {
  constructor(wallet) {
    this.wallet=wallet;this.db=wallet.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS platform_announcements(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,published INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_feedback(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),message TEXT NOT NULL,reply TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_invitations(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,max_uses INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_preferences(user_id TEXT NOT NULL REFERENCES users(id),model TEXT NOT NULL,settings_json TEXT NOT NULL,PRIMARY KEY(user_id,model));`);
  }
  page(url){const offset=Number(url.searchParams.get('offset')||0),search=String(url.searchParams.get('search')||'').trim();if(!Number.isInteger(offset)||offset<0||offset>1000000||search.length>120)throw problem(400,'分页或搜索条件不正确');return {offset,search};}
  users(url){
    const {offset,search}=this.page(url);
    const users=this.db.prepare(`SELECT u.id,u.username,u.role,u.disabled,u.created_at,COALESCE(w.balance_micros,100000) AS balance_micros,
      (SELECT COUNT(*) FROM platform_calls c WHERE c.user_id=u.id AND c.status='settled') AS platform_calls,
      (SELECT COALESCE(SUM(charged_micros),0) FROM platform_calls c WHERE c.user_id=u.id) AS charged_micros
      FROM users u LEFT JOIN platform_wallets w ON w.user_id=u.id WHERE strpos_placeholder ORDER BY u.created_at DESC,u.id LIMIT 51 OFFSET ?`
      .replace('strpos_placeholder',"(instr(lower(u.username),lower(?))>0 OR instr(u.id,?)>0)"))
      .all(search,search,offset);
    return {users:users.slice(0,50).map(user=>({...user,disabled:Boolean(user.disabled)})),hasMore:users.length>50,offset};
  }
  list(action,url){
    const {search,offset}=this.page(url);let rows;
    if(action==='users')return this.users(url);
    if(action==='ledger')rows=this.db.prepare(`SELECT l.*,u.username,EXISTS(SELECT 1 FROM platform_ledger r WHERE r.reversal_of=l.id) AS reversed FROM platform_ledger l JOIN users u ON u.id=l.user_id WHERE instr(lower(u.username),lower(?))>0 OR instr(l.note,?)>0 ORDER BY l.created_at DESC,l.id DESC LIMIT 51 OFFSET ?`).all(search,search,offset);
    else if(action==='topups'){
      const status=url.searchParams.get('status')||'';
      rows=this.db.prepare(`SELECT t.*,u.username FROM platform_topups t JOIN users u ON u.id=t.user_id WHERE (?='' OR t.status=?) AND (instr(lower(u.username),lower(?))>0 OR instr(t.id,?)>0) ORDER BY t.created_at DESC,t.id DESC LIMIT 51 OFFSET ?`).all(status,status,search,search,offset);
    }else if(action==='requests')rows=this.db.prepare(`SELECT c.id,c.user_id,u.username,c.request_id,c.model,c.status,c.amount_micros,c.charged_micros,c.usage_json,c.capped,c.error,c.created_at,c.updated_at FROM platform_calls c JOIN users u ON u.id=c.user_id WHERE instr(lower(u.username),lower(?))>0 OR instr(c.model,?)>0 ORDER BY c.created_at DESC,c.id DESC LIMIT 51 OFFSET ?`).all(search,search,offset);
    else if(action==='audit')rows=this.db.prepare(`SELECT a.*,u.username FROM platform_audit a LEFT JOIN users u ON u.id=a.actor_id WHERE instr(a.action,?)>0 OR instr(a.note,?)>0 ORDER BY a.created_at DESC,a.id DESC LIMIT 51 OFFSET ?`).all(search,search,offset);
    else if(action==='feedback')rows=this.db.prepare(`SELECT f.*,u.username FROM platform_feedback f JOIN users u ON u.id=f.user_id WHERE instr(f.message,?)>0 OR instr(lower(u.username),lower(?))>0 ORDER BY f.created_at DESC,f.id DESC LIMIT 51 OFFSET ?`).all(search,search,offset);
    else if(action==='announcements')rows=this.db.prepare('SELECT * FROM platform_announcements ORDER BY created_at DESC LIMIT 51 OFFSET ?').all(offset);
    else if(action==='invitations')rows=this.db.prepare('SELECT * FROM platform_invitations ORDER BY created_at DESC LIMIT 51 OFFSET ?').all(offset);
    else throw problem(404,'管理员分区不存在');
    const key={ledger:'ledger',topups:'topups',requests:'calls',audit:'events',feedback:'feedback',announcements:'announcements',invitations:'invitations'}[action];
    return {[key]:rows.slice(0,50),hasMore:rows.length>50,offset};
  }
  announcements(){return this.db.prepare('SELECT id,title,content,created_at FROM platform_announcements WHERE published=1 ORDER BY created_at DESC LIMIT 20').all();}
  announcement(actor,body){
    const title=String(body.title||'').trim(),content=String(body.content||'').trim();
    if(!title||title.length>120||!content||content.length>5000||typeof body.published!=='boolean')throw problem(400,'公告标题、内容或发布状态不正确');
    const id=body.id||randomUUID(),stamp=new Date().toISOString();
    this.db.prepare(`INSERT INTO platform_announcements(id,title,content,published,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,published=excluded.published,updated_at=excluded.updated_at`).run(id,title,content,Number(body.published),stamp,stamp);
    this.wallet.audit(actor,'announcement.save',id,title);return {id,title,content,published:body.published};
  }
  feedback(userId,body){const message=String(body.message||'').trim();if(!message||message.length>4000)throw problem(400,'反馈须为 1–4000 字');const id=randomUUID(),stamp=new Date().toISOString();this.db.prepare('INSERT INTO platform_feedback(id,user_id,message,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,userId,message,stamp,stamp);return {id,message};}
  reply(actor,body){if(!['open','replied','closed'].includes(body.status)||typeof body.reply!=='string'||body.reply.length>4000)throw problem(400,'反馈状态或回复不正确');const updated=this.db.prepare('UPDATE platform_feedback SET status=?,reply=?,updated_at=? WHERE id=?').run(body.status,body.reply,new Date().toISOString(),body.id);if(!updated.changes)throw problem(404,'反馈不存在');this.wallet.audit(actor,'feedback.reply',body.id,'处理反馈');return {ok:true};}
  invitation(actor,body){
    if(body.id){const changed=this.db.prepare('UPDATE platform_invitations SET revoked=1 WHERE id=?').run(body.id);if(!changed.changes)throw problem(404,'邀请码不存在');this.wallet.audit(actor,'invitation.revoke',body.id);return {ok:true};}
    if(!Number.isInteger(body.maxUses)||body.maxUses<1||body.maxUses>10000)throw problem(400,'邀请码可使用 1–10000 次');
    const id=randomUUID(),code=randomBytes(8).toString('hex'),expiry=Date.now()+30*86400000;
    this.db.prepare('INSERT INTO platform_invitations(id,code,max_uses,expires_at,created_at) VALUES(?,?,?,?,?)').run(id,code,body.maxUses,expiry,new Date().toISOString());this.wallet.audit(actor,'invitation.create',id,'创建邀请码');return {id,code,maxUses:body.maxUses,expiresAt:expiry};
  }
  inviteRequired(){return this.db.prepare("SELECT value FROM platform_settings WHERE key='invite_required'").get()?.value==='true';}
  consumeInvitation(code){
    if(!code&&!this.inviteRequired())return;
    if(typeof code!=='string'||!this.db.prepare('UPDATE platform_invitations SET uses=uses+1 WHERE code=? AND revoked=0 AND uses<max_uses AND expires_at>?').run(code,Date.now()).changes)throw problem(400,'邀请码无效、已过期或使用次数已用完');
  }
  modelPolicy(){let models;try{models=JSON.parse(this.db.prepare("SELECT value FROM platform_settings WHERE key='enabled_models'").get()?.value||'null');}catch{}return Array.isArray(models)?models:MODEL_CATALOG.map(model=>model.id);}
  setModelPolicy(actor,models){if(!Array.isArray(models)||models.some(model=>!MODEL_CATALOG.some(profile=>profile.id===model))||new Set(models).size!==models.length)throw problem(400,'模型白名单不正确');this.db.prepare("INSERT INTO platform_settings(key,value) VALUES('enabled_models',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(models));this.wallet.audit(actor,'models.policy',null,'更新平台模型白名单');return {models};}
  preference(userId,model,body=null){
    validateSettings(model,{});
    if(body){const settings=validateSettings(model,body.settings);this.db.prepare('INSERT INTO platform_preferences(user_id,model,settings_json) VALUES(?,?,?) ON CONFLICT(user_id,model) DO UPDATE SET settings_json=excluded.settings_json').run(userId,model,JSON.stringify(settings));}
    return {model,settings:JSON.parse(this.db.prepare('SELECT settings_json FROM platform_preferences WHERE user_id=? AND model=?').get(userId,model)?.settings_json||'{}')};
  }
}
