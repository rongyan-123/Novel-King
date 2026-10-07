import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {isIP} from 'node:net';
import {problem} from './money.mjs';

export function publicAddress(address) {
  if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return a>0&&a!==10&&a!==127&&a<224&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===2))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);}
  return isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:0?db8|0{1,4}):/i.test(address);
}
export async function requestPublic(url,options={}) {
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password||isIP(target.hostname))throw problem(400,'只允许公开 HTTPS 上游');
  const addresses=await lookup(target.hostname,{all:true});
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw problem(400,'上游地址解析到了非公开网络');
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    const outgoing=httpsRequest(target,{method:options.method||'GET',headers:options.headers,signal:options.signal,
      lookup:(_hostname,lookupOptions,callback)=>lookupOptions.all?callback(null,[pinned]):callback(null,pinned.address,pinned.family)},incoming=>{
      resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:Object.fromEntries(Object.entries(incoming.headers).filter(([,value])=>typeof value==='string'))}));
    });
    outgoing.once('error',()=>reject(problem(502,'上游连接失败或超时')));
    if(options.body)outgoing.write(options.body);outgoing.end();
  });
}
export async function boundedText(response,limit=524288) {
  if(!response.body)throw problem(502,'上游没有返回内容');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw problem(502,'上游响应过大');chunks.push(value);}return Buffer.concat(chunks).toString('utf8');}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
