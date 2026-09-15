#!/usr/bin/env node
// Author inputs only. Canonical identities/envelopes/receipts belong to the official CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const authorRoot = resolve(repo, 'test-fixtures/svg-entry-integration');
export function authorInputs() { return JSON.parse(readFileSync(resolve(authorRoot, 'manifest.json'), 'utf8')); }
export function createSvgEntryFixture(options = {}) {
  const root = options.root ?? mkdtempSync(resolve(tmpdir(), 'snl-svg-entry-'));
  const cli = options.cli ?? process.env.SNL_CLI ?? (existsSync(resolve(repo, '../SNL-Agent-Toolkit/dist/cli/snl.mjs')) ? resolve(repo, '../SNL-Agent-Toolkit/dist/cli/snl.mjs') : 'snl');
  const operations = [];
  function run(args, input, expectedOk = true) {
    const argv = [...args, '--root', root, '--json', ...(input ? ['--input', '-'] : [])];
    const executable = cli.endsWith('.mjs') ? process.execPath : cli;
    const command = cli.endsWith('.mjs') ? ['--v8-pool-size=2', cli, ...argv] : argv;
    const result = spawnSync(executable, command, { encoding: 'utf8', input: input ? JSON.stringify(input) : undefined, env: { ...process.env, UV_THREADPOOL_SIZE: '2' }, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    const response = JSON.parse(result.stdout);
    operations.push({ executable, command, exit: result.status, response, stderr: result.stderr });
    if (options.log) writeFileSync(options.log, JSON.stringify(operations, null, 2) + '\n');
    if (expectedOk) { assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(response.ok, true, result.stdout); }
    return response;
  }
  assert.equal(existsSync(resolve(root, '.SNL_Doc')), false, 'Refuse to overwrite an existing workspace');
  mkdirSync(root, { recursive: true });
  const authored = authorInputs();
  run(['init']);
  run(['validate']);
  for (const value of authored.entryKinds) run(['entry-kind', 'create'], value);
  for (const value of authored.macroKinds) run(['macro-kind', 'create'], value);
  run(['macro-package', 'create'], authored.package);
  // Explicit ownership replaces the legacy global default; no config/receipt edits.
  for (const value of authored.entries) run(['entry', 'create'], value);
  for (const value of authored.macros) run(['macro', 'create'], value);
  run(['library', 'create'], authored.library);
  const bytes = readFileSync(resolve(authorRoot, 'assets/commutative-square.svg'));
  mkdirSync(resolve(root, '.SNL_Doc/assets'), { recursive: true });
  writeFileSync(resolve(root, '.SNL_Doc/assets/commutative-square.svg'), bytes, { flag: 'wx' });
  const validation = run(['validate']);
  const entries = authored.entries.map(value => run(['entry', 'get', value.id]).data.entity.value);
  const macros = Object.fromEntries(authored.macros.map(value => [value.name, run(['macro', 'get', `${value.package}::${value.name}`]).data.entity.value]));
  const library = run(['library', 'get', authored.library.slug]).data.entity.value;
  const pkg = run(['entry-package', 'get', authored.package.id]).data.entity.value;
  const entryKinds = authored.entryKinds.map(value => run(['entry-kind', 'get', value.id]).data.entity.value);
  const macroKinds = authored.macroKinds.map(value => run(['macro-kind', 'get', value.id]).data.entity.value);
  const config = JSON.parse(readFileSync(resolve(root, '.SNL_Doc/config.json'), 'utf8'));
  const resource = { text: bytes.toString('utf8'), revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  return { root, entries, macros, library, package: pkg, entryKinds, macroKinds, config, resource, validation, operations, run };
}
// Browser-ready raw snapshot from actual readback, not a synthesized CLI response.
// The caller supplies the production indexLibraryGraph/readingOrder result as outline.
export function svgEntryReaderSnapshot(fixture, outline, language = 'en') {
  return {
    version: 1, renderSnapshotId: `svg-entry-${language}`,
    library: { slug: fixture.library.slug, ...fixture.library.meta, outline, warnings: [] },
    entries: fixture.entries, macros: fixture.macros, entryKinds: fixture.entryKinds, macroKinds: fixture.macroKinds,
    entryPackages: Object.fromEntries(fixture.entries.map(entry => [entry.id, 'svg-fixture'])), relationships: [],
    contentLanguage: language, preferences: { language, color_scheme: 'light', motion: 'reduced', popover_hover_enabled: true },
    languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }],
    resources: { 'commutative-square.svg': { ...fixture.resource, url: `data:image/svg+xml,${encodeURIComponent(fixture.resource.text)}` } }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  const log = process.env.SNL_FIXTURE_LOG;
  const { run, ...fixture } = createSvgEntryFixture({ root, log });
  const output = process.env.SNL_FIXTURE_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify({ root: fixture.root, entries: fixture.entries.length, macros: Object.keys(fixture.macros).length, validation: fixture.validation }, null, 2));
}
