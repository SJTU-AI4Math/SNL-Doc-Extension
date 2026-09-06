#!/usr/bin/env node
// Generate media/exportRuntime.js — the script inlined into exported documents.
//
// Run as part of the build (see package.json `build:export-runtime`). Bundles
// SNL-Basics's DOM-only hover implementation and concatenates the Extension's
// own wiring + collapse logic. This is a build step so exported documents can
// inline a self-contained runtime without bundling when the user hits Export.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildHoverRuntime } from './export-hover-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The wiring half lives in TypeScript next to the collapse contract it depends
// on, so pull it through esbuild rather than duplicating it here.
const wiring = await build({
  entryPoints: [resolve(root, 'src/exportRuntime.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false
});
const wiringModule = wiring.outputFiles[0].text;
// Evaluate the compiled module to read EXPORT_RUNTIME_WIRING_JS out of it.
const dataUrl =
  'data:text/javascript;base64,' + Buffer.from(wiringModule).toString('base64');
const { EXPORT_RUNTIME_WIRING_JS, HOVER_ENTRY_SOURCE } = await import(dataUrl);

const hover = await buildHoverRuntime(HOVER_ENTRY_SOURCE, root);
const hoverJs = hover.outputFiles[0].text;

const out = resolve(root, 'media/exportRuntime.js');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${hoverJs}\n${EXPORT_RUNTIME_WIRING_JS}\n`, 'utf8');

console.log(
  `exportRuntime.js written (${(hoverJs.length / 1024).toFixed(1)} kB hover + ` +
    `${(EXPORT_RUNTIME_WIRING_JS.length / 1024).toFixed(1)} kB wiring)`
);
