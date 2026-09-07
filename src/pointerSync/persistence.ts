import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PointerIndex, stableStringify } from './index';
import { isStructuralPointer, normalizePointerFile } from './schema';
import { is_valid_i18n_string } from '../localizedContent';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function validResolution(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.status) {
    case 'ok': {
      const r = value.range;
      if (!record(r) || !['startLine', 'startColumn', 'endLine', 'endColumn', 'coveredEndLine'].every(k => positive(r[k]))) return false;
      const start = r.startLine as number, end = r.endLine as number;
      return end >= start && (end !== start || (r.endColumn as number) >= (r.startColumn as number)) &&
        (r.coveredEndLine as number) >= start && (r.coveredEndLine as number) <= end;
    }
    case 'invalid-shape': case 'invalid-regex': return typeof value.message === 'string';
    case 'file-missing': return typeof value.file === 'string';
    case 'file-read-error': case 'regex-worker-error':
      return typeof value.file === 'string' && typeof value.message === 'string';
    case 'line-out-of-range': return typeof value.file === 'string' && positive(value.line) &&
      positive(value.totalLines) && value.line > value.totalLines;
    case 'regex-no-match': return typeof value.file === 'string' && typeof value.pattern === 'string' && positive(value.occurrence);
    case 'regex-timeout': return typeof value.file === 'string' && positive(value.timeoutMs);
    default: return false;
  }
}

/** Structural cache validation, not a freshness certificate. Rebuild after startup/metadata changes
 * and resolve dirty source snapshots before querying. Never execute regex while reading a cache. */
export function isPointerIndex(value: unknown): value is PointerIndex {
  if (!record(value) || value.version !== 1 || !record(value.files) || !Array.isArray(value.unfiled)) return false;
  const seen = new Set<string>();
  const validEntry = (entry: unknown, file?: string, fingerprint?: unknown): boolean => {
    if (!record(entry) || typeof entry.entryId !== 'string' || !entry.entryId ||
        !Object.hasOwn(entry, 'pointer') || entry.pointer == null || !validResolution(entry.resolution)) return false;
    if (entry.package !== undefined && typeof entry.package !== 'string') return false;
    if (entry.title !== undefined && typeof entry.title !== 'string' && !is_valid_i18n_string(entry.title) &&
        !(record(entry.title) && Object.values(entry.title).every(v => typeof v === 'string'))) return false;
    const identity = stableStringify([entry.package ?? '', entry.entryId]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    const resolution = entry.resolution as Record<string, unknown>;
    const pointerFile = record(entry.pointer) && typeof entry.pointer.file === 'string'
      ? normalizePointerFile(entry.pointer.file) : undefined;
    if (file === undefined) return pointerFile === undefined && resolution.status === 'invalid-shape';
    if (pointerFile !== file) return false;
    if (typeof resolution.file === 'string' && normalizePointerFile(resolution.file) !== file) return false;
    if (resolution.status === 'ok') {
      if (fingerprint === null || !isStructuralPointer(entry.pointer)) return false;
      const range = resolution.range as { startLine: number; endLine: number; endColumn: number; coveredEndLine: number };
      const expectedEnd = entry.pointer.mode === 'lines' ? range.endLine :
        range.endColumn === 1 && range.endLine > range.startLine ? range.endLine - 1 : range.endLine;
      if (range.coveredEndLine !== expectedEnd) return false;
    }
    return true;
  };
  for (const [file, bucket] of Object.entries(value.files)) {
    if (normalizePointerFile(file) !== file || !record(bucket) || !Array.isArray(bucket.entries) ||
        !(bucket.fingerprint === null || (typeof bucket.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(bucket.fingerprint))) ||
        !bucket.entries.every(entry => validEntry(entry, file, bucket.fingerprint))) return false;
  }
  return value.unfiled.every(entry => validEntry(entry));
}

function indexPath(rootPath: string): string { return path.join(rootPath, '.SNL_Doc', 'syncSNL.json'); }

async function rejectSymlink(target: string, directory = false): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink index path: ${target}`);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Invalid index path: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function readPointerIndex(rootPath: string): Promise<PointerIndex | undefined> {
  const target = indexPath(rootPath);
  try {
    await rejectSymlink(path.dirname(target), true);
    await rejectSymlink(target);
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      return isPointerIndex(value) ? value : undefined;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

/** Atomic last-writer-wins cache replacement. Parent must serialize generation publication.
 * Reject final-path and .SNL_Doc symlinks; a trusted directory tree is still required because
 * Node has no portable openat/renameat API to lock out hostile ancestor-directory replacement.
 */
export async function writePointerIndex(rootPath: string, index: PointerIndex): Promise<void> {
  if (!isPointerIndex(index)) throw new Error('Invalid Pointer index');
  const target = indexPath(rootPath);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  await rejectSymlink(directory, true);
  await rejectSymlink(target);
  const temporary = path.join(directory, `.syncSNL.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(stableStringify(index) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await rejectSymlink(directory, true);
    await rejectSymlink(target);
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
