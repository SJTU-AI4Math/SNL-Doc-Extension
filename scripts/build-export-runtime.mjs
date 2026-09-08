#!/usr/bin/env node
// The interactive export boots the SAME React readers as the Extension panels.
// No DOM-only parallel hover/collapse/relationship runtime is built here.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, 'media'), { recursive: true });
const result = await build({
  entryPoints: [resolve(root, 'webview/src/reader/BrowserReader.tsx')],
  outfile: resolve(root, 'media/exportRuntime.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  metafile: true
});
await writeFile(resolve(root, 'media/exportRuntime.meta.json'), JSON.stringify(result.metafile));
console.log('Built shared React reader and offline CSS (media/exportRuntime.js, exportRuntime.css).');
