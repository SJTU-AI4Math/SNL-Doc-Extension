import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

/** Internal, trusted calculators only. This API is not a user-script sandbox. */
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
const epochs = new Map<string, number>();
const pending = new Map<string, Promise<unknown>>();
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
export async function readCacheArtifact<T>(root: string, descriptor: Omit<CacheDescriptor<T>, 'input'>): Promise<{ inputHash: string; value: T } | undefined> {
  try {
    const file = await guard(root, descriptor.id, descriptor.scope, false);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
    const envelope: unknown = JSON.parse(text);
    if (!object(envelope) || envelope.format !== 'snl-derived-cache' || envelope.schema !== 1 ||
      envelope.generator !== descriptor.id || envelope.version !== descriptor.version ||
      envelope.library !== (descriptor.scope?.library ?? null) ||
      typeof envelope.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.inputHash) ||
      !descriptor.validate(envelope.value) || envelope.valueHash !== cacheFingerprint(envelope.value)) return undefined;
    return { inputHash: envelope.inputHash, value: envelope.value };
  } catch { return undefined; }
}
export async function readCache<T>(root: string, descriptor: CacheDescriptor<T>): Promise<T | undefined> {
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
async function publish<T>(root: string, descriptor: CacheDescriptor<T>, value: T, epoch: number): Promise<void> {
  const file = cachePath(root, descriptor.id, descriptor.scope);
  if (!descriptor.validate(value)) throw new Error('Invalid generated cache value');
  const text = JSON.stringify({ format: 'snl-derived-cache', schema: 1, generator: descriptor.id,
    version: descriptor.version, library: descriptor.scope?.library ?? null,
    inputHash: cacheFingerprint(descriptor.input), valueHash: cacheFingerprint(value), value });
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Cache output exceeds size limit');
  await serial(file, async () => {
    if (epochs.get(file) !== epoch) throw abortError();
    await guard(root, descriptor.id, descriptor.scope, true);
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text + '\n'); await handle.sync(); } finally { await handle.close(); }
      await guard(root, descriptor.id, descriptor.scope, false);
      if (epochs.get(file) !== epoch) throw abortError();
      await fs.rename(temporary, file);
      statuses.set(file, 'ready');
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
}
/** Trusted producer publication; consumer wire data must be bound/validated first. */
export async function writeCache<T>(root: string, descriptor: CacheDescriptor<T>, value: T): Promise<void> {
  const file = cachePath(root, descriptor.id, descriptor.scope);
  const epoch = (epochs.get(file) ?? 0) + 1; epochs.set(file, epoch);
  await publish(root, descriptor, value, epoch);
}

function subscribe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export function getOrGenerateCache<T>(root: string, request: CacheRequest<T>): Promise<T> {
  if (request.signal?.aborted) return Promise.reject(abortError());
  const file = cachePath(root, request.id, request.scope);
  const inputHash = cacheFingerprint(request.input);
  const key = `${file}\0${request.version}\0${inputHash}`;
  const existing = pending.get(key);
  if (existing) return subscribe(existing as Promise<T>, request.signal);
  const epoch = (epochs.get(file) ?? 0) + 1; epochs.set(file, epoch);
  const job = Promise.resolve().then(async () => {
    const cached = await readCache(root, request);
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
      if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EMFILE'].includes(code ?? '')) throw error;
      if (epochs.get(file) !== epoch) throw abortError();
      statuses.set(file, 'failed');
    }
    // Return detached JSON, identical to a subsequent disk read.
    return JSON.parse(JSON.stringify(result)) as T;
  });
  pending.set(key, job);
  void job.catch(() => { if (epochs.get(file) === epoch) statuses.set(file, 'failed'); });
  void job.finally(() => { if (pending.get(key) === job) pending.delete(key); }).catch(() => undefined);
  return subscribe(job, request.signal);
}

export function cacheStatus(root: string, id: string, scope?: CacheScope): CacheStatus {
  return statuses.get(cachePath(root, id, scope)) ?? 'missing';
}
/** Remove only this generator's result; never recurse into authored directories. */
export async function clearCache(root: string, id: string, scope?: CacheScope): Promise<void> {
  const file = cachePath(root, id, scope);
  epochs.set(file, (epochs.get(file) ?? 0) + 1);
  for (const key of pending.keys()) if (key.startsWith(file + '\0')) pending.delete(key);
  statuses.set(file, 'missing');
  await serial(file, async () => {
    try { await guard(root, id, scope, false); await fs.unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  });
}
