import {createHash,timingSafeEqual} from 'node:crypto';
import {parseFen,problem} from './money.mjs';
import {boundedText} from './transport.mjs';
const PARAM='novelking-v1';
const md5=text=>createHash('md5').update(text).digest('hex');
const money=fen=>(fen/100).toFixed(2);

export class VmqGateway {
  constructor(recharge,configuration,{request=fetch}={}) {
    this.recharge=recharge;this.wallet=recharge.wallet;this.db=recharge.db;this.request=request;
    const base=new URL(configuration.baseUrl),notify=new URL(configuration.notifyUrl),back=new URL(configuration.returnUrl);
    if(!['http:','https:'].includes(base.protocol)||!['http:','https:'].includes(notify.protocol)||back.protocol!=='https:'||base.username||base.password||typeof configuration.key!=='string'||configuration.key.length<8)throw problem(400,'VMQ 私有配置不正确');
    this.config={...configuration,baseUrl:configuration.baseUrl.replace(/\/$/,'')};
  }
  async order(path,query) {
    const url=new URL(this.config.baseUrl+path);for(const [key,value] of Object.entries(query))url.searchParams.set(key,String(value));
    try{
      const response=await this.request(url.href,{redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error();const envelope=JSON.parse(await boundedText(response,65536));
      if(envelope.code!==1||!envelope.data)throw Error();return envelope.data;
    }catch{throw problem(502,'VMQ 支付服务暂不可用');}
  }
  validateOrder(topup,order,paid=false) {
    if(order.payId!==topup.id||order.payType!==(topup.channel==='wechat'?1:2)||parseFen(String(order.price))!==topup.amount_fen||typeof order.orderId!=='string'||!order.orderId||order.orderId.length>80||!Number.isInteger(order.timeOut)||order.timeOut<1||order.timeOut>30||!Number.isSafeInteger(order.date)||order.date<Date.parse(topup.created_at)-5000||order.date>Date.now()+5000)throw problem(409,'支付订单信息不匹配');
    const amount=parseFen(String(order.reallyPrice)),difference=amount-topup.amount_fen,expires=order.date+order.timeOut*60000;
    if(difference<0||difference>100)throw problem(409,'实际支付金额不匹配');
    if(paid){if(![1,2].includes(order.state)||order.orderId!==topup.vmq_order_id||amount!==topup.payment_amount_fen||!Number.isSafeInteger(order.payDate)||order.payDate<order.date||order.payDate>Date.now()+5000||order.payDate>topup.payment_expires_at)throw problem(409,'此订单尚未核实付款');}
    else if(![0,1,2].includes(order.state)||expires<=Date.now())throw problem(409,'支付订单已失效');
    return {amount,expires};
  }
  async attach(topup) {
    if(topup.vmq_order_id)return topup;
    const type=topup.channel==='wechat'?'1':'2',price=money(topup.amount_fen);
    const order=await this.order('/createOrder',{payId:topup.id,param:PARAM,type,price,notifyUrl:this.config.notifyUrl,returnUrl:this.config.returnUrl,isHtml:0,sign:md5(topup.id+PARAM+type+price+this.config.key)});
    const validated=this.validateOrder(topup,order);
    return this.wallet.transaction(()=>{
      this.wallet.lock(topup.user_id);const current=this.recharge.get(topup.user_id,topup.id);
      if(current.vmq_order_id){if(current.vmq_order_id!==order.orderId)throw problem(409,'支付订单状态冲突');return current;}
      this.db.prepare('UPDATE platform_topups SET vmq_order_id=?,payment_amount_fen=?,payment_expires_at=?,updated_at=? WHERE id=?').run(order.orderId,validated.amount,validated.expires,new Date().toISOString(),topup.id);
      return this.recharge.get(topup.user_id,topup.id);
    });
  }
  async notify(callback) {
    const allowed=['payId','param','type','price','reallyPrice','sign'];
    if(Object.keys(callback).some(key=>!allowed.includes(key))||allowed.some(key=>typeof callback[key]!=='string'||callback[key].length>160)||callback.param!==PARAM||!['1','2'].includes(callback.type)||!/^[0-9a-f]{32}$/.test(callback.sign))throw problem(400,'支付通知无效');
    const expected=md5(callback.payId+callback.param+callback.type+callback.price+callback.reallyPrice+this.config.key);
    if(!timingSafeEqual(Buffer.from(expected),Buffer.from(callback.sign)))throw problem(400,'支付签名不正确');
    const topup=this.db.prepare('SELECT * FROM platform_topups WHERE id=?').get(callback.payId);
    if(!topup||!topup.vmq_order_id||callback.type!==(topup.channel==='wechat'?'1':'2')||parseFen(callback.price)!==topup.amount_fen||parseFen(callback.reallyPrice)!==topup.payment_amount_fen)throw problem(409,'支付通知和本站订单不匹配');
    const order=await this.order('/getOrder',{orderId:topup.vmq_order_id});this.validateOrder(topup,order,true);
    return this.wallet.transaction(()=>{
      const wallet=this.wallet.lock(topup.user_id),current=this.recharge.get(topup.user_id,topup.id),receipt='vmq:'+order.orderId;
      if(current.status==='credited'&&current.receipt===receipt)return {ok:true,replayed:true};
      if(!['awaiting_payment','awaiting_review','closed_unpaid'].includes(current.status))throw problem(409,'此充值订单不能自动入账');
      if(this.db.prepare('SELECT id FROM platform_topups WHERE channel=? AND receipt=?').get(current.channel,receipt))throw problem(409,'支付凭证已使用');
      const amount=current.payment_amount_fen*10000,balance=wallet.balance+amount;
      if(!Number.isSafeInteger(balance)||balance>9000000000000000)throw problem(409,'钱包余额超出范围');
      this.db.prepare('UPDATE platform_wallets SET balance_micros=? WHERE user_id=?').run(balance,current.user_id);
      this.wallet.entry(current.user_id,'topup',amount,balance,'VMQ 已核实支付自动到账',null,current.id);
      this.db.prepare("UPDATE platform_topups SET status='credited',receipt=?,review_note='VMQ 自动核实',updated_at=? WHERE id=?").run(receipt,new Date().toISOString(),current.id);
      this.recharge.finishDisplay(current.id);this.wallet.audit(null,'topup.vmq',current.id,'支付签名及已付款订单核对通过');
      return {ok:true};
    });
  }
}
