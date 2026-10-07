import { randomUUID } from 'node:crypto';

const failure = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const publicMessage = row => ({ ...row, events: JSON.parse(row.events_json), events_json: undefined });

export function compactToolEvent(event) {
  if (!['tool/call', 'tool/result'].includes(event.type)) return null;
  const source = event.data || {}, data = { callId: String(source.callId || source.message?.source?.callId || '').slice(0, 128) };
  if (source.name) data.name = String(source.name).slice(0, 100);
  if (source.message?.content?.some(block => block.type === 'tool-result' && block.isError) || source.isError) data.isError = true;
  if (event.type === 'tool/call') {
    let arguments_ = source.arguments || {};
    if (typeof arguments_ === 'string') { try { arguments_ = JSON.parse(arguments_); } catch { arguments_ = {}; } }
    if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) arguments_ = {};
    data.arguments = {};
    for (const [key, value] of Object.entries(arguments_).slice(0, 12)) {
      const summary = typeof value === 'string' ? value.slice(0, 128) : value === null || ['boolean', 'number'].includes(typeof value) ? value : '[复杂参数]';
      data.arguments[key.slice(0, 48)] = summary;
    }
  }
  return { type: event.type, data };
}

function savedActivity(events) {
  const activity = []; let bytes = 2;
  for (const event of events) {
    const compact = compactToolEvent(event);
    if (!compact) continue;
    const size = Buffer.byteLength(JSON.stringify(compact)) + 1;
    if (bytes + size > 32768 || activity.length >= 96) break;
    bytes += size; activity.push(compact);
  }
  return JSON.stringify(activity);
}

export class ConversationStore {
  constructor(database) {
    this.db = database;
    database.exec(`CREATE TABLE IF NOT EXISTS agent_conversations(id TEXT PRIMARY KEY,work_id INTEGER REFERENCES works(id) ON DELETE SET NULL,
      title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,
      events_json TEXT NOT NULL DEFAULT '[]',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_order ON agent_messages(conversation_id,position);
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_updated ON agent_conversations(updated_at);`);
    database.prepare("UPDATE agent_messages SET status='interrupted',error=?,updated_at=? WHERE status='running'")
      .run('服务重启，已保留收到的内容；可以继续提问。', now());
  }
  create({ work_id = null, title = '新会话' } = {}) {
    const workId = work_id === null || work_id === '' ? null : Number(work_id);
    if (workId !== null && (!Number.isSafeInteger(workId) || workId < 1 || !this.db.prepare('SELECT id FROM works WHERE id=?').get(workId))) throw failure(404, '作品不存在');
    const id = randomUUID(), created = now();
    this.db.prepare('INSERT INTO agent_conversations(id,work_id,title,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, workId, String(title).trim().slice(0, 80) || '新会话', created, created);
    return this.get(id);
  }
  get(id) {
    const row = this.db.prepare('SELECT c.*,w.title AS work_title FROM agent_conversations c LEFT JOIN works w ON w.id=c.work_id WHERE c.id=?').get(id);
    if (!row) throw failure(404, '会话不存在');
    return row;
  }
  list() {
    return this.db.prepare('SELECT c.*,w.title AS work_title FROM agent_conversations c LEFT JOIN works w ON w.id=c.work_id ORDER BY c.updated_at DESC,c.id LIMIT 100').all();
  }
  messages(id) {
    this.get(id);
    return this.db.prepare('SELECT * FROM agent_messages WHERE conversation_id=? ORDER BY position').all(id).map(publicMessage);
  }
  startTurn(id, prompt) {
    const conversation = this.get(id);
    const content = String(prompt || '').trim();
    if (!content || content.length > 12000) throw failure(400, '请输入 1–12000 字的问题');
    if (this.db.prepare("SELECT id FROM agent_messages WHERE conversation_id=? AND status='running'").get(id)) throw failure(409, '这个会话还有正在进行的回答');
    const existing = this.messages(id);
    if (existing.length >= 200) throw failure(400, '此会话已达 100 轮，请新建会话继续');
    let history = [], characters = 0;
    for (const message of existing.filter(message => message.status === 'complete').slice(-30).reverse()) {
      if (characters + message.content.length > 50000) break;
      characters += message.content.length; history.unshift({ role: message.role, content: message.content });
    }
    const stamp = now(), position = existing.at(-1)?.position ?? -1;
    const user = { id: randomUUID(), role: 'user', content, status: 'complete' }, assistant = { id: randomUUID(), role: 'assistant', content: '', status: 'running' };
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT INTO agent_messages(id,conversation_id,position,role,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
      insert.run(user.id, id, position + 1, user.role, user.content, user.status, stamp, stamp);
      insert.run(assistant.id, id, position + 2, assistant.role, assistant.content, assistant.status, stamp, stamp);
      this.db.prepare('UPDATE agent_conversations SET title=?,updated_at=? WHERE id=?').run(existing.length ? conversation.title : content.replace(/\s+/g, ' ').slice(0, 48), stamp, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { conversation: this.get(id), user, assistant, history };
  }
  progress(id, content, events = []) {
    this.db.prepare("UPDATE agent_messages SET content=?,events_json=?,updated_at=? WHERE id=? AND status='running'")
      .run(String(content).slice(0, 128000), savedActivity(events), now(), id);
  }
  finish(id, { status, content = '', events = [], error = '' }) {
    if (!['complete', 'failed', 'cancelled'].includes(status)) throw failure(400, '无效的回答状态');
    this.db.prepare("UPDATE agent_messages SET status=?,content=?,events_json=?,error=?,updated_at=? WHERE id=? AND status='running'")
      .run(status, String(content).slice(0, 128000), savedActivity(events), String(error).slice(0, 2000), now(), id);
    const row = this.db.prepare('SELECT * FROM agent_messages WHERE id=?').get(id);
    if (!row) throw failure(404, '回答不存在');
    this.db.prepare('UPDATE agent_conversations SET updated_at=? WHERE id=?').run(row.updated_at, row.conversation_id);
    return publicMessage(row);
  }
  rename(id, title) {
    this.get(id); const name = String(title || '').trim();
    if (!name || name.length > 80) throw failure(400, '会话名称须为 1–80 字');
    this.db.prepare('UPDATE agent_conversations SET title=?,updated_at=? WHERE id=?').run(name, now(), id);
    return this.get(id);
  }
  remove(id) {
    this.get(id);
    if (this.db.prepare("SELECT id FROM agent_messages WHERE conversation_id=? AND status='running'").get(id)) throw failure(409, '请先停止正在进行的回答');
    this.db.prepare('DELETE FROM agent_conversations WHERE id=?').run(id);
  }
}
