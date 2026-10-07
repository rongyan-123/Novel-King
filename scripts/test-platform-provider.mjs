import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ProviderVault, MODEL_CATALOG, validateSettings} from '../platform/provider.mjs';

test('server vault persists encrypted upstream keys, exposes only masks, supports key rotation and rejects user control',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nk-vault-')),db=new DatabaseSync(path.join(root,'test.db'));
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,disabled INTEGER); INSERT INTO users VALUES('admin','admin',0),('user','user',0)");
  try {
    let vault=new ProviderVault(db,root);
    assert.throws(()=>vault.save('admin',{name:'Too short',apiKey:'1234',enabled:true}),/有效 Key/);
    const saved=vault.save('admin',{name:'爱你 AI',baseUrl:'https://anyai.token6688.com/v1',apiKey:'fixture-secret-one',enabled:true});
    assert.equal(saved.hasKey,true); assert.ok(!JSON.stringify(vault.list()).includes('fixture-secret-one'));
    assert.ok(!fs.readFileSync(path.join(root,'test.db')).includes(Buffer.from('fixture-secret-one')));
    assert.throws(()=>vault.save('user',{name:'bad',apiKey:'stolen'}),/管理员/);
    vault=new ProviderVault(db,root); assert.equal(vault.active().apiKey,'fixture-secret-one');
    vault.save('admin',{id:saved.id,name:'爱你 AI',baseUrl:'https://anyai.token6688.com/v1',apiKey:'fixture-secret-two',enabled:true});
    assert.equal(vault.active().apiKey,'fixture-secret-two');
    vault.save('admin',{id:saved.id,name:'爱你 AI',baseUrl:'https://anyai.token6688.com/v1',apiKey:null,enabled:false});
    assert.throws(()=>vault.active(),/未配置|停用/);
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('model settings match MapFlow per-model contracts and reject unadvertised flags',()=>{
  assert.equal(MODEL_CATALOG.length,9);
  assert.deepEqual(validateSettings('deepseek-v4-pro',{thinking:'true',reasoning_effort:'high'}),{thinking:'true',reasoning_effort:'high'});
  assert.throws(()=>validateSettings('gpt-5.4-nano',{enable_thinking:true}));
  assert.throws(()=>validateSettings('unknown',{}));
});
