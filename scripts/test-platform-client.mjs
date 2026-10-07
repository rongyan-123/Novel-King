import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('balance labels mounted after the initial wallet request display the cached balance',async()=>{
  const labels=[],observers=[],document={addEventListener(){},querySelectorAll:()=>labels};
  class Observer {constructor(callback){this.callback=callback;observers.push(this);}observe(){}}
  const context={document,window:{NovelKingAccount:{hosted:true}},fetch:async()=>({ok:true,json:async()=>({balanceMicros:100000})}),MutationObserver:Observer};
  vm.runInNewContext(fs.readFileSync(new URL('../public/platform.js',import.meta.url),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  const label={textContent:'',nodeType:1,matches:()=>true,querySelectorAll:()=>[]};labels.push(label);
  for(const observer of observers)observer.callback([{addedNodes:[label]}]);
  assert.equal(label.textContent,'¥0.10');
});
