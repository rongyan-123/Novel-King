import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ResearchWorkspace } from '../ai/research/workspace.mjs';

test('research MCP tools can read selected work, shared files and its canvas, but never another work or write operations', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY,title TEXT); CREATE TABLE chapters(id INTEGER PRIMARY KEY,work_id INTEGER,title TEXT,content TEXT,summary TEXT,position INTEGER);
    CREATE TABLE characters(id INTEGER PRIMARY KEY,work_id INTEGER,name TEXT,identity TEXT); CREATE TABLE terms(id INTEGER PRIMARY KEY,work_id INTEGER,title TEXT,content TEXT);
    CREATE TABLE world_entries(id INTEGER PRIMARY KEY,work_id INTEGER,title TEXT,content TEXT);
    CREATE TABLE work_canvases(work_id INTEGER PRIMARY KEY,scene_json TEXT,revision INTEGER);
    CREATE TABLE file_documents(id TEXT PRIMARY KEY,work_id INTEGER,name TEXT,area TEXT,extracted_text TEXT,deleted_at TEXT);
    INSERT INTO works VALUES(1,'我的小说'),(2,'另一作品'); INSERT INTO chapters VALUES(10,1,'开始','秘密设定一', '',0),(20,2,'他书','禁止读取','',0);
    INSERT INTO file_documents VALUES('mine',1,'设定.txt','world','我的资料',NULL),('other',2,'他书.txt','world','禁止读取',NULL),('shared',NULL,'参考.txt','books','共享参考',NULL);
    INSERT INTO work_canvases VALUES(1,'{"elements":[{"id":"plot","text":"第一幕"}],"files":{},"appState":{}}',1);`);
  try {
    const workspace = new ResearchWorkspace(database);
    const tools = await workspace.connectTools(1);
    const listed = await tools.client.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'novel_read_chapter'));
    assert.ok(listed.tools.every(tool => tool.annotations?.readOnlyHint));
    const chapter = await tools.client.callTool({ name: 'novel_read_chapter', arguments: { chapter_id: 10 } });
    assert.match(chapter.content[0].text, /秘密设定一/);
    const outside = await tools.client.callTool({ name: 'novel_read_chapter', arguments: { chapter_id: 20 } });
    assert.equal(outside.isError, true); assert.doesNotMatch(outside.content[0].text, /禁止读取/);
    const wrongFile = await tools.client.callTool({ name: 'library_read_document', arguments: { document_id: 'other' } });
    assert.equal(wrongFile.isError, true);
    const sharedFile = await tools.client.callTool({ name: 'library_read_document', arguments: { document_id: 'shared' } });
    assert.match(sharedFile.content[0].text, /共享参考/);
    const canvas = await tools.client.callTool({ name: 'novel_read_canvas', arguments: {} });
    assert.match(canvas.content[0].text, /第一幕/);
    assert.equal((await tools.client.callTool({ name: 'delete_file', arguments: { id: 'mine' } })).isError, true);
    await tools.close();
    assert.equal(database.prepare('SELECT count(*) AS n FROM file_documents').get().n, 3);
  } finally { database.close(); }
});
