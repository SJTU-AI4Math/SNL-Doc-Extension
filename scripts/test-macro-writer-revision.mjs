#!/usr/bin/env node
// Production CreateMacro bundle + real Linux publisher + official canonical CLI.
// This is a browser/host-seam gate, not an installed VS Code host certification.
import { macroPanelHost } from './macro-panel-browser-host.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = process.env.SNL_CAS_RUNTIME ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(process.env.SNL_SVG_EVIDENCE ?? resolve(repo, '../cas-browser-evidence'));
mkdirSync(evidence, { recursive: true });
const workspace = mkdtempSync(resolve(evidence, 'workspace-'));
const snl = process.env.SNL_CLI ?? 'snl';
const receipt = { workspace, cli: snl, operations: [], assertions: [], platform: process.platform };
function cli(args, input, expectOk = true) {
  const command = [...args, '--root', workspace, '--json', ...(input ? ['--input', '-'] : [])];
  const run = spawnSync(snl, command, { encoding: 'utf8', input: input ? JSON.stringify(input) : undefined });
  if (run.error) throw run.error;
  const response = JSON.parse(run.stdout);
  receipt.operations.push({ command, exit: run.status, response });
  writeFileSync(resolve(evidence, 'operations.json'), JSON.stringify(receipt.operations, null, 2) + '\n');
  if (expectOk) assert.equal(response.ok, true, run.stdout + run.stderr);
  return response;
}
cli(['init']);
cli(['validate']);
const packages = cli(['macro-package', 'list']).data.entities;
assert.ok(packages.length);
const packageId = packages.find(p => p.id !== '_unpackaged').id;
const initial = {
  package: packageId, name: 'Diagram.browser', kind: 'const', description: 'Keep description',
  source: { entries: [], urls: [] }, dynamic_arity: false, tags: ['keep-tag'],
  styles: [{ style_name: 'default', tags: ['style-tag'], template: {
    mode: 'block', block_template_name: 'svg_template', body: '#1 #0'
  } }]
};

const host = macroPanelHost(repo, workspace, () => {});
try {
  const name = 'Receipt.normalized';
  const request = { ...initial, name, description: 'R1 created' };
  delete request.package;
  const created = await host.doc.addMacro(host.root, packageId, request);
  assert.equal(created.status, 'ok', JSON.stringify(created));
  const read = await host.doc.readMacroPackage(host.root, packageId);
  const first = read.macros.find(m => m.name === name);
  assert.notEqual(host.doc.entityRevision(request), host.doc.entityRevision(first), 'fixture distinguishes raw UI input from normalized reader');
  assert.equal(created.committedRevision, host.doc.entityRevision(first), 'create receipt equals normalized durable reader revision');
  const updated = await host.doc.updateMacro(host.root, packageId, { ...first, description: 'R2 changed' }, created.committedRevision);
  assert.equal(updated.status, 'updated', JSON.stringify(updated));
  const after = (await host.doc.readMacroPackage(host.root, packageId)).macros.find(m => m.name === name);
  assert.notEqual(updated.committedRevision, created.committedRevision);
  assert.equal(updated.committedRevision, host.doc.entityRevision(after));
  const noop = await host.doc.updateMacro(host.root, packageId, after, updated.committedRevision);
  assert.equal(noop.committedRevision, updated.committedRevision);
  receipt.assertions.push('real entity create/update/no-op return normalized durable revision');
  receipt.status = 'PASS';
} catch (error) { receipt.status = 'FAIL'; receipt.error = String(error.stack ?? error); throw error; }
finally { host.close(); writeFileSync(resolve(evidence, 'writer-receipt.json'), JSON.stringify(receipt, null, 2)); }
