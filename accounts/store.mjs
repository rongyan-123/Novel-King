import { createDatabase } from '../storage/database.mjs';
import { randomBytes, randomInt, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const derive = promisify(scrypt);
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const failure = (status, message) => Object.assign(new Error(message), { status });
export const publicUser = user => ({ id: user.id, username: user.username, role: user.role, disabled: Boolean(user.disabled), created_at: user.created_at });
export function validUsername(value) {
  const username = String(value || '').trim().normalize('NFKC');
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) throw failure(400, '用户名须为 2–32 个字，可用中文、字母、数字、下划线和短横线');
  return username;
}
export function validPassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128 || Buffer.byteLength(value) > 512) throw failure(400, '密码须为 10–128 个字符');
  return value;
}
let activeHashes = 0;
async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (activeHashes >= 2) throw failure(429, '正在处理登录，请稍后重试');
  activeHashes++;
  try { return `${salt}:${(await derive(password, salt, 64, SCRYPT)).toString('hex')}`; }
  finally { activeHashes--; }
}
async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const derived = (await hashPassword(password, salt)).split(':')[1];
  return timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(expected, 'hex'));
}

export class AccountStore {
  constructor(root, { captchaTtl = 120000, databaseURL, databaseSchema = 'nk_accounts' } = {}) {
    this.root = root;
    this.captchaTtl = captchaTtl;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = createDatabase(path.join(root, 'accounts.db'), { url: databaseURL, schema: databaseSchema });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, answer_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.cleanup = setInterval(() => this.prune(), 60000).unref();
  }
  prune() {
    for (const table of ['sessions', 'challenges', 'rate_limits']) this.db.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).run(Date.now());
  }
  limit(key, max, windowMs) {
    const now = Date.now();
    const record = this.db.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
      expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count,expires_at`).get(digest(key), now + windowMs, now, now);
    if (record.count > max) throw Object.assign(failure(429, '操作太频繁，请稍后再试'), { retryAfter: Math.ceil((record.expires_at - now) / 1000) });
  }
  challenge(ip) {
    this.limit('challenge:' + ip, 60, 600000);
    this.prune();
    const left = randomInt(1, 20), right = randomInt(1, 13), addition = randomInt(2) === 0;
    const id = randomBytes(24).toString('hex'), answer = addition ? left + right : left * right;
    const expires_at = Date.now() + this.captchaTtl;
    this.db.prepare('INSERT INTO challenges VALUES(?,?,?,?)').run(id, digest(id + ':' + answer), digest(ip), expires_at);
    return { id, question: `${left} ${addition ? '+' : '×'} ${right} = ?`, expires_at };
  }
  consumeChallenge(ip, id, answer) {
    const challenge = this.db.prepare('DELETE FROM challenges WHERE id=? RETURNING *').get(String(id || ''));
    if (!challenge || challenge.ip_hash !== digest(ip) || challenge.expires_at <= Date.now()
      || !/^\d{1,4}$/.test(String(answer)) || challenge.answer_hash !== digest(challenge.id + ':' + Number(answer))) throw failure(400, '计算题答案错误或已过期，请换一道题');
  }
  async createUser(username, password, role = 'user') {
    username = validUsername(username); validPassword(password);
    if (this.db.prepare('SELECT id FROM users WHERE username_key=?').get(username.toLowerCase())) throw failure(409, '这个用户名已经被使用');
    const password_hash = await hashPassword(password);
    const id = randomUUID();
    try { this.db.prepare('INSERT INTO users(id,username,username_key,password_hash,role) VALUES(?,?,?,?,?)').run(id, username, username.toLowerCase(), password_hash, role); }
    catch (error) { if (String(error.message).includes('UNIQUE')) throw failure(409, '这个用户名已经被使用'); throw error; }
    return this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  async bootstrap(username, password) {
    if (!this.db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
      if (!username || !password) throw failure(500, '首次启动须设置 NOVELKING_ADMIN_USER 和 NOVELKING_ADMIN_PASSWORD');
      await this.createUser(username, password, 'admin');
    }
    this.dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  }
  async login(ip, username, password) {
    this.limit('login-ip:' + ip, 40, 900000);
    const key = 'login-user:' + String(username || '').trim().normalize('NFKC').toLowerCase();
    this.limit(key, 10, 900000);
    const user = this.db.prepare('SELECT * FROM users WHERE username_key=?').get(key.slice('login-user:'.length));
    const candidate = typeof password === 'string' && password.length <= 128 ? password : '';
    const matches = await verifyPassword(candidate, user?.password_hash || this.dummyHash);
    if (!matches || !user || user.disabled) throw failure(401, '用户名或密码不正确，或账号已停用');
    this.db.prepare('DELETE FROM rate_limits WHERE key=?').run(digest(key));
    return user;
  }
  newSession(user) {
    const token = randomBytes(32).toString('hex');
    // Password hashing yields: another request might have disabled the account in that interval.
    const current = this.db.prepare('SELECT disabled,password_hash FROM users WHERE id=?').get(user.id);
    if (!current || current.disabled || current.password_hash !== user.password_hash) throw failure(401, '账号状态已变更，请重新登录');
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, Date.now() + 14 * 86400000);
    this.db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 5)').run(user.id, user.id);
    return token;
  }
  session(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    return this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>? AND disabled=0').get(digest(token), Date.now());
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token || '')); }
  async changePassword(user, current, next) {
    validPassword(next);
    if (typeof current !== 'string' || current.length > 128 || !await verifyPassword(current, user.password_hash)) throw failure(400, '当前密码不正确');
    const passwordHash = await hashPassword(next);
    this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  }
  async manageUser(admin, id, body) {
    const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!user) throw failure(404, '账号不存在');
    if (user.role === 'admin') throw failure(400, '管理员账号请使用修改密码功能；不能停用管理员');
    if (body.password !== undefined) {
      const passwordHash = await hashPassword(validPassword(body.password));
      this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, id);
      this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    if (typeof body.disabled === 'boolean') {
      this.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(Number(body.disabled), id);
      if (body.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
  }
  async resetPasswordByOperator(username, password) {
    const key = validUsername(username).toLowerCase();
    const user = this.db.prepare('SELECT id FROM users WHERE username_key=?').get(key);
    if (!user) throw failure(404, '账号不存在');
    const passwordHash = await hashPassword(validPassword(password));
    this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  }
  close() { clearInterval(this.cleanup); this.db.close(); }
}
