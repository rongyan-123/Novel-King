import { randomUUID } from 'node:crypto';
import { doubledCostMicros, MAX_MICROS, problem } from './money.mjs';
const now = () => new Date().toISOString();
const safeAmount = (amount, signed = false) => {
  if (!Number.isSafeInteger(amount) || (!signed && amount < 0) || Math.abs(amount) > MAX_MICROS) throw problem(400,'金额超出范围');
  return amount;
};

export class PlatformStore {
  constructor(database) {
    this.db = database;
    database.exec(`
      CREATE TABLE IF NOT EXISTS platform_wallets(user_id TEXT PRIMARY KEY REFERENCES users(id),balance_micros INTEGER NOT NULL CHECK(balance_micros BETWEEN 0 AND 9000000000000000));
      CREATE TABLE IF NOT EXISTS platform_ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,amount_micros INTEGER NOT NULL,balance_after_micros INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',request_id TEXT,topup_id TEXT,reversal_of TEXT UNIQUE,actor_id TEXT,created_at TEXT NOT NULL,UNIQUE(user_id,request_id));
      CREATE TABLE IF NOT EXISTS platform_calls(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,model TEXT NOT NULL,amount_micros INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','settled','released')),cost_cny TEXT,charged_micros INTEGER NOT NULL DEFAULT 0,balance_after_micros INTEGER,usage_json TEXT,response_json TEXT,error TEXT,capped INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,request_id));
      CREATE INDEX IF NOT EXISTS platform_calls_holds ON platform_calls(user_id,status);
      CREATE TABLE IF NOT EXISTS platform_audit(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,target_id TEXT,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }
  transaction(operation) {
    this.db.exec(this.db.kind === 'postgres' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  initialize(userId) {
    const user = this.db.prepare('SELECT id,disabled FROM users WHERE id=?').get(userId);
    if (!user || user.disabled) throw problem(403,'账号不存在或已停用');
    const created = this.db.prepare('INSERT INTO platform_wallets(user_id,balance_micros) VALUES(?,100000) ON CONFLICT(user_id) DO NOTHING').run(userId);
    if (created.changes) this.entry(userId,'welcome',100000,100000,'新用户体验赠送', 'welcome');
  }
  lock(userId) {
    this.initialize(userId);
    // Both engines acquire a write lock here, including PostgreSQL across processes.
    this.db.prepare('UPDATE platform_wallets SET balance_micros=balance_micros WHERE user_id=?').run(userId);
    const balance = this.db.prepare('SELECT balance_micros FROM platform_wallets WHERE user_id=?').get(userId).balance_micros;
    const held = safeAmount(Number(this.db.prepare("SELECT COALESCE(SUM(amount_micros),0) AS held FROM platform_calls WHERE user_id=? AND status='reserved'").get(userId).held));
    return { balance,held,available:balance-held };
  }
  entry(userId,kind,amount,balance,note,requestId=null,topupId=null,actor=null,reversal=null) {
    const id=randomUUID();
    this.db.prepare('INSERT INTO platform_ledger(id,user_id,kind,amount_micros,balance_after_micros,note,request_id,topup_id,actor_id,reversal_of,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,userId,kind,amount,balance,note,requestId,topupId,actor,reversal,now());
    return id;
  }
  audit(actor,action,target,note='') {
    this.db.prepare('INSERT INTO platform_audit(id,actor_id,action,target_id,note,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),actor,action,target,String(note).slice(0,240),now());
  }
  wallet(userId) {
    return this.transaction(() => {
      const amounts=this.lock(userId);
      return { balanceMicros:amounts.available,totalMicros:amounts.balance,heldMicros:amounts.held,currency:'CNY',
        ledger:this.db.prepare('SELECT * FROM platform_ledger WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(userId) };
    });
  }
  reserve(userId,{ requestId,fingerprint,model,amountMicros }) {
    safeAmount(amountMicros);
    if (typeof requestId !== 'string' || requestId.length<1 || requestId.length>160) throw problem(400,'请求编号不正确');
    return this.transaction(() => {
      const wallet=this.lock(userId), previous=this.db.prepare('SELECT * FROM platform_calls WHERE user_id=? AND request_id=?').get(userId,requestId);
      if (previous) {
        if (previous.fingerprint!==fingerprint) throw problem(409,'同一请求编号不能改变模型或内容');
        if (previous.status==='reserved') throw problem(409,'这次调用正在处理，请勿重复发送');
        if (previous.status==='released') throw problem(409,'这次调用已终止，请重新发起');
        return { ...previous,replayed:true,response:JSON.parse(previous.response_json) };
      }
      if (wallet.available<amountMicros) throw problem(402,'平台额度不足，请充值或使用自己的 API Key');
      const id=randomUUID(),created=now();
      this.db.prepare("INSERT INTO platform_calls(id,user_id,request_id,fingerprint,model,amount_micros,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved',?,?)")
        .run(id,userId,requestId,fingerprint,model,amountMicros,created,created);
      return { id,status:'reserved',amount_micros:amountMicros };
    });
  }
  settle(userId,id,{cost,currency,usage,response}) {
    const requested=doubledCostMicros(cost,currency);
    for (const field of ['prompt_tokens','completion_tokens']) if (!Number.isSafeInteger(usage?.[field]) || usage[field]<0) throw problem(502,'上游未返回完整 token 用量');
    return this.transaction(() => {
      const wallet=this.lock(userId),call=this.db.prepare('SELECT * FROM platform_calls WHERE id=? AND user_id=?').get(id,userId);
      if (!call || call.status==='released') throw problem(409,'这次调用已终止，不能结算');
      if (call.status==='settled') return { response:JSON.parse(call.response_json),chargedMicros:call.charged_micros,balanceMicros:call.balance_after_micros,replayed:true };
      const charge=Math.min(requested,call.amount_micros),balance=wallet.balance-charge;
      if (balance<0 || balance<wallet.held-call.amount_micros) throw problem(409,'钱包状态冲突');
      const receipt={requestId:call.request_id,model:call.model,chargedMicros:charge,balanceMicros:balance-(wallet.held-call.amount_micros),maximumChargeMicros:call.amount_micros,capped:requested>charge,usage};
      const saved={...response,novelking_billing:receipt};
      this.db.prepare('UPDATE platform_wallets SET balance_micros=? WHERE user_id=?').run(balance,userId);
      if (charge>0) this.entry(userId,'usage',-charge,balance,'模型消费：上游实际费用 × 2',call.request_id);
      this.db.prepare("UPDATE platform_calls SET status='settled',cost_cny=?,charged_micros=?,balance_after_micros=?,usage_json=?,response_json=?,capped=?,updated_at=? WHERE id=? AND status='reserved'")
        .run(String(cost),charge,receipt.balanceMicros,JSON.stringify(usage),JSON.stringify(saved),Number(receipt.capped),now(),id);
      return { ...receipt,response:saved };
    });
  }
  release(userId,id,reason) {
    return this.transaction(() => {
      // Cancellation remains valid after an administrator disabled the account.
      this.db.prepare('UPDATE platform_wallets SET balance_micros=balance_micros WHERE user_id=?').run(userId);
      this.db.prepare("UPDATE platform_calls SET status='released',error=?,updated_at=? WHERE id=? AND user_id=? AND status='reserved'").run(String(reason).slice(0,240),now(),id,userId);
    });
  }
  recoverAbandoned() {
    // Run only at account service startup, before accepting worker requests.
    this.db.prepare("UPDATE platform_calls SET status='released',error='账户服务已重启，未完成调用释放额度',updated_at=? WHERE status='reserved'").run(now());
  }
  requireAdmin(actor) {
    const admin=this.db.prepare('SELECT role,disabled FROM users WHERE id=?').get(actor);
    if (!admin || admin.role!=='admin' || admin.disabled) throw problem(403,'只有管理员可以操作');
  }
  adjust(actor,userId,{requestId,amountFen,note}) {
    this.requireAdmin(actor);
    if (!Number.isInteger(amountFen) || !amountFen || Math.abs(amountFen)>1000000 || typeof requestId!=='string' || !requestId || requestId.length>160 || typeof note!=='string' || !note.trim() || note.length>240) throw problem(400,'请输入有效金额、请求编号和调整原因');
    return this.transaction(()=>{
      const wallet=this.lock(userId),previous=this.db.prepare('SELECT * FROM platform_ledger WHERE user_id=? AND request_id=?').get(userId,requestId);
      if (previous) {
        if (previous.kind!=='adjustment' || previous.amount_micros!==amountFen*10000 || previous.note!==note) throw problem(409,'请求编号对应的调整内容已改变');
        return {balanceMicros:wallet.available,replayed:true};
      }
      const balance=safeAmount(wallet.balance+amountFen*10000);
      if (balance<wallet.held) throw problem(409,'不能扣减已经预留的额度');
      this.db.prepare('UPDATE platform_wallets SET balance_micros=? WHERE user_id=?').run(balance,userId);
      const entry=this.entry(userId,'adjustment',amountFen*10000,balance,note,requestId,null,actor);
      this.audit(actor,'wallet.adjust',userId,note);
      return {entryId:entry,balanceMicros:balance-wallet.held};
    });
  }
  reverse(actor,entryId,note) {
    this.requireAdmin(actor);
    if (!note?.trim() || note.length>240) throw problem(400,'请输入撤销原因');
    return this.transaction(()=>{
      const entry=this.db.prepare('SELECT * FROM platform_ledger WHERE id=?').get(entryId);
      if (!entry || !['topup','adjustment'].includes(entry.kind)) throw problem(400,'这条记录不能撤销');
      const wallet=this.lock(entry.user_id);
      if (this.db.prepare('SELECT id FROM platform_ledger WHERE reversal_of=?').get(entryId)) throw problem(409,'这条记录已经撤销');
      const balance=safeAmount(wallet.balance-entry.amount_micros);
      if (balance<wallet.held) throw problem(409,'余额不足或额度已经预留，不能撤销');
      this.db.prepare('UPDATE platform_wallets SET balance_micros=? WHERE user_id=?').run(balance,entry.user_id);
      const id=this.entry(entry.user_id,'reversal',-entry.amount_micros,balance,note,null,entry.topup_id,actor,entryId);
      if (entry.topup_id) this.db.prepare("UPDATE platform_topups SET status='reversed',updated_at=? WHERE id=?").run(now(),entry.topup_id);
      this.audit(actor,'wallet.reverse',entryId,note);
      return {entryId:id,balanceMicros:balance-wallet.held};
    });
  }
}
