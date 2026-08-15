import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import path, { dirname } from 'node:path';

export function canonicalPath(target) {
  const absolute = path.resolve(target);
  const missing = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalBase = existsSync(cursor) ? realpathSync.native(cursor) : cursor;
  return path.resolve(canonicalBase, ...missing);
}

export function isPathInside(repository, candidate, pathApi = path) {
  const normalize = (value) => {
    const text = String(value);
    return pathApi === path.win32 ? text.replaceAll('/', '\\') : text;
  };
  const root = pathApi.resolve(normalize(repository));
  const target = pathApi.resolve(normalize(candidate));
  const relative = pathApi.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

export function requireExternalPath(repository, candidate, assertionId) {
  const root = canonicalPath(repository);
  const target = canonicalPath(candidate);
  if (isPathInside(root, target)) {
    throw new Error(`[ASSERT:${assertionId}] evidence output must be outside the repository`);
  }
  return target;
}

function fileRecord(file) {
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  const bytes = readFileSync(file);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mode: stat.mode,
    atimeMs: stat.atimeMs,
    mtimeMs: stat.mtimeMs
  };
}

export function snapshotFiles(files) {
  return new Map(files.map((file) => [file, fileRecord(file)]));
}

export function restoreFiles(snapshot) {
  for (const [file, record] of snapshot) {
    if (!record) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, record.bytes);
    chmodSync(file, record.mode);
    utimesSync(file, record.atimeMs / 1000, record.mtimeMs / 1000);
  }
}

export function fileCensus(files) {
  return files.map((file) => {
    const record = fileRecord(file);
    return record ? { file, sha256: record.sha256, mtimeMs: record.mtimeMs, mode: record.mode } : { file, absent: true };
  });
}

export function sameFileCensus(left, right) {
  if (left.length !== right.length) return false;
  return left.every((before, index) => {
    const after = right[index];
    if (!after || before.file !== after.file || before.absent !== after.absent) return false;
    if (before.absent) return true;
    // Node's utimes API accepts millisecond-resolution Dates/numbers, while
    // stat may expose sub-millisecond filesystem precision. Restoration within
    // one millisecond is the strongest portable mtime invariant.
    return before.sha256 === after.sha256 && before.mode === after.mode && Math.abs(before.mtimeMs - after.mtimeMs) < 1;
  });
}

export function createDirectoryLink(target, link, platform = process.platform) {
  const absoluteTarget = path.resolve(target);
  if (platform === 'win32') {
    symlinkSync(absoluteTarget, link, 'junction');
    return { type: 'junction', target: absoluteTarget };
  }
  symlinkSync(absoluteTarget, link, 'dir');
  return { type: 'dir-symlink', target: absoluteTarget };
}

export function parseTerminalResults(output) {
  const results = [];
  for (const line of String(output).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === 'object' && ['pass', 'assertion', 'infra'].includes(value.kind)) results.push(value);
    } catch {
      if (/\bkind\b/.test(trimmed)) results.push({ kind: 'malformed-terminal' });
    }
  }
  return results;
}

export function validateProbeResult(output, expected) {
  const results = parseTerminalResults(output);
  if (results.length !== 1) return { ok: false, reason: `expected exactly one terminal result, got ${results.length}`, results };
  const [result] = results;
  const assertionIds = [...new Set([...String(output).matchAll(/\[ASSERT:([A-Z0-9-]+)\]/g)].map(match => match[1]))];
  if (expected.kind === 'pass') {
    return { ok: result.kind === 'pass' && Object.keys(result).length === 1 && assertionIds.length === 0, result, assertionIds, reason: 'baseline must be exactly {kind:"pass"} with no assertion IDs' };
  }
  const resultIds = Array.isArray(result.ids) ? result.ids : [];
  return {
    ok: result.kind === 'assertion'
      && Object.keys(result).length === 2
      && resultIds.length === 1
      && resultIds[0] === expected.id
      && assertionIds.length === resultIds.length
      && assertionIds.every((id, index) => id === resultIds[index]),
    result,
    assertionIds,
    reason: `mutation must contain only ${expected.id} and end exactly {kind:"assertion",ids:["${expected.id}"]}`
  };
}

const processGroupRoots = new WeakSet();

export function processTreePolicy(platform = process.platform) {
  return platform === 'win32'
    ? { detachedGroupRoot: false, termination: 'taskkill-tree' }
    : { detachedGroupRoot: true, termination: 'process-group' };
}

export function spawnTracked(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    detached: false
  });
}

export function spawnProcessGroup(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    detached: processTreePolicy().detachedGroupRoot
  });
  processGroupRoots.add(child);
  return child;
}

function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveWait();
    });
  });
}

function posixDescendantPids(rootPid) {
  const result = spawnSync('/bin/ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`/bin/ps failed while enumerating descendants: ${result.stderr || result.status}`);
  const children = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const siblings = children.get(ppid) || [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const descendants = [];
  const visit = (pid) => {
    for (const childPid of children.get(pid) || []) visit(childPid);
    if (pid !== rootPid) descendants.push(pid);
  };
  visit(rootPid);
  return descendants;
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
}

export async function terminateProcessTree(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolveTaskkill) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolveTaskkill);
      killer.once('exit', resolveTaskkill);
    });
  } else if (processGroupRoots.has(child)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    await waitForExit(child, Math.min(timeoutMs, 1000));
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  } else {
    // Standalone geometry runs are not process-group roots. Kill only the
    // explicitly owned descendant tree so the caller's process group is safe.
    const descendants = posixDescendantPids(child.pid);
    signalPids(descendants, 'SIGTERM');
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    child.kill('SIGTERM');
    await waitForExit(child, Math.min(timeoutMs, 1000));
    signalPids(descendants, 'SIGKILL');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await waitForExit(child, timeoutMs);
  if (child.exitCode === null && child.signalCode === null) throw new Error(`process tree ${child.pid} did not exit`);
}
