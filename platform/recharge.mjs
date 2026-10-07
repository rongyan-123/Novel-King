import {randomUUID} from 'node:crypto';
import {problem} from './money.mjs';
const timestamp=()=>new Date().toISOString();
const channels=new Set(['wechat','alipay']);

export class RechargeStore {
  constructor(wallet) {
    this.wallet=wallet;this.db=wallet.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_qr(id TEXT PRIMARY KEY,channel TEXT NOT NULL,image_data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_channels(channel TEXT PRIMARY KEY,qr_id TEXT NOT NULL REFERENCES platform_qr(id));
      CREATE TABLE IF NOT EXISTS platform_topups(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,amount_fen INTEGER NOT NULL,channel TEXT NOT NULL,qr_id TEXT NOT NULL REFERENCES platform_qr(id),status TEXT NOT NULL,receipt TEXT,review_note TEXT,reviewed_by TEXT,payment_amount_fen INTEGER,payment_expires_at INTEGER,vmq_order_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(user_id,request_id),UNIQUE(channel,receipt));
      CREATE TABLE IF NOT EXISTS platform_display(id TEXT PRIMARY KEY,topup_id TEXT NOT NULL REFERENCES platform_topups(id),user_id TEXT NOT NULL,ticket INTEGER NOT NULL,status TEXT NOT NULL,expires_at INTEGER,last_seen INTEGER NOT NULL);
      INSERT INTO platform_settings(key,value) VALUES('display_lock','lock') ON CONFLICT(key) DO NOTHING;
    `);
  }
  uploadChannel(actor,channel,imageData) {
    this.wallet.requireAdmin(actor);
    const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(imageData||'');
    if(!channels.has(channel)||!match)throw problem(400,'请选择微信或支付宝，上传 PNG/JPEG 收款码');
    const bytes=Buffer.from(match[2],'base64');
    if(!bytes.length || bytes.length>2*1024*1024 || !(match[1]==='png' ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) : bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw problem(400,'收款码须为有效 PNG/JPEG，最大 2 MB');
    return this.wallet.transaction(()=>{
      const id=randomUUID();this.db.prepare('INSERT INTO platform_qr VALUES(?,?,?,?)').run(id,channel,imageData,timestamp());
      this.db.prepare('INSERT INTO platform_channels(channel,qr_id) VALUES(?,?) ON CONFLICT(channel) DO UPDATE SET qr_id=excluded.qr_id').run(channel,id);
      this.wallet.audit(actor,'payment.channel',channel,'更新收款码');return {channel,qrId:id};
    });
  }
  listChannels(){return this.db.prepare('SELECT channel,qr_id FROM platform_channels ORDER BY channel').all();}
  create(userId,{requestId,amountFen,channel}) {
    if(!channels.has(channel)||!Number.isInteger(amountFen)||amountFen<1||amountFen>1000000||typeof requestId!=='string'||!requestId||requestId.length>160)throw problem(400,'充值金额、渠道或请求编号不正确');
    return this.wallet.transaction(()=>{
      this.wallet.lock(userId);
      const previous=this.db.prepare('SELECT * FROM platform_topups WHERE user_id=? AND request_id=?').get(userId,requestId);
      if(previous){if(previous.amount_fen!==amountFen||previous.channel!==channel)throw problem(409,'同一订单编号不能改变充值内容');return previous;}
      const qr=this.db.prepare('SELECT qr_id FROM platform_channels WHERE channel=?').get(channel);
      if(!qr)throw problem(503,'管理员尚未配置此渠道的收款码');
      const count=this.db.prepare("SELECT COUNT(*) AS count FROM platform_topups WHERE user_id=? AND status IN ('awaiting_payment','awaiting_review')").get(userId).count;
      if(count>=20)throw problem(409,'未完成充值订单过多，请先处理已有订单');
      const id=randomUUID(),created=timestamp();
      this.db.prepare("INSERT INTO platform_topups(id,user_id,request_id,amount_fen,channel,qr_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'awaiting_payment',?,?)").run(id,userId,requestId,amountFen,channel,qr.qr_id,created,created);
      return this.get(userId,id);
    });
  }
  get(userId,id){const row=this.db.prepare('SELECT * FROM platform_topups WHERE id=? AND user_id=?').get(id,userId);if(!row)throw problem(404,'充值订单不存在');return row;}
  list(userId){return this.db.prepare('SELECT * FROM platform_topups WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(userId);}
  declare(userId,id,paid) {
    return this.wallet.transaction(()=>{
      this.wallet.lock(userId);const order=this.get(userId,id);
      const status=paid?'awaiting_review':'closed_unpaid';
      if(order.status===status)return order;
      if(order.status!=='awaiting_payment')throw problem(409,'此充值订单已处理');
      this.db.prepare('UPDATE platform_topups SET status=?,updated_at=? WHERE id=?').run(status,timestamp(),id);
      this.finishDisplay(id);return this.get(userId,id);
    });
  }
  finishDisplay(id){this.db.prepare("UPDATE platform_display SET status='finished' WHERE topup_id=? AND status IN ('waiting','active')").run(id);}
  review(actor,id,{approve,receipt,note}) {
    this.wallet.requireAdmin(actor);
    if(typeof approve!=='boolean'||typeof note!=='string'||note.length>240||(!approve&&!note.trim())||(approve&&(typeof receipt!=='string'||receipt.length<6||receipt.length>120)))throw problem(400,'请输入收款凭证或拒绝原因');
    return this.wallet.transaction(()=>{
      const order=this.db.prepare('SELECT * FROM platform_topups WHERE id=?').get(id);
      if(!order)throw problem(404,'充值订单不存在');
      const wallet=this.wallet.lock(order.user_id);
      if(order.status==='credited'&&approve&&order.receipt===receipt)return order;
      if(!['awaiting_payment','awaiting_review'].includes(order.status))throw problem(409,'订单已处理');
      if(approve&&this.db.prepare('SELECT id FROM platform_topups WHERE channel=? AND receipt=?').get(order.channel,receipt))throw problem(409,'此收款凭证已经入账');
      if(approve){
        const amount=(order.payment_amount_fen??order.amount_fen)*10000,balance=wallet.balance+amount;
        if(!Number.isSafeInteger(balance)||balance>9000000000000000)throw problem(400,'余额超出范围');
        this.db.prepare('UPDATE platform_wallets SET balance_micros=? WHERE user_id=?').run(balance,order.user_id);
        this.wallet.entry(order.user_id,'topup',amount,balance,note||'确认收款充值',null,id,actor);
      }
      this.db.prepare('UPDATE platform_topups SET status=?,receipt=?,review_note=?,reviewed_by=?,updated_at=? WHERE id=?').run(approve?'credited':'rejected',approve?receipt:null,note,actor,timestamp(),id);
      this.finishDisplay(id);this.wallet.audit(actor,approve?'topup.approve':'topup.reject',id,note);
      return this.get(order.user_id,id);
    });
  }
  display(userId,topupId,action,windowId,clock=Date.now()) {
    if(!['join','poll','leave'].includes(action))throw problem(400,'收款码操作不正确');
    return this.wallet.transaction(()=>{
      // Serialize the queue independently of the wallet lock across database clients.
      this.db.prepare("UPDATE platform_settings SET value=value WHERE key='display_lock'").run();
      const order=this.get(userId,topupId);
      this.db.prepare("UPDATE platform_display SET status='expired' WHERE status='active' AND expires_at<=?").run(clock);
      this.db.prepare("UPDATE platform_display SET status='cancelled' WHERE status='waiting' AND last_seen<?").run(clock-10000);
      if(!['awaiting_payment','awaiting_review'].includes(order.status)||(order.payment_expires_at&&order.payment_expires_at<=clock)){this.finishDisplay(topupId);return {status:'finished',windowId:null,imageUrl:null};}
      let row=windowId?this.db.prepare('SELECT * FROM platform_display WHERE id=? AND user_id=? AND topup_id=?').get(windowId,userId,topupId)
        :this.db.prepare('SELECT * FROM platform_display WHERE user_id=? AND topup_id=? ORDER BY ticket DESC LIMIT 1').get(userId,topupId);
      if(windowId&&!row)throw problem(404,'收款码窗口不存在');
      if(action==='join'&&(!row||!['waiting','active'].includes(row.status))){
        if(this.db.prepare("SELECT id FROM platform_display WHERE user_id=? AND status IN ('waiting','active')").get(userId))throw problem(409,'你已有一个收款码窗口');
        const id=randomUUID(),ticket=this.db.prepare('SELECT COALESCE(MAX(ticket),0)+1 AS ticket FROM platform_display').get().ticket;
        this.db.prepare("INSERT INTO platform_display(id,topup_id,user_id,ticket,status,last_seen) VALUES(?,?,?,?,'waiting',?)").run(id,topupId,userId,ticket,clock);
        row=this.db.prepare('SELECT * FROM platform_display WHERE id=?').get(id);
      }
      if(!row)return {status:'idle',windowId:null,imageUrl:null};
      if(action==='leave')this.db.prepare("UPDATE platform_display SET status='cancelled' WHERE id=? AND status IN ('waiting','active')").run(row.id);
      else this.db.prepare('UPDATE platform_display SET last_seen=? WHERE id=?').run(clock,row.id);
      if(!this.db.prepare("SELECT id FROM platform_display WHERE status='active'").get()){
        const next=this.db.prepare("SELECT id FROM platform_display WHERE status='waiting' ORDER BY ticket LIMIT 1").get();
        if(next)this.db.prepare("UPDATE platform_display SET status='active',expires_at=? WHERE id=?").run(clock+20000,next.id);
      }
      row=this.db.prepare('SELECT * FROM platform_display WHERE id=?').get(row.id);
      return {windowId:row.id,status:row.status,serverNow:clock,expiresAt:row.expires_at,position:row.status==='waiting'?this.db.prepare("SELECT COUNT(*) AS count FROM platform_display WHERE ticket<? AND status IN ('waiting','active')").get(row.ticket).count:0,
        imageUrl:row.status==='active'?'/api/platform/payment-image/'+row.id:null};
    });
  }
  image(userId,windowId,clock=Date.now()) {
    const row=this.db.prepare("SELECT q.image_data FROM platform_display d JOIN platform_topups t ON t.id=d.topup_id JOIN platform_qr q ON q.id=t.qr_id WHERE d.id=? AND d.user_id=? AND d.status='active' AND d.expires_at>? AND t.status IN ('awaiting_payment','awaiting_review')").get(windowId,userId,clock);
    if(!row)throw problem(404,'收款码窗口不存在或已过期');
    return row.image_data;
  }
}
