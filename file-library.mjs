import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const FILE_AREAS = [
  ['world', '世界设定', ['地点地图', '势力组织', '能力体系', '物品与种族', '历史时间线', '风俗文化']],
  ['characters', '人物关系', ['人物档案', '人物关系', '成长弧', '角色口吻']],
  ['outline', '剧情大纲', ['总纲', '卷纲', '章纲与场景', '支线与伏笔', '时间线']],
  ['manuscript', '章节正文', ['草稿', '修订稿', '发布稿']],
  ['books', '参考书与拆书', ['书籍资料夹', '拆书笔记', '章节分析']],
  ['craft', '写作技法', ['开篇钩子', '爽点与节奏', '对白描写', '结构套路', '样文']],
  ['research', '研究资料', ['历史地理', '科学技术', '职业生活', '查证笔记']],
  ['rankings', '榜单研究', ['三江榜', '新书榜', '其他榜单']],
  ['inspiration', '灵感素材', ['灵感片段', '台词', '图片与地图', '随手记']],
  ['publishing', '投稿运营', ['书名简介', '封面', '投稿记录', '读者反馈']],
].map(([id, name, suggestions]) => ({ id, name, suggestions }));
const MAX_BYTES = 20 * 1024 * 1024;
let parsing = 0;
const parseWaiters = [];
async function extractDocument(original, extension) {
  if (parsing >= 2) await new Promise(resolve => parseWaiters.push(resolve));
  else parsing++;
  try {
    return await new Promise(resolve => {
      const worker = new Worker(new URL('./file-text-worker.mjs', import.meta.url), { workerData: { original, extension }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
      let done = false;
      const finish = result => { if (done) return; done = true; clearTimeout(timeout); worker.terminate(); resolve(result); };
      const error = message => finish({ text: '', read_status: 'error', read_error: `${message}；原件已保留` });
      const timeout = setTimeout(() => error('文本提取超过 20 秒，请上传文字版'), 20000);
      worker.once('message', finish);
      worker.once('error', () => error('文档解析失败或超出可用内存'));
      worker.once('exit', code => { if (!done) error(`文档解析中断（${code}）`); });
      worker.stdout.resume(); worker.stderr.resume();
    });
  } finally { const next = parseWaiters.shift(); if (next) next(); else parsing--; }
}
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const publicFile = ({ extracted_text, edited_html, ...metadata }) => ({ ...metadata, text_length: extracted_text.length, has_edits: edited_html !== null,
  read_status: edited_html !== null ? 'ready' : metadata.read_status, read_error: edited_html !== null ? '' : metadata.read_error });
const FILE_METADATA_COLUMNS = "id,name,original_name,area,work_id,folder_id,size,sha256,CASE WHEN edited_html IS NOT NULL THEN 'ready' ELSE read_status END AS read_status,CASE WHEN edited_html IS NOT NULL THEN '' ELSE read_error END AS read_error,deleted_at,created_at,updated_at,text_length,content_revision,edited_html IS NOT NULL AS has_edits";
const editableFile = file => file.edited_html !== null || file.read_status === 'ready' || /\.(txt|md|markdown)$/i.test(file.original_name || file.name);
const validName = value => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 240 || /[\\/\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) fail('名称需为 1–240 字，不能包含路径或控制字符');
  return name;
};

export async function handleFiles({ req, res, segments, query, db, dataDir, agent, sendJSON, readBody }) {
  const respond = (status, body) => sendJSON(res, status, body);
  const action = segments[2], detail = segments[3], method = req.method;
  const blobs = path.join(dataDir, 'file-library');
  try {
    if (agent && method !== 'GET') fail('文件库只允许作者操作；资料工具只读', 403);
    if (agent && !query.work_id && query.scope !== 'shared') fail('只读工具必须指定 work_id 或共享资料范围');
    for (const key of ['offset', 'limit']) {
      if (query[key] !== undefined && (!/^\d+$/.test(query[key]) || !Number.isSafeInteger(Number(query[key])) || (key === 'limit' && Number(query[key]) < 1))) fail('分页参数必须是有效的非负整数，limit 至少为 1');
    }
    const jsonBody = async () => {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求体必须是 JSON 对象');
      return body;
    };
    if (query.work_id && (!/^\d+$/.test(query.work_id) || !Number.isSafeInteger(Number(query.work_id)) || Number(query.work_id) < 1)) fail('作品 ID 无效');
    const workId = query.work_id ? Number(query.work_id) : null;
    if (workId && !db.prepare('SELECT id FROM works WHERE id=?').get(workId)) fail('作品不存在', 404);
    const validateLocation = (area, owner, folderId) => {
      if (!FILE_AREAS.some(entry => entry.id === area)) fail('请选择资料分类');
      if (owner !== null && (!Number.isSafeInteger(owner) || owner < 1 || !db.prepare('SELECT id FROM works WHERE id=?').get(owner))) fail('所属作品不存在');
      if (folderId) {
        const folder = db.prepare('SELECT * FROM file_folders WHERE id=?').get(folderId);
        if (!folder || folder.area !== area || folder.work_id !== owner) fail('文件夹与分类或所属作品不一致');
      }
    };
    const where = [], values = [];
    if (query.work_id) { where.push('work_id = ?'); values.push(workId); }
    else if (query.scope === 'shared') where.push('work_id IS NULL');
    if (query.area) { where.push('area = ?'); values.push(query.area); }
    const scope = where.length ? ' AND ' + where.join(' AND ') : '';
    const lookup = (table, id) => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?${scope}`).get(id, ...values);
      if (!row) fail('资料不存在或不在当前范围内', 404);
      return row;
    };
    if (method === 'GET' && detail === 'edit') {
      const file = lookup('file_documents', action);
      if (file.deleted_at) fail('资料已在回收站', 404);
      return respond(200, { ...publicFile(file), html: file.edited_html, text: file.extracted_text, revision: file.content_revision, editable: editableFile(file) });
    }
    if (method === 'PUT' && detail === 'content') {
      if (!workId && query.scope !== 'shared') fail('保存资料必须指定所属小说或共享范围');
      const file = lookup('file_documents', action);
      if (file.deleted_at) fail('请先从回收站恢复资料', 409);
      if (!editableFile(file)) fail('此文件没有可编辑的文字，请上传文字版；原件可下载', 415);
      const body = await jsonBody();
      if (typeof body.html !== 'string' || typeof body.text !== 'string' || !Number.isSafeInteger(body.revision) || body.revision < 0) fail('编辑稿需要 HTML、文字和有效版本号');
      if (Buffer.byteLength(body.html) > MAX_BYTES || Buffer.byteLength(body.text) > MAX_BYTES) fail('编辑稿不能超过 20 MB', 413);
      const saved = db.prepare("UPDATE file_documents SET edited_html=?,extracted_text=?,text_length=?,content_revision=content_revision+1,updated_at=datetime('now') WHERE id=? AND content_revision=?").run(body.html, body.text, body.text.length, file.id, body.revision);
      if (!saved.changes) fail('资料已在其他窗口更新；你的编辑稿已保留，请下载后重新打开最新版本', 409);
      return respond(200, { ...publicFile(db.prepare('SELECT * FROM file_documents WHERE id=?').get(file.id)), revision: body.revision + 1 });
    }
    if (method === 'GET' && detail === 'export') {
      const file = lookup('file_documents', action);
      if (file.deleted_at) fail('资料已在回收站', 404);
      const text = Buffer.from(file.extracted_text, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="notes.txt"; filename*=UTF-8''${encodeURIComponent(file.name.replace(/\.[^.]+$/, '') + '.txt')}`, 'X-Content-Type-Options': 'nosniff', 'Content-Length': text.length });
      return res.end(text);
    }
    if (!action && method === 'GET') {
      const folders = db.prepare(`SELECT * FROM file_folders WHERE 1=1${scope} ORDER BY created_at, name`).all(...values);
      const filter = [], parameters = [...values];
      if (query.folder_id !== undefined) { filter.push(query.folder_id ? 'folder_id = ?' : 'folder_id IS NULL'); if (query.folder_id) parameters.push(query.folder_id); }
      if (query.q?.trim()) { if (query.q.length > 200) fail('搜索词过长'); filter.push('(instr(lower(name),lower(?)) > 0 OR instr(lower(extracted_text),lower(?)) > 0)'); parameters.push(query.q.trim(), query.q.trim()); }
      const count = db.prepare(`SELECT count(*) AS count FROM file_documents WHERE deleted_at IS ${query.trash === '1' ? 'NOT ' : ''}NULL${scope}${filter.length ? ' AND ' + filter.join(' AND ') : ''}`).get(...parameters).count;
      const offset = Math.max(0, Math.trunc(Number(query.offset) || 0));
      const files = db.prepare(`SELECT ${FILE_METADATA_COLUMNS} FROM file_documents WHERE deleted_at IS ${query.trash === '1' ? 'NOT ' : ''}NULL${scope}${filter.length ? ' AND ' + filter.join(' AND ') : ''} ORDER BY updated_at DESC, id LIMIT 100 OFFSET ?`).all(...parameters, offset);
      // Metadata pages must not hold up to 100 complete documents in JS memory.
      // Earlier library rows without a cached length are read one at a time, without writes.
      for (const file of files) if (file.text_length === null) file.text_length = db.prepare('SELECT extracted_text FROM file_documents WHERE id=?').get(file.id).extracted_text.length;
      return respond(200, { folders, files, total: count, next_offset: offset + files.length < count ? offset + files.length : null });
    }
    if (action === 'status' && method === 'GET') {
      const counts = db.prepare(`SELECT area, count(*) AS count FROM file_documents WHERE deleted_at IS NULL${scope} GROUP BY area`).all(...values);
      const works = (agent && query.scope === 'shared' ? [] : db.prepare(`SELECT id,title FROM works${workId ? ' WHERE id=?' : ''}`).all(...(workId ? [workId] : []))).map(work => {
        const canvas = db.prepare('SELECT scene_json FROM work_canvases WHERE work_id=?').get(work.id);
        let canvasNodes = 0;
        if (canvas) try { canvasNodes = JSON.parse(canvas.scene_json).elements.filter(node => !node.isDeleted).length; } catch {}
        return { ...work, total_files: db.prepare('SELECT count(*) AS count FROM file_documents WHERE work_id=? AND deleted_at IS NULL').get(work.id).count,
          books: db.prepare("SELECT count(*) AS count FROM file_folders WHERE work_id=? AND kind='book'").get(work.id).count,
          chapters: db.prepare('SELECT count(*) AS count FROM chapters WHERE work_id=?').get(work.id).count,
          characters: db.prepare('SELECT count(*) AS count FROM characters WHERE work_id=?').get(work.id).count,
          settings: db.prepare('SELECT count(*) AS count FROM terms WHERE work_id=?').get(work.id).count + db.prepare('SELECT count(*) AS count FROM world_entries WHERE work_id=?').get(work.id).count,
          recent_chapter: db.prepare('SELECT id,title,updated_at FROM chapters WHERE work_id=? ORDER BY updated_at DESC LIMIT 1').get(work.id) || null, canvas_nodes: canvasNodes };
      });
      return respond(200, { areas: FILE_AREAS.map(area => ({ ...area, count: counts.find(row => row.area === area.id)?.count || 0 })), total_files: counts.reduce((sum, row) => sum + row.count, 0), books: db.prepare(`SELECT count(*) AS count FROM file_folders WHERE kind='book'${scope}`).get(...values).count, works,
        ...(!workId && !query.scope ? { shared_files: db.prepare('SELECT count(*) AS count FROM file_documents WHERE work_id IS NULL AND deleted_at IS NULL').get().count,
          shared_books: db.prepare("SELECT count(*) AS count FROM file_folders WHERE work_id IS NULL AND kind='book'").get().count } : {}) });
    }
    if (action === 'folders' && method === 'POST') {
      const body = await jsonBody();
      validateLocation(body.area, body.work_id ?? null, body.parent_id);
      const name = validName(body.name);
      if (!['folder', 'book'].includes(body.kind || 'folder') || (body.kind === 'book' && body.area !== 'books')) fail('书籍资料夹只能建在参考书区');
      if (!['manual', 'sanjiang', 'newbooks'].includes(body.source || 'manual')) fail('资料来源标记无效');
      const id = randomUUID();
      db.prepare('INSERT INTO file_folders(id,name,area,work_id,parent_id,kind,source) VALUES (?,?,?,?,?,?,?)').run(id, name, body.area, body.work_id || null, body.parent_id || null, body.kind || 'folder', body.source || 'manual');
      return respond(201, db.prepare('SELECT * FROM file_folders WHERE id=?').get(id));
    }
    if (action === 'folders' && detail && ['PATCH', 'DELETE'].includes(method)) {
      const folder = lookup('file_folders', detail);
      if (method === 'DELETE') {
        if (db.prepare('SELECT id FROM file_folders WHERE parent_id=? LIMIT 1').get(folder.id) || db.prepare('SELECT id FROM file_documents WHERE folder_id=? LIMIT 1').get(folder.id)) fail('目录含子文件夹或资料（包括回收站），请先移动资料', 409);
        db.prepare('DELETE FROM file_folders WHERE id=?').run(folder.id);
        return respond(200, { ok: true });
      }
      const body = await jsonBody();
      const parent = body.parent_id === undefined ? folder.parent_id : body.parent_id;
      validateLocation(folder.area, folder.work_id, parent);
      let ancestor = parent, depth = 0;
      while (ancestor) {
        if (ancestor === folder.id || ++depth > 64) fail('不能将目录移入自身或自己的子目录');
        ancestor = db.prepare('SELECT parent_id FROM file_folders WHERE id=?').get(ancestor)?.parent_id;
      }
      db.prepare('UPDATE file_folders SET name=?,parent_id=? WHERE id=?').run(body.name === undefined ? folder.name : validName(body.name), parent || null, folder.id);
      return respond(200, db.prepare('SELECT * FROM file_folders WHERE id=?').get(folder.id));
    }
    if (['PATCH', 'DELETE'].includes(method) || (method === 'POST' && detail === 'restore')) {
      const file = lookup('file_documents', action);
      if (method === 'DELETE') db.prepare("UPDATE file_documents SET deleted_at=coalesce(deleted_at,datetime('now')),updated_at=datetime('now') WHERE id=?").run(file.id);
      else if (detail === 'restore') db.prepare("UPDATE file_documents SET deleted_at=NULL,updated_at=datetime('now') WHERE id=?").run(file.id);
      else {
        if (file.deleted_at) fail('请先从回收站恢复资料', 409);
        const body = await jsonBody();
        const area = body.area ?? file.area, owner = body.work_id === undefined ? file.work_id : body.work_id;
        const folderId = body.folder_id === undefined ? file.folder_id : body.folder_id;
        validateLocation(area, owner, folderId);
        db.prepare("UPDATE file_documents SET name=?,area=?,work_id=?,folder_id=?,updated_at=datetime('now') WHERE id=?").run(body.name === undefined ? file.name : validName(body.name), area, owner, folderId || null, file.id);
      }
      return respond(200, publicFile(db.prepare('SELECT * FROM file_documents WHERE id=?').get(file.id)));
    }
    if (action === 'upload' && method === 'POST') {
      validateLocation(query.area, workId, query.folder_id);
      const name = validName(query.name);
      if (Number(req.headers['content-length']) > MAX_BYTES) fail('单文件不能超过 20 MB', 413);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) fail('单文件不能超过 20 MB', 413); chunks.push(chunk); }
      const original = Buffer.concat(chunks);
      const ext = path.extname(name).toLowerCase();
      let text = '', readStatus = 'original', readError = '';
      if (['.txt', '.md', '.markdown'].includes(ext)) {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(original); readStatus = text.trim() ? 'ready' : 'original'; }
        catch { readStatus = 'error'; readError = '文本不是 UTF-8 编码，请转换编码后重新上传；原件已保留'; }
      }
      if (['.docx', '.pdf'].includes(ext)) {
        const parsed = await extractDocument(original, ext);
        text = parsed.text; readStatus = parsed.read_status; readError = parsed.read_error;
      }
      if (res.destroyed || req.aborted) return;
      const id = randomUUID(); await mkdir(blobs, { recursive: true });
      const originalPath = path.join(blobs, id);
      await writeFile(originalPath, original, { flag: 'wx' });
      try {
        if (res.destroyed || req.aborted) { await unlink(originalPath); return; }
        validateLocation(query.area, workId, query.folder_id);
        db.prepare('INSERT INTO file_documents(id,name,original_name,area,work_id,folder_id,size,sha256,extracted_text,text_length,read_status,read_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, name, name, query.area, workId, query.folder_id || null, size, createHash('sha256').update(original).digest('hex'), text, text.length, readStatus, readError);
      } catch (error) { await unlink(originalPath); throw error; }
      return respond(201, publicFile(db.prepare('SELECT * FROM file_documents WHERE id=?').get(id)));
    }
    if (method === 'GET' && detail === 'text') {
      const file = lookup('file_documents', action);
      if (file.deleted_at) fail('资料已在回收站', 404);
      const offset = Math.max(0, Number(query.offset) || 0), limit = Math.min(50000, Math.max(1, Number(query.limit) || 20000));
      return respond(200, { ...publicFile(file), text: file.extracted_text.slice(offset, offset + limit), offset, next_offset: offset + limit < file.extracted_text.length ? offset + limit : null });
    }
    if (method === 'GET' && ['original', 'preview'].includes(detail)) {
      const file = lookup('file_documents', action);
      if (file.deleted_at) fail('资料已在回收站', 404);
      const original = await readFile(path.join(blobs, file.id));
      let mime = 'application/octet-stream';
      if (detail === 'preview') {
        if (original.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
        else if (original[0] === 255 && original[1] === 216 && original[2] === 255) mime = 'image/jpeg';
        else if (['GIF87a', 'GIF89a'].includes(original.toString('ascii', 0, 6))) mime = 'image/gif';
        else if (original.toString('ascii', 0, 4) === 'RIFF' && original.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
        else fail('此原件不是支持的图片格式', 415);
      }
      res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `${detail === 'preview' ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Length': original.length });
      return res.end(original);
    }
    fail('文件库接口不存在', 404);
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      if (error.status === 413) { res.setHeader('Connection', 'close'); req.resume(); }
      const status = error.status || (['INVALID_JSON', 'PAYLOAD_TOO_LARGE'].includes(error.code) ? error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400 : 500);
      return respond(status, { error: error.status || error.code === 'INVALID_JSON' ? error.message : '文件库操作失败，请重试' });
    }
  }
}
