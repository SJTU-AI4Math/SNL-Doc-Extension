#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = Number(process.env.SNL_LIBRARY_MUTATION_TIMEOUT_MS || 180_000);
const evidencePath = process.env.SNL_LIBRARY_MUTATION_EVIDENCE_OUT
  ? resolve(process.env.SNL_LIBRARY_MUTATION_EVIDENCE_OUT)
  : null;
if (evidencePath && (evidencePath === sourceRoot || evidencePath.startsWith(`${sourceRoot}${sep}`))) {
  throw new Error('[ASSERT:MUTATION-EVIDENCE-OUTSIDE-REPO] evidence output must be outside the repository');
}

const mutations = [
  { mutation: 'reservation-11.3', expectedAssertion: 'TOOLBAR-RESERVATION' },
  { mutation: 'reveal-5.1', expectedAssertion: 'TOOLBAR-RESERVATION' },
  { mutation: 'depth-wrap', expectedAssertion: 'ROW-HEIGHT-STABLE' },
  { mutation: 'title-8rem', expectedAssertion: 'DESKTOP-TITLE-BUDGET' },
  { mutation: 'medium-max-content', expectedAssertion: 'MEDIUM-KIND-SHRINK' },
  { mutation: 'suggestions-in-flow', expectedAssertion: 'ROW-SUGGESTIONS-OVERLAY' },
  { mutation: 'add-form-overflow', expectedAssertion: 'ADD-MENU-CONTAINER-BOUNDED' },
  { mutation: 'add-menu-missing', expectedAssertion: 'ADD-MENU-EXISTS' },
  { mutation: 'blank-phase-missing', expectedAssertion: 'SHRINK-BLANK-PHASE' },
  { mutation: 'title-phase-missing', expectedAssertion: 'SHRINK-TITLE-PHASE' },
  { mutation: 'id-phase-missing', expectedAssertion: 'SHRINK-ID-PHASE' },
  { mutation: 'id-below-floor', expectedAssertion: 'SHRINK-ID-FLOOR' }
];

function git(args) {
  const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const trackedPaths = git(['ls-files', '-z']).split('\0').filter(Boolean);
function trackedDigest(root) {
  const hash = createHash('sha256');
  for (const path of trackedPaths) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) throw new Error(`[ASSERT:MUTATION-COPY-COMPLETE] missing tracked path ${path}`);
    hash.update(path).update('\0').update(readFileSync(absolute)).update('\0');
  }
  return hash.digest('hex');
}

const sourceDigestBefore = trackedDigest(sourceRoot);
const nodeModules = resolve(sourceRoot, 'node_modules');
if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) {
  throw new Error('[ASSERT:MUTATION-DEPENDENCIES] source node_modules directory is unavailable');
}

function makeCopy() {
  const outer = mkdtempSync(resolve(tmpdir(), 'snl-library-depth-mutation-'));
  const root = resolve(outer, 'repo');
  mkdirSync(root);
  for (const path of trackedPaths) {
    const source = resolve(sourceRoot, path);
    const destination = resolve(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { preserveTimestamps: true });
  }
  symlinkSync(nodeModules, resolve(root, 'node_modules'), 'dir');
  return { outer, root, digest: trackedDigest(root) };
}

function runProbe(root, mutation = '') {
  const probe = resolve(root, 'scripts/test-library-depth-row-geometry.mjs');
  const result = spawnSync(process.execPath, [probe], {
    cwd: root,
    env: {
      ...process.env,
      SNL_LIBRARY_GEOMETRY_MUTATION: mutation,
      SNL_LIBRARY_GEOMETRY_OUT: ''
    },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    killSignal: 'SIGKILL'
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code || null,
    output,
    buildOk: output.includes('[HARNESS:BUILD_OK]'),
    harnessStarted: output.includes('[HARNESS:STARTED]'),
    assertionIds: [...new Set([...output.matchAll(/\[ASSERT:([A-Z0-9-]+)\]/g)].map((match) => match[1]))]
  };
}

function fail(message, run) {
  const excerpt = run?.output ? `\n--- child output ---\n${run.output.slice(-12_000)}` : '';
  throw new Error(`${message}${excerpt}`);
}

const rows = [];
for (const spec of mutations) {
  const copy = makeCopy();
  try {
    const baseline = runProbe(copy.root);
    if (baseline.errorCode === 'ETIMEDOUT' || baseline.signal) fail(`[ASSERT:MUTATION-BASELINE-INFRA] ${spec.mutation} baseline timed out or was signalled`, baseline);
    if (baseline.status !== 0) fail(`[ASSERT:MUTATION-BASELINE-PASS] ${spec.mutation} baseline exited ${baseline.status}`, baseline);
    if (!baseline.buildOk || !baseline.harnessStarted) fail(`[ASSERT:MUTATION-BASELINE-HARNESS] ${spec.mutation} baseline did not build and start`, baseline);
    if (baseline.assertionIds.length) fail(`[ASSERT:MUTATION-BASELINE-CLEAN] ${spec.mutation} baseline emitted assertions ${baseline.assertionIds.join(',')}`, baseline);

    const mutated = runProbe(copy.root, spec.mutation);
    if (mutated.errorCode === 'ETIMEDOUT' || mutated.signal) fail(`[ASSERT:MUTATION-CHILD-INFRA] ${spec.mutation} timed out or was signalled`, mutated);
    if (!mutated.buildOk || !mutated.harnessStarted) fail(`[ASSERT:MUTATION-CHILD-HARNESS] ${spec.mutation} did not build and start`, mutated);
    if (mutated.status === 0) fail(`[ASSERT:MUTATION-SURVIVED] ${spec.mutation} exited zero`, mutated);
    if (!mutated.assertionIds.includes(spec.expectedAssertion)) {
      fail(`[ASSERT:MUTATION-WRONG-ASSERTION] ${spec.mutation} expected ${spec.expectedAssertion}, got ${mutated.assertionIds.join(',') || 'none'}`, mutated);
    }
    const copyDigestAfter = trackedDigest(copy.root);
    if (copyDigestAfter !== copy.digest) {
      fail(`[ASSERT:MUTATION-COPY-RESTORE] ${spec.mutation} changed tracked bytes ${copy.digest} -> ${copyDigestAfter}`, mutated);
    }
    rows.push({
      mutation: spec.mutation,
      baseline: 'PASS',
      build: 'PASS',
      harness: 'STARTED',
      exit: mutated.status,
      expectedAssertion: spec.expectedAssertion,
      observedAssertions: mutated.assertionIds,
      killed: true,
      trackedBytesRestored: true
    });
    console.log(`[MUTATION:KILLED] ${spec.mutation} [ASSERT:${spec.expectedAssertion}]`);
  } finally {
    rmSync(copy.outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const sourceDigestAfter = trackedDigest(sourceRoot);
if (sourceDigestAfter !== sourceDigestBefore) {
  throw new Error(`[ASSERT:MUTATION-SOURCE-UNCHANGED] source tracked bytes changed ${sourceDigestBefore} -> ${sourceDigestAfter}`);
}
const evidence = {
  sourceRoot,
  timeoutMs,
  sourceDigestBefore,
  sourceDigestAfter,
  baselineRuns: rows.length,
  killed: rows.length,
  rows
};
if (evidencePath) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
console.log(JSON.stringify(evidence, null, 2));
