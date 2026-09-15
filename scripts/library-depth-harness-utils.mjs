import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import path, { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
  const assertionIds = [...String(output).matchAll(/\[ASSERT:([A-Z0-9-]+)\]/g)].map(match => match[1]);
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

const processOwnership = new WeakMap();
const linuxIncompleteContexts = new WeakSet();
const verifiedCleanRegistries = new Set();
const ownedRegistryContexts = new Map();
const REGISTRY_PATH_ENV = 'SNL_PROCESS_OWNER_REGISTRY';
const OWNER_TOKEN_ENV = 'SNL_PROCESS_OWNER_TOKEN';
const OWNER_ID_ENV = 'SNL_PROCESS_OWNER_ID';

export function processTreePolicy(platform = process.platform) {
  if (platform === 'win32') return { detachedGroupRoot: false, termination: 'job-object' };
  if (platform === 'darwin') return { detachedGroupRoot: true, termination: 'token-validated-process-group' };
  return { detachedGroupRoot: true, termination: 'process-group' };
}

export function windowsTaskkillCommand(pid, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return {
    command: path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
    args: ['/PID', String(pid), '/T', '/F']
  };
}

function parseWindowsCommandLine(commandLine) {
  const input = String(commandLine);
  const arguments_ = [];
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && (input[cursor] === ' ' || input[cursor] === '\t')) cursor += 1;
    if (cursor === input.length) break;

    let argument = '';
    let quoted = false;
    while (cursor < input.length) {
      if (!quoted && (input[cursor] === ' ' || input[cursor] === '\t')) break;

      let backslashes = 0;
      while (input[cursor] === '\\') {
        backslashes += 1;
        cursor += 1;
      }
      if (input[cursor] === '"') {
        argument += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          argument += '"';
          cursor += 1;
        } else if (quoted && input[cursor + 1] === '"') {
          argument += '"';
          cursor += 2;
        } else {
          quoted = !quoted;
          cursor += 1;
        }
      } else {
        argument += '\\'.repeat(backslashes);
        if (cursor < input.length) {
          argument += input[cursor];
          cursor += 1;
        }
      }
    }
    // CommandLineToArgvW accepts an unterminated quote, but ownership checks
    // must reject ambiguous or truncated CIM command lines rather than guess.
    if (quoted) return null;
    arguments_.push(argument);
  }
  return arguments_;
}

export function windowsCommandLineHasExactArgument(commandLine, expectedArgument) {
  const parsed = parseWindowsCommandLine(commandLine);
  return parsed !== null && parsed.includes(String(expectedArgument));
}

export function windowsJobLauncherCommand(command, args, context, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  if (!Number.isInteger(context?.parentPid) || context.parentPid <= 0 || !/^[0-9a-f]{64}$/.test(context?.token || '') || !/^[0-9a-f]{24}$/.test(context?.ownerId || '')) {
    throw new Error('invalid Windows Job launcher ownership metadata');
  }
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('./windows-job-launcher.ps1', import.meta.url));
  const payload = Buffer.from(JSON.stringify({ executable: String(command), arguments: args.map(String) }), 'utf8').toString('base64');
  return {
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, String(context.parentPid), context.token, context.ownerId, payload]
  };
}

function ownerId(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

function registryFileIdentity(registryPath) {
  const canonicalPath = realpathSync.native(registryPath);
  const stat = statSync(canonicalPath, { bigint: true });
  if (!stat.isFile()) throw new Error('process ownership registry is not a regular file');
  const key = `${process.platform}\0${stat.dev.toString()}\0${stat.ino.toString()}`;
  return Object.freeze({ key, canonicalPath, platform: process.platform, dev: stat.dev.toString(), ino: stat.ino.toString() });
}

function requireCurrentRegistryIdentity(context) {
  const current = registryFileIdentity(context.registryPath);
  if (current.key !== context.registryIdentity.key) {
    throw new Error('process ownership registry file identity changed');
  }
  return current;
}

function bindRegistryIdentity(context, registryIdentity) {
  Object.defineProperty(context, 'registryIdentity', { value: registryIdentity, enumerable: false, writable: false, configurable: false });
  return context;
}

function ownedRegistryKey(registryIdentity, token, id) {
  return `${registryIdentity.key}\0${token}\0${id}`;
}

export function createOwnedProcessRegistry() {
  const directory = mkdtempSync(path.resolve(tmpdir(), 'snl-process-owner-'));
  chmodSync(directory, 0o700);
  const registryPath = path.resolve(directory, 'processes.jsonl');
  writeFileSync(registryPath, '', { mode: 0o600, flag: 'wx' });
  const token = randomBytes(32).toString('hex');
  const id = ownerId(token);
  const registryIdentity = registryFileIdentity(registryPath);
  const context = bindRegistryIdentity({
    registryPath, directory, token, id, owned: true,
    env: { ...process.env, [REGISTRY_PATH_ENV]: registryPath, [OWNER_TOKEN_ENV]: token, [OWNER_ID_ENV]: id }
  }, registryIdentity);
  ownedRegistryContexts.set(ownedRegistryKey(registryIdentity, token, id), context);
  return context;
}

export function ownedProcessRegistryFromEnvironment(env = process.env) {
  const registryPath = env[REGISTRY_PATH_ENV], token = env[OWNER_TOKEN_ENV], id = env[OWNER_ID_ENV];
  if (!registryPath && !token && !id) return null;
  if (!registryPath || !token || !id || ownerId(token) !== id) throw new Error('invalid inherited process ownership registry environment');
  const registryIdentity = registryFileIdentity(registryPath);
  const key = ownedRegistryKey(registryIdentity, token, id);
  const existing = ownedRegistryContexts.get(key);
  if (existing) return existing;
  const context = bindRegistryIdentity({ registryPath, directory: dirname(registryPath), token, id, owned: false, env: { ...env } }, registryIdentity);
  ownedRegistryContexts.set(key, context);
  return context;
}

export function ensureOwnedProcessRegistry() {
  const inherited = ownedProcessRegistryFromEnvironment();
  if (inherited) return inherited;
  const created = createOwnedProcessRegistry();
  Object.assign(process.env, {
    [REGISTRY_PATH_ENV]: created.registryPath,
    [OWNER_TOKEN_ENV]: created.token,
    [OWNER_ID_ENV]: created.id
  });
  return created;
}

function linuxBirthIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  if (close < 0) throw new Error(`invalid /proc/${pid}/stat`);
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  return { startTicks: fields[19], executable: realpathSync.native(`/proc/${pid}/exe`) };
}

function portableBirthIdentity(pid, platform = process.platform) {
  if (platform === 'linux') return linuxBirthIdentity(pid);
  if (platform === 'darwin') {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout.trim()) throw new Error(`cannot read macOS birth identity for ${pid}`);
    return { ps: result.stdout.trim() };
  }
  if (platform === 'win32') {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object CreationDate,ExecutablePath | ConvertTo-Json -Compress`;
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !result.stdout.trim()) throw new Error(`cannot read Windows birth identity for ${pid}`);
    return { cim: JSON.parse(result.stdout.trim()) };
  }
  throw new Error(`unsupported ownership identity platform ${platform}`);
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendOwnershipRecord(context, child, detached, command, metadata = {}) {
  if (!context || !Number.isInteger(child.pid)) throw new Error('owned process did not produce a PID');
  // A prior zero-owned observation becomes stale as soon as a new record is
  // attempted. Invalidate before any fallible identity lookup or durable append
  // so append failures remain dirty and registry deletion continues to fail closed.
  verifiedCleanRegistries.delete(context.registryIdentity.key);
  requireCurrentRegistryIdentity(context);
  const record = {
    pid: child.pid,
    groupRoot: detached && process.platform !== 'win32' ? child.pid : null,
    platform: process.platform,
    ownerId: context.id,
    birth: portableBirthIdentity(child.pid),
    executable: String(command),
    ...metadata,
    createdAt: Date.now()
  };
  if (process.platform === 'linux') {
    const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(/\) (?=[A-Za-z] )/).at(-1).trim().split(/\s+/);
    record.linuxSession = { pgid: Number(fields[2]), sid: Number(fields[3]) };
    processOwnership.set(child, { context, record });
  }
  appendFileSync(context.registryPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  processOwnership.set(child, { context, record });
}

function spawnOwned(command, args, options, defaultDetached) {
  const context = ownedProcessRegistryFromEnvironment(options.env || process.env) || ensureOwnedProcessRegistry();
  const { ownedDetached, ...spawnOptions } = options;
  const detached = ownedDetached ?? defaultDetached;
  const env = { ...(spawnOptions.env || process.env), [REGISTRY_PATH_ENV]: context.registryPath, [OWNER_TOKEN_ENV]: context.token, [OWNER_ID_ENV]: context.id };
  const launch = process.platform === 'win32'
    ? windowsJobLauncherCommand(command, args, { parentPid: process.pid, token: context.token, ownerId: context.id })
    : { command, args };
  const child = spawn(launch.command, launch.args, { ...spawnOptions, env, detached });
  try {
    appendOwnershipRecord(context, child, detached, launch.command, process.platform === 'win32' ? { jobLauncher: true, targetExecutable: String(command) } : {});
  }
  catch (error) {
    if (process.platform === 'linux') {
      const ownership = processOwnership.get(child);
      try {
        if (!ownership) throw new Error('no birth-bound ownership record');
        linuxPidfdRecord(ownership.record, context, false, 1000);
      } catch (cleanupError) {
        linuxIncompleteContexts.add(context);
        throw new Error(`${error.message}; cleanupIncomplete: ${cleanupError.message}`, { cause: error });
      }
    } else {
      try { child.kill('SIGKILL'); } catch { /* unchanged non-Linux best effort */ }
    }
    throw error;
  }
  return child;
}

export function spawnTracked(command, args, options = {}) {
  return spawnOwned(command, args, options, processTreePolicy().detachedGroupRoot);
}

export function spawnProcessGroup(command, args, options = {}) {
  return spawnOwned(command, args, options, processTreePolicy().detachedGroupRoot);
}

function readOwnershipRecords(context) {
  requireCurrentRegistryIdentity(context);
  const text = readFileSync(context.registryPath, 'utf8');
  requireCurrentRegistryIdentity(context);
  const records = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line && index === text.split('\n').length - 1) continue;
    if (!line.trim()) throw new Error(`malformed empty ownership registry record at line ${index + 1}`);
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`malformed ownership registry record at line ${index + 1}`); }
    if (!Number.isInteger(record.pid) || record.pid <= 0 || record.ownerId !== context.id || record.platform !== process.platform || !record.birth
      || (process.platform === 'win32' && (record.groupRoot !== null || record.jobLauncher !== true || typeof record.targetExecutable !== 'string' || !record.targetExecutable))) {
      throw new Error(`invalid ownership registry record at line ${index + 1}`);
    }
    records.push(record);
  }
  return records;
}

function posixProcessTable() {
  const result = spawnSync('/bin/ps', ['-eo', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`/bin/ps failed while enumerating descendants: ${result.stderr || result.status}`);
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pidText, ppidText, pgidText, state = '', command = ''] = line.trim().split(/\s+/);
    const pid = Number(pidText), ppid = Number(ppidText), pgid = Number(pgidText);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) rows.push({ pid, ppid, pgid, state, command });
  }
  return rows;
}

function linuxOwnerTokenState(pid, token) {
  try {
    const environment = readFileSync(`/proc/${pid}/environ`).toString().split('\0');
    const marker = environment.find(entry => entry.startsWith(`${OWNER_TOKEN_ENV}=`));
    if (marker === `${OWNER_TOKEN_ENV}=${token}`) return 'owned';
    return marker ? 'mismatched' : 'scrubbed';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'exited';
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'inaccessible';
    throw error;
  }
}

function startTicksAtLeast(candidate, root) {
  try { return BigInt(candidate) >= BigInt(root); }
  catch { throw new Error('invalid Linux process birth start ticks'); }
}

/**
 * Classify a single, immutable Linux process snapshot for one registered root.
 * Token-less/inaccessible members are delegated ownership only through exact
 * PPID ancestry from a birth-verified root (or an independently owned marker
 * after that root exits). Same-PGID membership alone never grants ownership.
 */
export function classifyLinuxAncestrySnapshot(record, rows) {
  const liveRows = rows.filter(row => !row.state?.startsWith('Z'));
  const byPid = new Map(liveRows.map(row => [row.pid, row]));
  const registeredRoot = byPid.get(record.pid);
  const rootStart = record.birth?.startTicks;
  const groupRows = record.groupRoot ? liveRows.filter(row => row.pgid === record.groupRoot) : liveRows;
  let seeds;
  let expectedPgid;
  let expectedSid;

  if (registeredRoot) {
    if (!sameIdentity(registeredRoot.birth, record.birth)) throw new Error(`owned PID ${record.pid} birth identity changed`);
    if (registeredRoot.tokenState !== 'owned') throw new Error(`registered root ${record.pid} has unverifiable or mismatched owner token`);
    seeds = [registeredRoot];
    expectedPgid = registeredRoot.pgid;
    expectedSid = registeredRoot.sid;
  } else {
    seeds = groupRows.filter(row => row.tokenState === 'owned' && startTicksAtLeast(row.birth?.startTicks, rootStart));
    if (!seeds.length) {
      const blocked = groupRows.filter(row => ['scrubbed', 'inaccessible', 'mismatched'].includes(row.tokenState));
      if (blocked.length) throw new Error(`registered root ${record.pid} exited with unverifiable same-group members: ${blocked.map(row => row.pid).join(',')}`);
      return [];
    }
    expectedPgid = record.groupRoot || seeds[0].pgid;
    expectedSid = seeds[0].sid;
    if (seeds.some(row => row.pgid !== expectedPgid || row.sid !== expectedSid)) {
      throw new Error(`independently owned markers for exited root ${record.pid} disagree on group or session`);
    }
  }

  const accepted = new Set(seeds.map(row => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of liveRows) {
      if (!accepted.has(row.pid) && accepted.has(row.ppid)) {
        accepted.add(row.pid);
        changed = true;
      }
    }
  }

  for (const pid of accepted) {
    const row = byPid.get(pid);
    if (!startTicksAtLeast(row.birth?.startTicks, rootStart)) throw new Error(`descendant ${pid} predates registered root ${record.pid}`);
    if (row.pgid !== expectedPgid || row.sid !== expectedSid) throw new Error(`descendant ${pid} changed expected group or session for registered root ${record.pid}`);
    if (row.tokenState === 'mismatched') throw new Error(`descendant ${pid} has a readable mismatched owner token`);
    if (!['owned', 'scrubbed', 'inaccessible'].includes(row.tokenState)) throw new Error(`descendant ${pid} has unknown owner-token state`);
  }

  if (record.groupRoot) {
    const unrelated = groupRows.filter(row => !accepted.has(row.pid));
    if (unrelated.length) throw new Error(`owned process group ${record.groupRoot} contains unrelated PIDs outside verified ancestry: ${unrelated.map(row => row.pid).join(',')}`);
  }
  return [...accepted].sort((left, right) => left - right);
}

export function parseMacProcessTable(text, token) {
  const exactToken = new RegExp(`(?:^|\\s)${OWNER_TOKEN_ENV}=${token}(?=\\s|$)`);
  return String(text).split(/\r?\n/).filter(Boolean).map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error(`unverifiable macOS process row ${index + 1}`);
    const [pidText, pgidText, state, executable, command] = fields;
    const pid = Number(pidText), pgid = Number(pgidText);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(pgid) || pgid <= 0 || !state || !path.isAbsolute(executable) || !command) {
      throw new Error(`unverifiable macOS process identity at row ${index + 1}`);
    }
    return { pid, pgid, state, executable, command, zombie: state.startsWith('Z'), tokenState: exactToken.test(command) ? 'owned' : 'foreign' };
  });
}

function macProcessDetails(rows, token) {
  const encoded = [];
  for (const row of rows) {
    const identity = spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'comm='], { encoding: 'utf8' });
    const environment = spawnSync('/bin/ps', ['eww', '-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (identity.status !== 0 || environment.status !== 0 || !identity.stdout.trim() || !environment.stdout.trim()) {
      try { process.kill(row.pid, 0); } catch (error) { if (error?.code === 'ESRCH') continue; }
      throw new Error(`cannot verify macOS token and executable identity for live PID ${row.pid}`);
    }
    encoded.push([row.pid, row.pgid, row.state, identity.stdout.trim(), environment.stdout.trim()].join('\t'));
  }
  return parseMacProcessTable(encoded.join('\n'), token);
}

function macLiveRecordTargets(record, context) {
  const candidates = posixProcessTable().filter(row => !row.state.startsWith('Z') && (record.groupRoot ? row.pgid === record.groupRoot : row.pid === record.pid));
  const observed = macProcessDetails(candidates, context.token).filter(row => !row.zombie);
  const foreign = observed.filter(row => row.tokenState !== 'owned');
  if (foreign.length) throw new Error(`macOS owned process group ${record.groupRoot || record.pid} contains unverifiable or foreign members: ${foreign.map(row => `${row.pid}:${row.executable}`).join(',')}`);
  if (observed.some(row => row.pid === record.pid)) {
    const birth = portableBirthIdentity(record.pid, 'darwin');
    if (!sameIdentity(birth, record.birth)) throw new Error(`owned macOS PID ${record.pid} birth identity changed`);
  }
  return observed.map(row => row.pid);
}

function windowsOwnedLaunchers(context) {
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const helper = fileURLToPath(new URL('./windows-job-launcher.ps1', import.meta.url));
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cannot verify Windows owned Job launchers with CIM: ${result.stderr || result.status}`);
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const sameWindowsPath = (left, right) => path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  const owned = [];
  for (const row of rows) {
    const pid = Number(row.ProcessId), command = String(row.CommandLine || ''), executable = String(row.ExecutablePath || '');
    if (!Number.isInteger(pid) || pid <= 0 || !executable || !command || !sameWindowsPath(executable, powershell)) continue;
    const argv = parseWindowsCommandLine(command);
    if (!argv || argv.length !== 10 || !sameWindowsPath(argv[0], powershell)) continue;
    if (!['-nologo', '-noprofile', '-noninteractive', '-file'].every((argument, index) => argv[index + 1].toLowerCase() === argument)) continue;
    if (!sameWindowsPath(argv[5], helper) || !/^[1-9][0-9]*$/.test(argv[6])) continue;
    if (argv[7] !== context.token || argv[8] !== context.id || !/^[A-Za-z0-9+/]+={0,2}$/.test(argv[9])) continue;
    owned.push({ pid, executable, command });
  }
  return owned;
}

function liveRecordTargets(record, context) {
  if (process.platform === 'darwin') return macLiveRecordTargets(record, context);
  if (process.platform === 'win32') return windowsOwnedLaunchers(context).filter(row => row.pid === record.pid).map(row => row.pid);
  if (process.platform !== 'linux') {
    let birth;
    try { birth = portableBirthIdentity(record.pid); }
    catch (error) {
      try { process.kill(record.pid, 0); } catch (probeError) { if (probeError?.code === 'ESRCH') {
        if (record.groupRoot && process.platform !== 'win32') {
          const groupMembers = posixProcessTable().filter(row => row.pgid === record.groupRoot && !row.state.startsWith('Z'));
          if (groupMembers.length) throw new Error(`cannot verify live detached group ${record.groupRoot} after its recorded root exited`);
        }
        return [];
      } }
      throw new Error(`cannot verify birth identity for live owned PID ${record.pid}: ${error?.message || error}`);
    }
    if (!sameIdentity(birth, record.birth)) return [];
    if (record.groupRoot && process.platform !== 'win32') {
      return posixProcessTable().filter(row => row.pgid === record.groupRoot && !row.state.startsWith('Z')).map(row => row.pid);
    }
    return [record.pid];
  }
  return linuxPidfdRecord(record, context, true).targets;

}

function linuxPidfdRecord(record, context, verify = false, timeoutMs = 5000) {
  const helper = fileURLToPath(new URL('./library_depth_linux_pidfd.py', import.meta.url));
  // Python retains every acquired pidfd through validation, freeze, KILL and poll.
  // No timeout-driven numeric PID/PGID fallback; a failed helper taints verification.
  const result = spawnSync('python3', [helper], {
    input: JSON.stringify({ record, token: context.token, verify, timeout: Math.min(timeoutMs, 3000) / 1000 }),
    encoding: 'utf8', maxBuffer: 1024 * 1024
  });
  let receipt;
  try { receipt = JSON.parse(result.stdout || ''); } catch { /* fail closed below */ }
  if (result.error || result.status !== 0 || receipt?.ok !== true) {
    verifiedCleanRegistries.delete(context.registryIdentity.key);
    if (!verify) linuxIncompleteContexts.add(context);
    throw new Error(`cleanupIncomplete: ${receipt?.message || result.error?.message || result.stderr || 'invalid Linux pidfd receipt'}`);
  }
  return receipt;
}

function signalRecord(record, signal) {
  if (process.platform === 'linux') throw new Error('Linux requires retained pidfd signaling');
  const target = record.groupRoot ? -record.groupRoot : record.pid;
  try { process.kill(target, signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

async function waitForRecordExit(record, context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let live = liveRecordTargets(record, context);
  while (live.length && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    live = liveRecordTargets(record, context);
  }
  return live;
}

export async function cleanupOwnedProcessRegistry(context, timeoutMs = 5000) {
  const records = readOwnershipRecords(context);
  if (process.platform === 'linux') {
    for (const record of [...records].reverse()) {
      if (record.pid === process.pid) continue;
      linuxPidfdRecord(record, context, false, timeoutMs);
    }
  } else if (process.platform === 'win32') {
    for (const record of [...records].reverse()) {
      if (record.pid === process.pid) continue;
      if (!liveRecordTargets(record, context).length) continue;
      const invocation = windowsTaskkillCommand(record.pid);
      await new Promise((resolveTaskkill, rejectTaskkill) => {
        const killer = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: 'ignore' });
        killer.once('error', rejectTaskkill);
        killer.once('exit', code => code === 0 ? resolveTaskkill() : rejectTaskkill(new Error(`taskkill failed for owned PID ${record.pid}: ${code}`)));
      });
    }
  } else {
    for (const record of [...records].reverse()) {
      if (record.pid === process.pid) continue;
      if (!liveRecordTargets(record, context).length) continue;
      signalRecord(record, 'SIGTERM');
      const liveAfterTerm = await waitForRecordExit(record, context, Math.min(timeoutMs, 1000));
      if (liveAfterTerm.length) signalRecord(record, 'SIGKILL');
      const liveAfterKill = await waitForRecordExit(record, context, Math.min(timeoutMs, 1000));
      if (liveAfterKill.length) throw new Error(`owned process target did not exit: ${record.pid} (${liveAfterKill.join(',')})`);
    }
  }
}

export async function verifyOwnedProcessRegistryClean(context) {
  if (process.platform === 'linux' && linuxIncompleteContexts.has(context)) throw new Error('cleanupIncomplete: previous Linux ownership failure');
  const live = [];
  for (const record of readOwnershipRecords(context)) {
    if (record.pid === process.pid) continue;
    const targets = liveRecordTargets(record, context);
    if (targets.length) live.push({ pid: record.pid, targets });
  }
  if (live.length) throw new Error(`owned process registry is not clean: ${JSON.stringify(live)}`);
  const current = requireCurrentRegistryIdentity(context);
  verifiedCleanRegistries.add(current.key);
}

export function destroyOwnedProcessRegistry(context) {
  if (!context?.owned) return;
  const current = requireCurrentRegistryIdentity(context);
  if (!verifiedCleanRegistries.has(current.key)) throw new Error('refusing to remove an ownership registry before zero-owned verification');
  rmSync(context.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  verifiedCleanRegistries.delete(current.key);
  ownedRegistryContexts.delete(ownedRegistryKey(context.registryIdentity, context.token, context.id));
}

export async function terminateProcessTree(child, timeoutMs = 5000) {
  if (!child) return;
  const ownership = processOwnership.get(child);
  if (!ownership) throw new Error(`process ${child.pid} has no ownership registry record`);
  await cleanupOwnedProcessRegistry(ownership.context, timeoutMs);
  await verifyOwnedProcessRegistryClean(ownership.context);
}
