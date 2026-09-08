import { createHash } from 'node:crypto';
import type { Localized } from '@sjtu-ai4math/snl-basics';
import { isStructuralPointer, normalizePointerFile } from './schema';
import { readPointerSource, resolvePointerTextAsync } from './resolve';
import { compilePointerScope, rankCompiledScopes, ScopeResolution, CompiledPointerScope } from './scope';

export interface PointerIndexEntryInput {
  id: string;
  package?: string;
  title?: Localized<string, string> | Record<string, string>;
  pointer?: unknown;
}
export interface IndexedPointer {
  entryId: string;
  package?: string;
  title?: Localized<string, string> | Record<string, string>;
  /** Rebuild provenance ONLY; query never consults addressing or thresholds. */
  pointer: unknown;
  resolution: ScopeResolution;
}
export interface PointerFileBucket {
  /** SHA-256 of the decoded UTF-8 source text, also used for dirty snapshots. */
  fingerprint: string | null;
  entries: IndexedPointer[];
}
export interface PointerIndex {
  /** Derived format version only; independent of the workspace schema version. */
  version: 2;
  files: Record<string, PointerFileBucket>;
  /** Invalid pointers with no safe logical file; never searched as another file's candidates. */
  unfiled: IndexedPointer[];
}

export function sourceFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable JSON also makes identity independent of authored object-key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(item).sort()) sorted[key] = item[key];
    return sorted;
  });
}

function logicalFile(pointer: unknown): string | undefined {
  if (!pointer || typeof pointer !== 'object' || !('file' in pointer) || typeof pointer.file !== 'string') return undefined;
  return normalizePointerFile(pointer.file);
}
function compareEntries(a: IndexedPointer, b: IndexedPointer): number {
  const x = stableStringify([a.entryId, a.package ?? '', a.pointer]);
  const y = stableStringify([b.entryId, b.package ?? '', b.pointer]);
  return x < y ? -1 : x > y ? 1 : 0;
}
function ownBucket(index: PointerIndex | undefined, file: string): PointerFileBucket | undefined {
  return index && Object.hasOwn(index.files, file) ? index.files[file] : undefined;
}

async function resolveBucket(
  entries: IndexedPointer[], text: string, previous?: PointerFileBucket
): Promise<PointerFileBucket> {
  const fingerprint = sourceFingerprint(text);
  const cache = new Map<string, ScopeResolution>();
  if (previous?.fingerprint === fingerprint) {
    for (const entry of previous.entries) {
      // Infrastructure failures are retryable even for unchanged bytes.
      if (entry.resolution.status !== 'regex-timeout' && entry.resolution.status !== 'regex-worker-error') {
        cache.set(stableStringify(entry.pointer), entry.resolution);
      }
    }
  }
  const resolved: IndexedPointer[] = [];
  for (const entry of entries) {
    const key = stableStringify(entry.pointer);
    let resolution = cache.get(key);
    if (!resolution) {
      if (isStructuralPointer(entry.pointer)) {
        const raw = await resolvePointerTextAsync(entry.pointer, text);
        resolution = raw.status === 'ok' ? { status: 'ok', scope: compilePointerScope(entry.pointer, raw.range, text) } : raw;
      } else resolution = { status: 'invalid-shape', message: 'pointer failed structural validation' };
      cache.set(key, resolution);
    }
    resolved.push({ ...entry, resolution });
  }
  return { fingerprint, entries: resolved };
}

/** Full metadata snapshot rebuild. Reads each referenced file once, reuses only matching
 * file-content hash + complete authored Pointer identity. Removed/moved entries disappear.
 * Serial workers bound concurrency; callers should serialize/coalesce rebuild requests.
 */
export async function buildPointerIndex(
  rootPath: string, entries: readonly PointerIndexEntryInput[], previousIndex?: PointerIndex
): Promise<PointerIndex> {
  const groups = new Map<string, IndexedPointer[]>();
  const index: PointerIndex = { version: 2, files: Object.create(null), unfiled: [] };
  for (const entry of entries) {
    if (entry.pointer === undefined || entry.pointer === null) continue;
    const record: IndexedPointer = { entryId: entry.id, pointer: JSON.parse(stableStringify(entry.pointer)),
      resolution: { status: 'invalid-shape', message: 'pointer has no safe workspace-relative file' } };
    if (entry.package !== undefined) record.package = entry.package;
    if (entry.title !== undefined) record.title = JSON.parse(stableStringify(entry.title));
    const file = logicalFile(entry.pointer);
    if (!file) { index.unfiled.push(record); continue; }
    const group = groups.get(file) ?? [];
    group.push(record);
    groups.set(file, group);
  }
  for (const file of [...groups.keys()].sort()) {
    const records = groups.get(file)!.sort(compareEntries);
    const source = await readPointerSource(rootPath, file);
    index.files[file] = source.status === 'ok'
      ? await resolveBucket(records, source.text, previousIndex?.version === 2 ? ownBucket(previousIndex, file) : undefined)
      : { fingerprint: null, entries: records.map(entry => ({ ...entry, resolution: source })) };
  }
  index.unfiled.sort(compareEntries);
  return index;
}

export interface NearestEntry {
  entryId: string;
  package?: string;
  title?: Localized<string, string> | Record<string, string>;
  /** Compatibility only: every selected scope contains the cursor. */
  distance: 0;
  priority: number;
  range: CompiledPointerScope;
}
export interface NearestEntriesResult {
  candidates: NearestEntry[];
  complete: boolean;
  unresolved: IndexedPointer[];
}

/** Snapshot-only lookup; selection knows only compiled scope and metadata. */
export function findNearestEntries(index: PointerIndex, relativeFile: string, line: number, column?: number): NearestEntriesResult {
  const file = normalizePointerFile(relativeFile);
  if (index.version !== 2 || !file || !Number.isSafeInteger(line) || line < 1 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return { candidates: [], complete: false, unresolved: [] };
  return rankBucket(ownBucket(index, file), line, column);
}

function rankBucket(bucket: PointerFileBucket | undefined, line: number, column?: number): NearestEntriesResult {
  const unresolved = (bucket?.entries ?? []).filter(entry => entry.resolution.status !== 'ok');
  const resolved = (bucket?.entries ?? []).flatMap(entry => entry.resolution.status === 'ok'
    ? [{ entryId: entry.entryId, package: entry.package, title: entry.title, range: entry.resolution.scope,
        priority: entry.resolution.scope.priority, distance: 0 as const }] : []);
  return { candidates: rankCompiledScopes(resolved, entry => entry.range, line, column),
    complete: unresolved.length === 0, unresolved };
}

/** Resolve just this file against a dirty editor snapshot; no disk writes or other-file regex.
 * Keep the returned temporary index to reuse its hash on subsequent cursor events. */
export async function updatePointerIndexText(
  index: PointerIndex, relativeFile: string, text: string
): Promise<PointerIndex> {
  if (index.version !== 2) throw new Error('Obsolete Pointer index; rebuild required');
  const file = normalizePointerFile(relativeFile);
  if (!file) throw new Error('Invalid relative source path');
  const bucket = ownBucket(index, file);
  if (!bucket) return index;
  const updated = await resolveBucket(bucket.entries, text, bucket);
  const files = Object.assign(Object.create(null), index.files, { [file]: updated });
  return { ...index, files };
}

/** Direct current-text query when the caller does not need to retain the temporary index. */
export async function queryNearestEntries(
  index: PointerIndex, relativeFile: string, line: number, textOverride?: string, column?: number
): Promise<NearestEntriesResult> {
  if (index.version !== 2) return { candidates: [], complete: false, unresolved: [] };
  if (textOverride === undefined) return findNearestEntries(index, relativeFile, line, column);
  const file = normalizePointerFile(relativeFile);
  if (!file || !Number.isSafeInteger(line) || line < 1 ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) {
    return { candidates: [], complete: false, unresolved: [] };
  }
  const bucket = ownBucket(index, file);
  return rankBucket(bucket ? await resolveBucket(bucket.entries, textOverride, bucket) : undefined, line, column);
}
