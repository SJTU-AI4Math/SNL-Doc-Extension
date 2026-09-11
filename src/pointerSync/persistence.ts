import { readCacheArtifact, writeCache } from '../derivedCache';
import { PointerIndex, stableStringify } from './index';
import { isStructuralPointer, normalizePointerFile } from './schema';
import { isCompiledPointerScope } from './scope';
import { is_valid_i18n_string } from '../localizedContent';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function validResolution(value: unknown): boolean {
  if (!record(value)) return false;
  switch (value.status) {
    case 'ok': return !Object.hasOwn(value, 'range') && isCompiledPointerScope(value.scope);
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
  if (!record(value) || value.version !== 3 || !record(value.files) || !Array.isArray(value.unfiled)) return false;
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
      if ((resolution.scope as { priority: number }).priority !== (entry.pointer.priority ?? 0)) return false;
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

/** Canonical build inputs, never dirty overlays. Content v3 is independent of envelope v1. */
export function pointerIndexInputs(index: PointerIndex): unknown {
  const entry = ({ resolution: _resolution, ...metadata }: PointerIndex['unfiled'][number]) => metadata;
  return {
    files: Object.fromEntries(Object.entries(index.files).map(([file, bucket]) => [file, {
      fingerprint: bucket.fingerprint, entries: bucket.entries.map(entry)
    }])),
    unfiled: index.unfiled.map(entry)
  };
}

/** Structural inspection only, NOT a freshness certificate for navigation.
 * The driver rereads canonical Entries and source files on cold start.
 * Legacy syncSNL.json is deliberately neither read, rewritten nor removed. */
export async function readPointerIndex(rootPath: string): Promise<PointerIndex | undefined> {
  return (await readCacheArtifact(rootPath, {
    id: 'pointer-inverse', version: '1', validate: isPointerIndex
  }))?.value;
}

/** Publication is serialized by the Pointer host after its generation check. */
export async function writePointerIndex(rootPath: string, index: PointerIndex): Promise<void> {
  if (!isPointerIndex(index)) throw new Error('Invalid Pointer index');
  await writeCache(rootPath, {
    id: 'pointer-inverse', version: '1', input: pointerIndexInputs(index), validate: isPointerIndex
  }, index);
}
