import {MODEL_CATALOG,DEFAULT_UPSTREAM} from './provider.mjs';
export function createWorkerPlatformConfigs(db,env=process.env) {
  if(!env.NOVELKING_PLATFORM_URL)return {isPlatform:()=>false,decorate:row=>row,resolve:row=>row};
  db.exec('CREATE TABLE IF NOT EXISTS worker_platform_models(config_id INTEGER PRIMARY KEY REFERENCES api_configs(id),model TEXT NOT NULL UNIQUE)');
  for(const profile of MODEL_CATALOG){
    const existing=db.prepare('SELECT config_id FROM worker_platform_models WHERE model=?').get(profile.id);
    if(existing)db.prepare('UPDATE api_configs SET base_url=?,api_key=? WHERE id=?').run(env.NOVELKING_PLATFORM_URL,env.NOVELKING_WORKER_TOKEN,existing.config_id);
    else {
      const created=db.prepare('INSERT INTO api_configs(name,base_url,api_key,model,temperature,max_tokens) VALUES(?,?,?,?,0.8,4096)').run('平台 · '+profile.id,env.NOVELKING_PLATFORM_URL,env.NOVELKING_WORKER_TOKEN,profile.id);
      db.prepare('INSERT INTO worker_platform_models(config_id,model) VALUES(?,?)').run(created.lastInsertRowid,profile.id);
    }
  }
  const isPlatform=id=>Boolean(db.prepare('SELECT config_id FROM worker_platform_models WHERE config_id=?').get(id));
  return {isPlatform,decorate:row=>isPlatform(row.id)?{...row,access_mode:'platform',base_url:DEFAULT_UPSTREAM,api_key:'平台托管',has_key:true}:row,
    resolve:row=>row&&isPlatform(row.id)?{...row,access_mode:'platform',base_url:env.NOVELKING_PLATFORM_URL,api_key:env.NOVELKING_WORKER_TOKEN}:row};
}
