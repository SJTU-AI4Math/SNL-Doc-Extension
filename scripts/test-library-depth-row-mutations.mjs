#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const probe = resolve(root, 'scripts/test-library-depth-row-geometry.mjs');
const mutations = [
  'reservation-11.3',
  'reveal-5.1',
  'depth-wrap',
  'title-8rem',
  'medium-max-content',
  'suggestions-in-flow'
];
const escaped = [];
for (const mutation of mutations) {
  const result = spawnSync(process.execPath, [probe], {
    cwd: root,
    env: {
      ...process.env,
      SNL_LIBRARY_GEOMETRY_MUTATION: mutation,
      SNL_LIBRARY_GEOMETRY_OUT: resolve(root, `.hermes/library-depth-mutation-${mutation}`)
    },
    stdio: 'inherit'
  });
  if (result.status === 0) {
    throw new Error(`Geometry gate survived mutation: ${mutation}`);
  }
  escaped.push(mutation);
}
console.log(JSON.stringify({ mutationEffective: escaped }, null, 2));
