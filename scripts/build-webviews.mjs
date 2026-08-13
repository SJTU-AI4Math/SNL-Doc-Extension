#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'webview/productionEntries.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const outputDir = resolve(root, 'media/webview');
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');

rmSync(outputDir, { recursive: true, force: true });

for (const entry of manifest.entries) {
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--config', resolve(root, 'webview/vite.config.ts')],
    {
      cwd: root,
      env: { ...process.env, SNL_WEBVIEW_ENTRY: entry.name },
      stdio: 'inherit'
    }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!existsSync(resolve(outputDir, entry.output))) {
    throw new Error(`Vite did not emit required output ${entry.output}`);
  }
}

console.log(`Built ${manifest.entries.length} fresh production webview bundles.`);
