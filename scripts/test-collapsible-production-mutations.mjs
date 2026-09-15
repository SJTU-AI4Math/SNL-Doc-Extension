#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileCensus,
  parseTerminalResults,
  restoreFiles,
  sameFileCensus,
  snapshotFiles,
  validateProbeResult
} from './library-depth-harness-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(resolve(root, '.browser-author-overlay.json')) || existsSync(resolve(root, '.git'))) throw new Error('Run only in an owned browser-author-overlay.py snapshot');
const harness = resolve(root, 'scripts/test-collapsible-production-surfaces.mjs');
const source = resolve(root, 'webview/src/render/blockRenderers.tsx');
const bundleDir = resolve(root, 'media/webview');
const profilePrefix = 'snl-ca-';

function artifactFiles() {
  if (!existsSync(bundleDir)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(bundleDir);
  return files.sort();
}

function profileDirectories() {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(profilePrefix))
    .map((entry) => entry.name)
    .sort();
}

function ownedBrowserProcesses() {
  if (process.platform !== 'linux' || !existsSync('/proc')) return [];
  const matches = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const command = readFileSync(resolve('/proc', entry.name, 'cmdline')).toString().replaceAll('\0', ' ');
      if (command.includes(`--user-data-dir=`) && command.includes(profilePrefix)) matches.push(Number(entry.name));
    } catch { /* process exited during census */ }
  }
  return matches.sort((left, right) => left - right);
}

function run(extraEnv = {}) {
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function requireNoResourceDrift(label, before) {
  const afterFiles = artifactFiles();
  if (JSON.stringify(before.files) !== JSON.stringify(afterFiles) ||
      !sameFileCensus(before.census, fileCensus(afterFiles))) {
    throw new Error(`${label}: generated artifact census changed`);
  }
  const afterProfiles = profileDirectories();
  if (JSON.stringify(before.profiles) !== JSON.stringify(afterProfiles)) {
    throw new Error(`${label}: temporary Chromium profiles leaked: ${JSON.stringify({ before: before.profiles, after: afterProfiles })}`);
  }
  const processes = ownedBrowserProcesses();
  if (processes.length) throw new Error(`${label}: Chromium process leak: ${processes.join(',')}`);
}

function resourceCensus() {
  const files = artifactFiles();
  return { files, census: fileCensus(files), profiles: profileDirectories() };
}

function expectMutation(label, result, assertionId) {
  const terminal = parseTerminalResults(result.output);
  const rawIds = [...result.output.matchAll(/\[ASSERT:([A-Z0-9-]+)\]/g)].map((match) => match[1]);
  const exact = terminal.length === 1 && terminal[0]?.kind === 'assertion' && terminal[0]?.id === assertionId &&
    Object.keys(terminal[0]).length === 2 && rawIds.length === 1 && rawIds[0] === assertionId;
  if (result.status === 0 || !exact) {
    throw new Error(`${label}: mutation was not killed exactly by ${assertionId}: ${JSON.stringify({ terminal, rawIds })}`);
  }
}

const sourceSnapshot = snapshotFiles([source]);
const sourceCensus = fileCensus([source]);
const initialResources = resourceCensus();
try {
  const baseline = run();
  const baselineValidation = validateProbeResult(baseline.output, { kind: 'pass' });
  if (baseline.status !== 0 || !baselineValidation.ok) {
    throw new Error(`baseline failed: ${JSON.stringify(baselineValidation)}`);
  }
  requireNoResourceDrift('baseline', initialResources);

  const original = readFileSync(source, 'utf8');
  const defaultClosed = '  return true;\n}';
  const defaultOpen = '  return false;\n}';
  if (original.split(defaultClosed).length !== 2) throw new Error('default-open mutation target is not unique');
  writeFileSync(source, original.replace(defaultClosed, defaultOpen));
  try {
    const result = run();
    expectMutation('default-open', result, 'DEFAULT-CLOSED');
  } finally {
    restoreFiles(sourceSnapshot);
  }
  if (!sameFileCensus(sourceCensus, fileCensus([source]))) throw new Error('default-open mutation did not restore source metadata');
  requireNoResourceDrift('default-open', initialResources);

  const visibility = run({ SNL_COLLAPSIBLE_MUTATION: 'visibility-override' });
  expectMutation('visibility-override', visibility, 'DEFAULT-CLOSED-VISIBILITY');
  requireNoResourceDrift('visibility-override', initialResources);

  const rerender = run({ SNL_COLLAPSIBLE_MUTATION: 'rerender-dom-only' });
  expectMutation('rerender-dom-only', rerender, 'RERENDER-CONTROLLED');
  requireNoResourceDrift('rerender-dom-only', initialResources);

  const cleanup = run({ SNL_COLLAPSIBLE_FORCE_FAILURE: 'after-browser' });
  expectMutation('forced-after-browser', cleanup, 'FORCED-AFTER-BROWSER');
  requireNoResourceDrift('forced-after-browser', initialResources);

  const restored = run();
  if (restored.status !== 0 || !validateProbeResult(restored.output, {kind:'pass'}).ok) throw Error('restored GREEN failed');
  requireNoResourceDrift('restored', initialResources);
  console.log(JSON.stringify({
    kind: 'pass',
    mutations: {
      defaultOpen: 'DEFAULT-CLOSED',
      visibilityOverride: 'DEFAULT-CLOSED-VISIBILITY',
      directDomRerender: 'RERENDER-CONTROLLED',
      forcedCleanup: 'FORCED-AFTER-BROWSER'
    },
    artifactFiles: initialResources.files.length,
    profiles: profileDirectories().length,
    ownedBrowserProcesses: ownedBrowserProcesses().length
  }));
} finally {
  restoreFiles(sourceSnapshot);
  if (!sameFileCensus(sourceCensus, fileCensus([source]))) {
    throw new Error('mutation runner final source restoration failed');
  }
}
