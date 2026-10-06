import { randomUUID } from 'node:crypto';
import { connectInternalTools } from './mcp.mjs';
import { BOARDS, scanRanking, validateSnapshot } from './rankings.mjs';

const failure = (status, message) => Object.assign(new Error(message), { status });
const textPage = (text, offset = 0, limit = 24000) => {
  offset = Number(offset); limit = Number(limit);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 40000) throw failure(400, '读取范围不正确');
  text = String(text || ''); const end = Math.min(text.length, offset + limit);
  return { text: text.slice(offset, end), total_chars: text.length, offset, next_offset: end < text.length ? end : null };
};

export class ResearchWorkspace {
  constructor(database) {
    this.db = database;
    database.exec(`CREATE TABLE IF NOT EXISTS research_snapshots(id TEXT PRIMARY KEY,work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
      board TEXT NOT NULL,source_url TEXT NOT NULL,captured_at TEXT NOT NULL,method TEXT NOT NULL,books_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_runs(id TEXT PRIMARY KEY,work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,config_id INTEGER,
      skill TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',events_json TEXT NOT NULL DEFAULT '[]',error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_connectors(id TEXT PRIMARY KEY,name TEXT NOT NULL,endpoint TEXT NOT NULL,api_key TEXT NOT NULL DEFAULT '',
      allowed_tools TEXT NOT NULL DEFAULT '[]',enabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_research_snapshots_work ON research_snapshots(work_id,captured_at);
      CREATE INDEX IF NOT EXISTS idx_research_runs_work ON research_runs(work_id,created_at);`);
    // A process restart can only retain the transcript already committed; never
    // claim that an interrupted task is still working or restart a paid call.
    database.prepare("UPDATE research_runs SET status='interrupted',error=?,updated_at=? WHERE status='running'").run('服务重启导致研究中断，可查看已保存记录后继续', new Date().toISOString());
  }
  work(workId, optional = false) {
    if (workId === null || workId === undefined || workId === '') { if (optional) return null; throw failure(400, '请先选择要研究的小说'); }
    const id = Number(workId);
    if (!Number.isSafeInteger(id) || id < 1 || !this.db.prepare('SELECT id FROM works WHERE id=?').get(id)) throw failure(404, '作品不存在');
    return id;
  }
  snapshots(workId) {
    return this.db.prepare('SELECT * FROM research_snapshots WHERE work_id IS ? OR work_id IS NULL ORDER BY captured_at DESC LIMIT 100').all(workId)
      .map(row => ({ ...row, books: JSON.parse(row.books_json), books_json: undefined }));
  }
  saveSnapshot(snapshot, workId) {
    const checked = validateSnapshot(snapshot), id = randomUUID();
    this.db.prepare('INSERT INTO research_snapshots(id,work_id,board,source_url,captured_at,method,books_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, this.work(workId, true), checked.board, checked.source_url, checked.captured_at, checked.method, JSON.stringify(checked.books), new Date().toISOString());
    return { id, work_id: workId, ...checked };
  }
  async connectTools(workId) {
    workId = this.work(workId, true);
    const scope = workId === null ? [] : [
      { name: 'novel_catalog', description: '查看当前作品章节、人物、设定和资料目录；需要全文时使用读取工具。', execute: async () => ({
        source: 'novel:' + workId, work: this.db.prepare('SELECT * FROM works WHERE id=?').get(workId),
        chapters: this.db.prepare('SELECT id,title,summary FROM chapters WHERE work_id=? ORDER BY position,id').all(workId),
        characters: this.db.prepare('SELECT id,name,identity FROM characters WHERE work_id=?').all(workId),
        settings: this.db.prepare('SELECT id,title FROM terms WHERE work_id=?').all(workId),
        world: this.db.prepare('SELECT id,title FROM world_entries WHERE work_id=?').all(workId),
        documents: this.db.prepare('SELECT id,name,area FROM file_documents WHERE (work_id=? OR work_id IS NULL) AND deleted_at IS NULL ORDER BY name').all(workId) }) },
      { name: 'novel_read_chapter', description: '按章节 ID 分页读取当前小说正文；next_offset 非空须继续读取，不能假装读完。',
        properties: { chapter_id: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['chapter_id'], execute: async arguments_ => {
          const chapter = this.db.prepare('SELECT id,title,content FROM chapters WHERE id=? AND work_id=?').get(arguments_.chapter_id, workId);
          if (!chapter) throw failure(404, '当前作品没有此章节');
          return { source: `novel:${workId}/chapter:${chapter.id}`, title: chapter.title, ...textPage(chapter.content, arguments_.offset, arguments_.limit) };
        } },
      { name: 'novel_read_setting', description: '读取当前作品的一条人物、设定或世界观。', properties: { kind: { type: 'string', enum: ['character', 'setting', 'world'] }, id: { type: 'integer' } }, required: ['kind', 'id'], execute: async arguments_ => {
        const table = { character: 'characters', setting: 'terms', world: 'world_entries' }[arguments_.kind];
        if (!table) throw failure(400, '不支持的资料类型');
        const item = this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND work_id=?`).get(arguments_.id, workId);
        if (!item) throw failure(404, '当前作品没有这条资料');
        return { source: `novel:${workId}/${arguments_.kind}:${arguments_.id}`, item };
      } },
      { name: 'novel_read_canvas', description: '读取当前小说无限画布的剧情节点、文字、分组、位置和连线。', properties: { offset: { type: 'integer' }, limit: { type: 'integer' } }, execute: async arguments_ => {
        const canvas = this.db.prepare('SELECT scene_json,revision FROM work_canvases WHERE work_id=?').get(workId);
        const scene = canvas ? JSON.parse(canvas.scene_json) : { elements: [] };
        return { source: `novel:${workId}/canvas`, revision: canvas?.revision || 0, ...textPage(JSON.stringify({ elements: scene.elements,
          image_files: Object.keys(scene.files || {}), image_note: '此工具提供图形结构与文字；图片像素请使用画布页面的 AI 分析。' }), arguments_.offset, arguments_.limit) };
      } }
    ];
    return connectInternalTools([...scope,
      { name: 'library_list_documents', description: '列出当前小说与自己的共享资料，未选小说时仅列共享资料。', execute: async () => ({
        documents: this.db.prepare('SELECT id,name,area FROM file_documents WHERE (work_id IS ? OR work_id IS NULL) AND deleted_at IS NULL ORDER BY name').all(workId) }) },
      { name: 'library_read_document', description: '分页读取上传并编辑过的资料；只有当前小说和共享资料可读。',
        properties: { document_id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['document_id'], execute: async arguments_ => {
          const document = this.db.prepare('SELECT id,name,extracted_text FROM file_documents WHERE id=? AND (work_id IS ? OR work_id IS NULL) AND deleted_at IS NULL').get(arguments_.document_id, workId);
          if (!document) throw failure(404, '当前范围没有此资料');
          if (!document.extracted_text) throw failure(422, '资料尚无可读取的文本，请检查解析状态');
          return { source: `document:${document.id}`, name: document.name, ...textPage(document.extracted_text, arguments_.offset, arguments_.limit) };
        } },
      { name: 'rankings_list_snapshots', description: '读取当前小说及自己的共享榜单快照；必须说明榜单和采集日期，旧快照不能代表最新风向。', execute: async () => ({ snapshots: this.snapshots(workId) }) },
      { name: 'qidian_scan_ranking', description: '低频读取起点公开榜单；可能被验证页面阻挡，失败不能当成空榜。', external: true,
        properties: { board: { type: 'string', enum: BOARDS.filter(board => !board.manual).map(board => board.id) } }, required: ['board'],
        execute: (arguments_, execution) => scanRanking(arguments_.board, { signal: execution.signal }) }
    ]);
  }
}
