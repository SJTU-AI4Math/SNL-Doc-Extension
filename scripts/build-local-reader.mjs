#!/usr/bin/env node
// Local HTTP shell + the SAME browser reader/search/graph used by HTML exports.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out' || !args[1]) {
  console.error('Usage: node scripts/build-local-reader.mjs --out <directory>');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(args[1]);
await mkdir(out, { recursive: true });
// The shared pure model uses the same public Basics bridge as the Extension.
// Build it here too: a source archive has no pre-existing out/ directory.
await import('./build-snl-basics-host.mjs');
const noVsCode = {
  name: 'no-vscode-runtime',
  setup(build) {
    build.onResolve({ filter: /^vscode(?:\/|$)/ }, args => ({ errors: [{ text: `VS Code runtime dependency is not allowed: ${args.importer}` }] }));
  }
};
// Keep production browser settings identical to build-export-runtime.mjs.
const browser = await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'webview/src/reader/localReaderMain.tsx')],
  outfile: resolve(out, 'reader.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  metafile: true, plugins: [noVsCode]
});
const model = await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, 'src/readerWorkspaceModel.ts')],
  outfile: resolve(out, 'model.mjs'),
  bundle: true, format: 'esm', platform: 'node', target: 'node20',
  // Bundled CJS dependencies can still require Node built-ins in an ESM artifact.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  metafile: true, plugins: [noVsCode]
});
await writeFile(resolve(out, 'index.html'), await readFile(resolve(root, 'webview/src/reader/local-reader.html')));
await writeFile(resolve(out, 'reader.meta.json'), JSON.stringify(browser.metafile));
await writeFile(resolve(out, 'model.meta.json'), JSON.stringify(model.metafile));
// Trace bundle inputs back to exact shared component bytes, rather than a parallel reader copy.
const hashes = {};
for (const input of Object.keys(browser.metafile.inputs).sort()) {
  if (!input.startsWith('webview/src/') && !input.startsWith('src/')) continue;
  hashes[input] = createHash('sha256').update(await readFile(resolve(root, input))).digest('hex');
}
await writeFile(resolve(out, 'reader.sources.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log(`Built local workspace reader (index.html, reader.js, reader.css, model.mjs) in ${out}`);
