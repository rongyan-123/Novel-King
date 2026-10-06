import { build } from 'esbuild';
import { mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'public', 'canvas-assets');
mkdirSync(output, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['canvas/workspace.jsx'], outdir: output, entryNames: 'canvas', bundle: true, splitting: true, format: 'esm', minify: true, target: ['es2022'], jsx: 'automatic', conditions: ['production'], define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked', chunkNames: 'chunks/[name]-[hash]', loader: { '.woff2': 'file', '.wasm': 'file' } });
const packageRoot = path.join(root, 'node_modules', '@excalidraw', 'excalidraw');
cpSync(path.join(packageRoot, 'dist', 'prod', 'fonts'), path.join(output, 'fonts'), { recursive: true });
// 保存构建依赖的许可原文；源码检出不作为构建前提。
const licenses = [];
for (const directory of readdirSync(path.join(root, 'node_modules'), { withFileTypes: true })) {
  if (!directory.isDirectory() || directory.name.startsWith('.')) continue;
  const names = directory.name.startsWith('@') ? readdirSync(path.join(root, 'node_modules', directory.name)).map((name) => `${directory.name}/${name}`) : [directory.name];
  for (const name of names) {
    const folder = path.join(root, 'node_modules', name);
    for (const file of readdirSync(folder)) if (/^(license|licence|copying|notice)(\.|$)/i.test(file)) {
      try { licenses.push(`\n===== ${name} / ${file} =====\n${readFileSync(path.join(folder, file), 'utf8')}`); } catch {}
    }
  }
}
if (existsSync(path.join(root, 'licenses', 'excalidraw-MIT.txt'))) licenses.unshift(readFileSync(path.join(root, 'licenses', 'excalidraw-MIT.txt'), 'utf8'));
if (existsSync(path.join(root, 'licenses', 'excalidraw-fonts.txt'))) licenses.unshift(readFileSync(path.join(root, 'licenses', 'excalidraw-fonts.txt'), 'utf8'));
writeFileSync(path.join(output, 'THIRD-PARTY-LICENSES.txt'), licenses.join('\n'));
console.log('Built self-hosted canvas with local fonts and third-party licenses.');
