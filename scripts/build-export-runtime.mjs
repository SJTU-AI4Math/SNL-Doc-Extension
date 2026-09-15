#!/usr/bin/env node
// The interactive export boots the SAME React readers as the Extension panels.
// No DOM-only parallel hover/collapse/relationship runtime is built here.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportReader } from './export-reader-build.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await buildExportReader(root);
// The builder must validate the whole in-memory result before any publication.
await mkdir(resolve(root, 'media'), { recursive: true });
for (const output of result.outputFiles) await writeFile(output.path, output.contents);
await writeFile(resolve(root, 'media/exportRuntime.meta.json'), JSON.stringify(result.metafile));
console.log('Built shared React reader and offline CSS (media/exportRuntime.js, exportRuntime.css).');
