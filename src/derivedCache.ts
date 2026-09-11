import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

/** Internal, trusted calculators only. This API is not a user-script sandbox. */
export type CacheRoot = string | { readonly uri: string };
export interface CacheScope { library: string }
export interface CacheDescriptor<T> {
  id: string;
  version: string;
  input: unknown;
  scope?: CacheScope;
  validate(value: unknown): value is T;
}
export interface CacheRequest<T> extends CacheDescriptor<T> {
  generate(): T | Promise<T>;
  signal?: AbortSignal;
}
export type CacheStatus = 'missing' | 'generating' | 'ready' | 'failed';
const MAX_BYTES = 64 * 1024 * 1024;
// Non-file roots retain only bounded, detached envelopes; never touch node:fs.
const MEMORY_ENTRIES = 128;
const memory = new Map<string, { text: string; bytes: number }>();
const memoryFailures = new Map<string, CacheStatus>();
let memoryBytes = 0;
let memoryEpoch = 0;
function removeMemory(key: string): void {
  const old = memory.get(key);
  if (old) { memoryBytes -= old.bytes; memory.delete(key); }
}
function storeMemory(key: string, text: string): void {
  removeMemory(key);
  const bytes = Buffer.byteLength(text) + Buffer.byteLength(key);
  if (bytes > MAX_BYTES) throw new Error('Cache output exceeds size limit');
  while (memory.size >= MEMORY_ENTRIES || memoryBytes + bytes > MAX_BYTES) removeMemory(memory.keys().next().value!);
  memory.set(key, { text, bytes }); memoryBytes += bytes;
}
function nextEpoch(root: CacheRoot, key: string): number {
  const epoch = typeof root === 'string' ? (epochs.get(key) ?? 0) + 1 : ++memoryEpoch;
  epochs.set(key, epoch); return epoch;
}
function releaseMemoryState(root: CacheRoot, key: string): void {
  if (typeof root === 'string' || publications.has(key)) return;
  for (const pendingKey of pending.keys()) if (pendingKey.startsWith(key + '\0')) return;
  // Epochs are globally unique for memory, so retired late jobs cannot ABA.
  if (statuses.get(key) === 'failed') {
    memoryFailures.delete(key); memoryFailures.set(key, 'failed');
    while (memoryFailures.size > MEMORY_ENTRIES) memoryFailures.delete(memoryFailures.keys().next().value!);
  } else if (statuses.has(key)) memoryFailures.delete(key);
  epochs.delete(key); statuses.delete(key);
}
const epochs = new Map<string, number>();
interface CacheJob<T> { promise: Promise<T>; epoch: number; subscribers: number; settled: boolean }
const pending = new Map<string, CacheJob<unknown>>();
const publications = new Map<string, Promise<unknown>>();
const statuses = new Map<string, CacheStatus>();
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const abortError = () => Object.assign(new Error('Cache request cancelled or cleared'), { name: 'AbortError' });

/** JSON semantics with canonical own-key ordering; never locale-sensitive. */
export function cacheFingerprint(value: unknown): string {
  const ancestors = new Set<object>();
  const canonical = (v: unknown): unknown => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v === undefined) return null;
    if (typeof v !== 'object') throw new Error('Cache inputs must be JSON data');
    if (ancestors.has(v)) throw new Error('Cyclic cache input');
    ancestors.add(v);
    let out: unknown;
    if (Array.isArray(v)) out = v.map(canonical);
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Cache inputs must be plain JSON objects');
      const values: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(v).sort()) {
        const val = (v as Record<string, unknown>)[key];
        if (val !== undefined) values[key] = canonical(val);
      }
      out = values;
    }
    ancestors.delete(v);
    return out;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function segment(value: string): void {
  if (!value || value !== value.trim() || value.startsWith('.') || /[\\/:\0]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('Invalid cache path segment');
  }
}
export function cachePath(root: string, id: string, scope?: CacheScope): string {
  segment(id);
  if (scope) segment(scope.library);
  const base = scope ? path.join(root, '.SNL_Doc', 'libraries', scope.library) : path.join(root, '.SNL_Doc');
  return path.resolve(base, '.cache', id, 'result.json');
}

function cacheKey(root: CacheRoot, id: string, scope?: CacheScope): string {
  if (typeof root === 'string') return cachePath(root, id, scope);
  segment(id); if (scope) segment(scope.library);
  if (!root.uri) throw new Error('Missing cache URI identity');
  // Leading NUL cannot collide with a native absolute file path.
  return '\0uri:' + JSON.stringify([root.uri, scope?.library ?? null, id]);
}

async function checkDirectory(directory: string, create: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe cache directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
    try { await fs.mkdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await checkDirectory(directory, false);
  }
}
async function guard(root: string, id: string, scope: CacheScope | undefined, create: boolean): Promise<string> {
  const file = cachePath(root, id, scope);
  let current = path.resolve(root, '.SNL_Doc');
  await checkDirectory(current, false);
  if (scope) {
    current = path.join(current, 'libraries'); await checkDirectory(current, false);
    current = path.join(current, scope.library); await checkDirectory(current, false);
  }
  current = path.join(current, '.cache'); await checkDirectory(current, create);
  if (create) {
    // This file is itself disposable cache metadata; never edit the user's root gitignore.
    const ignore = path.join(current, '.gitignore');
    try { await fs.writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.lstat(ignore);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe cache ignore file');
    }
  }
  await checkDirectory(path.join(current, id), create);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe cache file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return file;
}

/** Structural read only. Call readCache with actual inputs to establish freshness. */
export async function readCacheArtifact<T>(root: CacheRoot, descriptor: Omit<CacheDescriptor<T>, 'input'>): Promise<{ inputHash: string; value: T } | undefined> {
  try {
    // A reader must not consume a publication that an earlier clear will revoke.
    root = typeof root === 'string' ? root : { uri: root.uri };
    const key = cacheKey(root, descriptor.id, descriptor.scope);
    await publications.get(key)?.catch(() => undefined);
    let text: string;
    if (typeof root !== 'string') {
      const cached = memory.get(key);
      if (!cached) return undefined;
      memory.delete(key); memory.set(key, cached); // LRU hit
      text = cached.text;
    } else {
      const file = await guard(root, descriptor.id, descriptor.scope, false);
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
        text = await handle.readFile('utf8');
      } finally { await handle.close(); }
    }
    const envelope: unknown = JSON.parse(text);
    if (!object(envelope) || envelope.format !== 'snl-derived-cache' || envelope.schema !== 1 ||
      envelope.generator !== descriptor.id || envelope.version !== descriptor.version ||
      envelope.library !== (descriptor.scope?.library ?? null) ||
      typeof envelope.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.inputHash) ||
      !descriptor.validate(envelope.value) || envelope.valueHash !== cacheFingerprint(envelope.value)) return undefined;
    return { inputHash: envelope.inputHash, value: envelope.value };
  } catch { return undefined; }
}
export async function readCache<T>(root: CacheRoot, descriptor: CacheDescriptor<T>): Promise<T | undefined> {
  const artifact = await readCacheArtifact(root, descriptor);
  return artifact?.inputHash === cacheFingerprint(descriptor.input) ? artifact.value : undefined;
}

function serial<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = publications.get(file) ?? Promise.resolve();
  const job = predecessor.catch(() => undefined).then(operation);
  publications.set(file, job);
  void job.finally(() => { if (publications.get(file) === job) publications.delete(file); }).catch(() => undefined);
  return job;
}
async function publish<T>(root: CacheRoot, descriptor: CacheDescriptor<T>, value: T, epoch: number): Promise<void> {
  const file = cacheKey(root, descriptor.id, descriptor.scope);
  if (!descriptor.validate(value)) throw new Error('Invalid generated cache value');
  const text = JSON.stringify({ format: 'snl-derived-cache', schema: 1, generator: descriptor.id,
    version: descriptor.version, library: descriptor.scope?.library ?? null,
    inputHash: cacheFingerprint(descriptor.input), valueHash: cacheFingerprint(value), value });
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Cache output exceeds size limit');
  await serial(file, async () => {
    if (epochs.get(file) !== epoch) throw abortError();
    if (typeof root !== 'string') {
      storeMemory(file, text); statuses.set(file, 'ready'); return;
    }
    await guard(root, descriptor.id, descriptor.scope, true);
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text + '\n'); await handle.sync(); } finally { await handle.close(); }
      await guard(root, descriptor.id, descriptor.scope, false);
      if (epochs.get(file) !== epoch) throw abortError();
      await fs.rename(temporary, file);
      if (epochs.get(file) !== epoch) {
        // Publication and clear are serialized: no newer local publisher can
        // have written this file before this operation releases the queue.
        await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        throw abortError();
      }
      statuses.set(file, 'ready');
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
}
/** Trusted producer publication; consumer wire data must be bound/validated first. */
export async function writeCache<T>(root: CacheRoot, descriptor: CacheDescriptor<T>, value: T): Promise<void> {
  root = typeof root === 'string' ? root : { uri: root.uri };
  const file = cacheKey(root, descriptor.id, descriptor.scope);
  const epoch = nextEpoch(root, file);
  try { await publish(root, descriptor, value, epoch); }
  finally { releaseMemoryState(root, file); }
}

function subscribe<T>(job: CacheJob<T>, file: string, key: string, signal?: AbortSignal): Promise<T> {
  ++job.subscribers;
  return new Promise((resolve, reject) => {
    let finished = false;
    const release = (cancelled: boolean): boolean => {
      if (finished) return false;
      finished = true; signal?.removeEventListener('abort', abort); --job.subscribers;
      if (cancelled && job.subscribers === 0 && !job.settled) {
        if (pending.get(key) === job) pending.delete(key);
        if (epochs.get(file) === job.epoch) {
          epochs.set(file, file.startsWith('\0uri:') ? ++memoryEpoch : job.epoch + 1); statuses.set(file, 'missing');
        }
      }
      return true;
    };
    const abort = () => { if (release(true)) reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    job.promise.then(value => { if (release(false)) resolve(value); }, error => { if (release(false)) reject(error); });
  });
}
export function getOrGenerateCache<T>(root: CacheRoot, request: CacheRequest<T>): Promise<T> {
  if (request.signal?.aborted) return Promise.reject(abortError());
  root = typeof root === 'string' ? root : { uri: root.uri };
  request = { ...request, scope: request.scope ? { ...request.scope } : undefined };
  const file = cacheKey(root, request.id, request.scope);
  const inputHash = cacheFingerprint(request.input);
  const key = `${file}\0${request.version}\0${inputHash}`;
  const existing = pending.get(key);
  if (existing && existing.epoch === epochs.get(file)) return subscribe(existing as CacheJob<T>, file, key, request.signal);
  const epoch = nextEpoch(root, file);
  const job = Promise.resolve().then(async () => {
    const cached = await readCache(root, request);
    if (cacheFingerprint(request.input) !== inputHash) throw new Error('Cache input changed during lookup');
    if (epochs.get(file) !== epoch) throw abortError();
    if (cached !== undefined) { statuses.set(file, 'ready'); return cached; }
    statuses.set(file, 'generating');
    const result = await request.generate();
    if (cacheFingerprint(request.input) !== inputHash) throw new Error('Cache input changed during generation');
    try {
      await publish(root, request, result, epoch);
    } catch (error) {
      // Disk persistence is optional. Validation, identity, missing-Library and
      // cancellation failures are not storage degradation and must still reject.
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE', 'EIO'].includes(code ?? '')) throw error;
      if (epochs.get(file) !== epoch) throw abortError();
      statuses.set(file, 'failed');
    }
    // Return detached JSON, identical to a subsequent disk read.
    return JSON.parse(JSON.stringify(result)) as T;
  });
  const active: CacheJob<T> = { promise: job, epoch, subscribers: 0, settled: false };
  pending.set(key, active);
  void job.catch(() => { if (epochs.get(file) === epoch) statuses.set(file, 'failed'); });
  void job.finally(() => { active.settled = true; if (pending.get(key) === active) pending.delete(key); releaseMemoryState(root, file); }).catch(() => undefined);
  return subscribe(active, file, key, request.signal);
}

export function cacheStatus(root: CacheRoot, id: string, scope?: CacheScope): CacheStatus {
  const key = cacheKey(root, id, scope);
  return statuses.get(key) ?? (typeof root !== 'string' ? memoryFailures.get(key) ?? (memory.has(key) ? 'ready' : 'missing') : 'missing');
}
/** Remove only this generator's result; never recurse into authored directories. */
export async function clearCache(root: CacheRoot, id: string, scope?: CacheScope): Promise<void> {
  root = typeof root === 'string' ? root : { uri: root.uri };
  const file = cacheKey(root, id, scope);
  nextEpoch(root, file);
  for (const key of pending.keys()) if (key.startsWith(file + '\0')) pending.delete(key);
  statuses.set(file, 'missing');
  try {
    await serial(file, async () => {
      if (typeof root !== 'string') { removeMemory(file); return; }
      try { await guard(root, id, scope, false); await fs.unlink(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    });
  } finally { releaseMemoryState(root, file); }
}
