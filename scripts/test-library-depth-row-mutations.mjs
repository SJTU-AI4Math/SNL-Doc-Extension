#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalPath,
  createDirectoryLink,
  fileCensus,
  requireExternalPath,
  sameFileCensus,
  spawnProcessGroup,
  spawnTracked,
  terminateProcessTree,
  validateProbeResult
} from './library-depth-harness-utils.mjs';

const sourceRoot = canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const timeoutMs = Number(process.env.SNL_LIBRARY_MUTATION_TIMEOUT_MS || 180_000);
const evidencePath = process.env.SNL_LIBRARY_MUTATION_EVIDENCE_OUT
  ? requireExternalPath(sourceRoot, process.env.SNL_LIBRARY_MUTATION_EVIDENCE_OUT, 'MUTATION-EVIDENCE-OUTSIDE-REPO')
  : null;

const mutations = [
  { mutation: 'reservation-11.3', expectedAssertion: 'TOOLBAR-RESERVATION' },
  { mutation: 'reveal-5.1', expectedAssertion: 'TOOLBAR-RESERVATION' },
  { mutation: 'depth-wrap', expectedAssertion: 'ROW-HEIGHT-STABLE' },
  { mutation: 'title-8rem', expectedAssertion: 'DESKTOP-TITLE-BUDGET' },
  { mutation: 'medium-max-content', expectedAssertion: 'MEDIUM-KIND-SHRINK' },
  { mutation: 'suggestions-in-flow', expectedAssertion: 'ROW-SUGGESTIONS-OVERLAY' },
  { mutation: 'add-form-overflow', expectedAssertion: 'ADD-MENU-CONTAINER-BOUNDED' },
  { mutation: 'add-id-clipping', expectedAssertion: 'ADD-ID-VISUALLY-REACHABLE' },
  { mutation: 'add-menu-missing', expectedAssertion: 'ADD-MENU-EXISTS' },
  { mutation: 'blank-phase-missing', expectedAssertion: 'SHRINK-BLANK-PHASE' },
  { mutation: 'title-phase-missing', expectedAssertion: 'SHRINK-TITLE-PHASE' },
  { mutation: 'id-phase-missing', expectedAssertion: 'SHRINK-ID-PHASE' },
  { mutation: 'id-below-floor', expectedAssertion: 'SHRINK-ID-FLOOR' }
];

function git(args) {
  return new Promise((resolveGit, rejectGit) => {
    const child = spawnTracked('git', args, { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', rejectGit);
    child.once('exit', code => code === 0 ? resolveGit(stdout) : rejectGit(new Error(`git ${args.join(' ')} failed: ${stderr}`)));
  });
}

const trackedPaths = (await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
function trackedDigest(root) {
  const hash = createHash('sha256');
  for (const relativePath of trackedPaths) {
    const absolute = resolve(root, relativePath);
    if (!existsSync(absolute)) throw new Error(`[ASSERT:MUTATION-COPY-COMPLETE] missing path ${relativePath}`);
    hash.update(relativePath).update('\0').update(readFileSync(absolute)).update('\0');
  }
  return hash.digest('hex');
}

const nodeModules = resolve(sourceRoot, 'node_modules');
if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory()) {
  throw new Error('[ASSERT:MUTATION-DEPENDENCIES] source node_modules directory is unavailable');
}
const sourceArtifacts = ['createLibrary.js', 'createLibrary.css'].map(name => resolve(sourceRoot, 'media/webview', name));

function makeCopy() {
  const outer = mkdtempSync(resolve(tmpdir(), 'snl-library-depth-mutation-'));
  const root = resolve(outer, 'repo');
  mkdirSync(root);
  for (const relativePath of trackedPaths) {
    const source = resolve(sourceRoot, relativePath);
    const destination = resolve(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { preserveTimestamps: true });
  }
  const dependencyLink = createDirectoryLink(nodeModules, resolve(root, 'node_modules'));
  return {
    outer,
    root,
    digest: trackedDigest(root),
    artifacts: fileCensus(['createLibrary.js', 'createLibrary.css'].map(name => resolve(root, 'media/webview', name))),
    dependencyLink
  };
}

async function runProbe(root, { mutation = '', forceFailure = '' } = {}) {
  const probe = resolve(root, 'scripts/test-library-depth-row-geometry.mjs');
  const child = spawnProcessGroup(process.execPath, [probe], {
    cwd: root,
    env: {
      ...process.env,
      SNL_LIBRARY_GEOMETRY_MUTATION: mutation,
      SNL_LIBRARY_GEOMETRY_FORCE_FAILURE: forceFailure,
      SNL_LIBRARY_GEOMETRY_OUT: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolveExit) => {
    child.once('error', error => resolveExit({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolveExit({ code, signal, error: null }));
  });
  const timer = setTimeout(async () => {
    timedOut = true;
    try { await terminateProcessTree(child); } catch { /* reported by the exit/result checks */ }
  }, timeoutMs);
  const result = await exit;
  clearTimeout(timer);
  if (timedOut || result.signal || result.error) {
    try { await terminateProcessTree(child); } catch (error) { result.cleanupError = error; }
  }
  const output = `${stdout}${stderr}`;
  return {
    status: result.code,
    signal: result.signal,
    error: result.error,
    cleanupError: result.cleanupError,
    timedOut,
    output,
    buildOk: output.includes('[HARNESS:BUILD_OK]'),
    harnessStarted: output.includes('[HARNESS:STARTED]')
  };
}

function fail(message, run) {
  const excerpt = run?.output ? `\n--- child output ---\n${run.output.slice(-12_000)}` : '';
  throw new Error(`${message}${excerpt}`);
}

function assertCopyRestored(copy, run, assertion) {
  const digestAfter = trackedDigest(copy.root);
  if (digestAfter !== copy.digest) fail(`[ASSERT:${assertion}] changed copied source bytes ${copy.digest} -> ${digestAfter}`, run);
  const artifactsAfter = fileCensus(['createLibrary.js', 'createLibrary.css'].map(name => resolve(copy.root, 'media/webview', name)));
  if (!sameFileCensus(copy.artifacts, artifactsAfter)) fail(`[ASSERT:${assertion}] changed copied artifact census`, run);
}

async function withCopy(action) {
  const copy = makeCopy();
  let actionError;
  try {
    return await action(copy);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    try { rmSync(copy.outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (cleanupError) {
      const message = `[ASSERT:MUTATION-COPY-CLEANUP] ${cleanupError?.stack || cleanupError}`;
      if (actionError) actionError.message += `\n${message}`;
      else throw new Error(message);
    }
  }
}

let terminalResult;
try {
  const sourceDigestBefore = trackedDigest(sourceRoot);
  const sourceArtifactsBefore = fileCensus(sourceArtifacts);

  const baselineRow = await withCopy(async copy => {
    const baseline = await runProbe(copy.root);
    if (baseline.timedOut || baseline.signal || baseline.error || baseline.cleanupError) fail('[ASSERT:MUTATION-BASELINE-INFRA] baseline process/cleanup failed', baseline);
    if (baseline.status !== 0 || !baseline.buildOk || !baseline.harnessStarted) fail('[ASSERT:MUTATION-BASELINE-HARNESS] baseline did not build, start, and exit zero', baseline);
    const protocol = validateProbeResult(baseline.output, { kind: 'pass' });
    if (!protocol.ok) fail(`[ASSERT:MUTATION-BASELINE-RESULT] ${protocol.reason}`, baseline);
    assertCopyRestored(copy, baseline, 'MUTATION-BASELINE-RESTORE');
    return { baseline: 'PASS', dependencyLink: copy.dependencyLink.type };
  });

  await withCopy(async copy => {
    const forced = await runProbe(copy.root, { forceFailure: 'after-build' });
    if (forced.timedOut || forced.signal || forced.error || forced.cleanupError) fail('[ASSERT:MUTATION-RESTORE-FAILURE-INFRA] forced failure process/cleanup failed', forced);
    if (forced.status === 0 || !forced.buildOk) fail('[ASSERT:MUTATION-RESTORE-FAILURE-RAN] forced failure did not execute after build', forced);
    const results = forced.output.split(/\r?\n/).flatMap(line => { try { const parsed = JSON.parse(line); return parsed?.kind ? [parsed] : []; } catch { return []; } });
    if (results.length !== 1 || results[0].kind !== 'infra' || results[0].id !== 'HARNESS') fail('[ASSERT:MUTATION-RESTORE-FAILURE-RESULT] forced failure emitted an invalid terminal result', forced);
    assertCopyRestored(copy, forced, 'MUTATION-RESTORE-ON-FAILURE');
  });

  const rows = [];
  for (const spec of mutations) {
    await withCopy(async copy => {
      const mutated = await runProbe(copy.root, { mutation: spec.mutation });
      if (mutated.timedOut || mutated.signal || mutated.error || mutated.cleanupError) fail(`[ASSERT:MUTATION-CHILD-INFRA] ${spec.mutation} process/cleanup failed`, mutated);
      if (!mutated.buildOk || !mutated.harnessStarted || mutated.status === 0) fail(`[ASSERT:MUTATION-CHILD-HARNESS] ${spec.mutation} did not build/start/fail`, mutated);
      const protocol = validateProbeResult(mutated.output, { kind: 'assertion', id: spec.expectedAssertion });
      if (!protocol.ok) fail(`[ASSERT:MUTATION-TERMINAL-RESULT] ${spec.mutation}: ${protocol.reason}`, mutated);
      assertCopyRestored(copy, mutated, 'MUTATION-COPY-RESTORE');
      rows.push({ mutation: spec.mutation, expectedAssertion: spec.expectedAssertion, terminalResult: protocol.result, dependencyLink: copy.dependencyLink.type, killed: true, artifactsRestored: true });
      console.log(`[MUTATION:KILLED] ${spec.mutation} [ASSERT:${spec.expectedAssertion}]`);
    });
  }

  const sourceDigestAfter = trackedDigest(sourceRoot);
  const sourceArtifactsAfter = fileCensus(sourceArtifacts);
  if (sourceDigestAfter !== sourceDigestBefore) throw new Error(`[ASSERT:MUTATION-SOURCE-UNCHANGED] source bytes changed ${sourceDigestBefore} -> ${sourceDigestAfter}`);
  if (!sameFileCensus(sourceArtifactsBefore, sourceArtifactsAfter)) throw new Error('[ASSERT:MUTATION-SOURCE-ARTIFACTS] source artifact census changed');

  const evidence = { sourceRoot, timeoutMs, sourceDigestBefore, sourceDigestAfter, baseline: baselineRow, baselineRuns: 1, forcedFailureRestoration: 'PASS', killed: rows.length, rows };
  if (evidencePath) {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  console.log(JSON.stringify(evidence, null, 2));
  terminalResult = { kind: 'pass' };
} catch (error) {
  terminalResult = { kind: 'infra', id: 'MUTATION-HARNESS', message: error?.stack || String(error) };
}
console.log(JSON.stringify(terminalResult));
process.exitCode = terminalResult.kind === 'pass' ? 0 : 1;
