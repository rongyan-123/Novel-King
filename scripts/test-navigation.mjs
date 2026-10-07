import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function navigation() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../public/navigation.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.NovelKingNavigation.create();
}
class Page {
  constructor(host) { this.host = host; this.id = 'content'; this.className = 'content'; this.innerHTML = ''; this.isConnected = true; }
  cloneNode() { return new Page(this.host); }
  replaceWith(next) { this.isConnected = false; this.host.current = next; }
}

test('navigation replaces stale content immediately and an old response cannot overwrite the new page', async () => {
  const routes = navigation(), host = {}, bookshelf = new Page(host); host.current = bookshelf; bookshelf.innerHTML = '我的书架';
  const library = routes.begin(bookshelf, '文件库');
  assert.equal(bookshelf.isConnected, false);
  assert.match(host.current.innerHTML, /文件库/);
  assert.doesNotMatch(host.current.innerHTML, /我的书架/);
  const chat = routes.begin(host.current, 'AI 中心');
  chat.content.innerHTML = '聊天首页';
  await Promise.resolve();
  library.content.innerHTML = '慢请求的文件库';
  assert.equal(library.active(), false);
  assert.equal(chat.active(), true);
  assert.equal(host.current.innerHTML, '聊天首页');
});

test('navigation labels are escaped and a removed container is never active', () => {
  const routes = navigation(), host = {}, page = new Page(host);
  const route = routes.begin(page, '<img src=x onerror=alert(1)>');
  assert.doesNotMatch(route.content.innerHTML, /<img/);
  route.content.isConnected = false;
  assert.equal(route.active(), false);
});

test('account bootstrap downloads independent modules concurrently before executing the application', async () => {
  const scripts = [], completed = [];
  const sandbox = { window: { fetch: async () => ({ status: 404, ok: false }) },
    document: { createElement: () => ({}), body: { append(script) { scripts.push(script); } }, getElementById: () => ({}) },
    location: {}, AbortSignal, setTimeout, clearTimeout, console };
  vm.runInNewContext(fs.readFileSync(new URL('../public/account-client.js', import.meta.url), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(scripts.length >= 6, 'serial script download leaves first screen empty for multiple round trips');
  assert.equal(scripts.some(script => script.src === '/app.js'), false);
  for (const script of [...scripts]) { completed.push(script.src); script.onload(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scripts.at(-1).src, '/app.js');
  assert.ok(completed.includes('/research.js'));
});

test('chat homepage mounts immediately without a redundant blocking model-config request', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function renderAIHome('), end = source.indexOf('\n// ---------- overview', start);
  let mounted = false;
  const sandbox = { window: { NovelKingChat: {} }, ensureApiConfigs: async () => { throw Error('blocking old config fetch'); },
    renderAI: async () => { mounted = true; } };
  vm.runInNewContext(source.slice(start, end), sandbox);
  await sandbox.renderAIHome({ querySelector: () => null });
  assert.equal(mounted, true);
});

test('legacy AI settings remain available with a minimal DOM while detached real pages are skipped', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function renderAIHome('), end = source.indexOf('\n// ---------- overview', start);
  let mounts = 0;
  const sandbox = { window: {}, ensureApiConfigs: async () => {}, renderAI: async () => { mounts++; } };
  vm.runInNewContext(source.slice(start, end), sandbox);
  await sandbox.renderAIHome({ querySelector: () => null });
  assert.equal(mounts, 1);
  await sandbox.renderAIHome({ isConnected: false, querySelector: () => null });
  assert.equal(mounts, 1);
});

test('a desktop expanded-sidebar preference never covers the first mobile chat screen', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const expression = source.match(/sidebarCollapsed: (\(\(\) => \{[^\n]+\}\)\(\))/)[1];
  const read = width => vm.runInNewContext(expression, { accountLocalStorage: { getItem: () => '0' }, window: { innerWidth: width } });
  assert.equal(read(390), true);
  assert.equal(read(1440), false);
});

test('choosing a mobile destination closes the navigation drawer without changing desktop state', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function closeMobileSidebar('), end = source.indexOf('\nfunction setEditorComposition', start);
  const sandbox = { state: { sidebarCollapsed: false }, window: { innerWidth: 390 }, setSidebar: () => {} };
  vm.runInNewContext(source.slice(start, end), sandbox);
  sandbox.closeMobileSidebar(); assert.equal(sandbox.state.sidebarCollapsed, true);
  sandbox.state.sidebarCollapsed = false; sandbox.window.innerWidth = 1440;
  sandbox.closeMobileSidebar(); assert.equal(sandbox.state.sidebarCollapsed, false);
});
