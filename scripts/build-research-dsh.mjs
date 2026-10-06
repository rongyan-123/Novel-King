import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const upstream = path.resolve(process.env.NOVELKING_DSH_SOURCE || path.join(repo, '..', 'deepseek-harness'));
const packageInfo = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json')));
const destination = path.join(repo, 'vendor', 'dsh-research');
fs.mkdirSync(destination, { recursive: true });
const result = await build({ entryPoints: [path.join(repo, 'ai/research/dsh-entry.mjs')], outfile: path.join(destination, 'runtime.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: false, legalComments: 'eof', metafile: true,
  nodePaths: [path.join(upstream, 'node_modules/.pnpm/node_modules'), path.join(upstream, 'node_modules')],
  plugins: [{ name: 'freeze-package-metadata', setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\// }, async entry => {
      if (entry.pluginData?.sourceResolved) return;
      const resolved = await builder.resolve(entry.path, { kind: entry.kind, resolveDir: entry.resolveDir, pluginData: { sourceResolved: true } });
      if (resolved.errors.length) return resolved;
      const source = resolved.path.replace(/[/\\]lib[/\\](?:types[/\\])?/, '/src/').replace(/\.js$/, '.ts');
      return { path: fs.existsSync(source) ? source : resolved.path };
    });
    builder.onLoad({ filter: /\.[jt]s$/ }, async entry => {
      if (!entry.path.startsWith(upstream)) return;
      let contents = fs.readFileSync(entry.path, 'utf8');
      if (entry.path.replaceAll('\\', '/').endsWith('/llm-deepseek/src/adapter.ts')) {
        const original = "body: payload,\n        signal,";
        const normalized = contents.replaceAll('\r\n', '\n');
        if (!normalized.includes(original)) throw Error('DSH adapter changed; review the no-redirect patch before rebuilding');
        contents = normalized.replace(original, "body: payload,\n        redirect: 'error',\n        signal,");
        return { contents, loader: 'ts', resolveDir: path.dirname(entry.path) };
      }
      const reference = /createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/g;
      if (!reference.test(contents)) return;
      contents = contents.replace(reference, JSON.stringify(JSON.parse(fs.readFileSync(path.resolve(path.dirname(entry.path), '../package.json')))));
      return { contents, loader: entry.path.endsWith('.ts') ? 'ts' : 'js', resolveDir: path.dirname(entry.path) };
    });
  } }] });
fs.copyFileSync(path.join(upstream, 'LICENSE'), path.join(destination, 'LICENSE'));
fs.copyFileSync(path.join(upstream, 'THIRD_PARTY_NOTICES.md'), path.join(destination, 'THIRD_PARTY_NOTICES.md'));
const dependencyMap = new Map();
fs.mkdirSync(path.join(destination, 'licenses'), { recursive: true });
for (const input of Object.keys(result.metafile.inputs)) {
  let directory = path.dirname(path.resolve(repo, input));
  while (directory !== path.dirname(directory)) {
    const metadata = path.join(directory, 'package.json');
    if (fs.existsSync(metadata)) {
      if (directory === repo) break;
      const dependency = JSON.parse(fs.readFileSync(metadata));
      if (dependencyMap.has(dependency.name)) break;
      const notice = fs.readdirSync(directory).find(name => /^licen[cs]e(?:\.|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
      const licenseSource = notice ? path.join(directory, notice) : path.join(upstream, 'LICENSE');
      if (!notice && !directory.startsWith(upstream)) throw Error('Missing third-party license: ' + dependency.name);
      const licenseFile = notice ? 'licenses/' + dependency.name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.txt' : 'LICENSE';
      if (notice) fs.copyFileSync(licenseSource, path.join(destination, licenseFile));
      dependencyMap.set(dependency.name, { name: dependency.name, version: dependency.version, license: dependency.license, license_file: licenseFile });
      break;
    }
    directory = path.dirname(directory);
  }
}
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ source: 'https://github.com/deepseek-ai/deepseek-harness',
  version: packageInfo.version, license: packageInfo.license,
  sha256: createHash('sha256').update(fs.readFileSync(path.join(destination, 'runtime.mjs'))).digest('hex'),
  capability: 'core agent loop; no shell, arbitrary filesystem, code execution or self-modification plugins',
  patches: ['Model HTTP requests use redirect:error; upstream source is unchanged'],
  dependencies: [...dependencyMap.values()],
  inputs: Object.keys(result.metafile.inputs).map(filename => filename.replaceAll('\\', '/').replace(upstream.replaceAll('\\', '/'), '<upstream>')) }, null, 2) + '\n');
console.log('DSH research core built:', packageInfo.version);
