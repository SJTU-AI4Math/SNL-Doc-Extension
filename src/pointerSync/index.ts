import { createHash } from 'node:crypto';
import { isStructuralPointer, normalizePointerFile } from './schema';
import { readPointerSource, resolvePointerTextAsync } from './resolve';
import { TextResolution } from './text';

export interface PointerIndexEntryInput {
  id: string;
  package?: string;
  title?: string | Record<string, string>;
  pointer?: unknown;
}
export interface IndexedPointer {
  entryId: string;
  package?: string;
  title?: string | Record<string, string>;
  /** Original authored JSON, not the normalized execution view. */
  pointer: unknown;
  resolution: TextResolution;
}
export interface PointerFileBucket {
  /** SHA-256 of the decoded UTF-8 source text, also used for dirty snapshots. */
  fingerprint: string | null;
  entries: IndexedPointer[];
}
export interface PointerIndex {
  /** Derived format version only; independent of the workspace schema version. */
  version: 1;
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
  const cache = new Map<string, TextResolution>();
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
      resolution = isStructuralPointer(entry.pointer)
        ? await resolvePointerTextAsync(entry.pointer, text)
        : { status: 'invalid-shape', message: 'pointer failed structural validation' };
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
  const index: PointerIndex = { version: 1, files: Object.create(null), unfiled: [] };
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
      ? await resolveBucket(records, source.text, previousIndex?.version === 1 ? ownBucket(previousIndex, file) : undefined)
      : { fingerprint: null, entries: records.map(entry => ({ ...entry, resolution: source })) };
  }
  index.unfiled.sort(compareEntries);
  return index;
}

export interface NearestEntry {
  entryId: string;
  package?: string;
  title?: string | Record<string, string>;
  distance: number;
  range: import('./text').PointerRange;
}
export interface NearestEntriesResult {
  candidates: NearestEntry[];
  complete: boolean;
  unresolved: IndexedPointer[];
}

/** Snapshot-only, current-file lookup. Returns only the best (distance, covered-line span)
 * rank, retaining ALL ties. A unique candidate is actionable only when complete is true.
 * Completeness assumes the host has delivered all metadata/source invalidations.
 */
export function findNearestEntries(index: PointerIndex, relativeFile: string, line: number): NearestEntriesResult {
  const file = normalizePointerFile(relativeFile);
  if (!file || !Number.isSafeInteger(line) || line < 1) return { candidates: [], complete: false, unresolved: [] };
  return rankBucket(ownBucket(index, file), line);
}

function rankBucket(bucket: PointerFileBucket | undefined, line: number): NearestEntriesResult {
  const unresolved: IndexedPointer[] = [];
  let candidates: NearestEntry[] = [];
  let bestDistance = Infinity;
  let bestSpan = Infinity;
  for (const entry of bucket?.entries ?? []) {
    if (entry.resolution.status !== 'ok' || !isStructuralPointer(entry.pointer)) {
      unresolved.push(entry);
      continue;
    }
    const range = entry.resolution.range;
    const distance = Math.max(range.startLine - line, line - range.coveredEndLine, 0);
    const threshold = line < range.startLine ? entry.pointer.beforeLines ?? 15 : entry.pointer.afterLines ?? 15;
    if (distance > threshold) continue;
    const span = range.coveredEndLine - range.startLine + 1;
    if (distance > bestDistance || (distance === bestDistance && span > bestSpan)) continue;
    if (distance < bestDistance || span < bestSpan) candidates = [];
    bestDistance = distance;
    bestSpan = span;
    const candidate: NearestEntry = { entryId: entry.entryId, distance, range };
    if (entry.package !== undefined) candidate.package = entry.package;
    if (entry.title !== undefined) candidate.title = entry.title;
    candidates.push(candidate);
  }
  return { candidates, complete: unresolved.length === 0, unresolved };
}

/** Resolve just this file against a dirty editor snapshot; no disk writes or other-file regex.
 * Keep the returned temporary index to reuse its hash on subsequent cursor events. */
export async function updatePointerIndexText(
  index: PointerIndex, relativeFile: string, text: string
): Promise<PointerIndex> {
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
  index: PointerIndex, relativeFile: string, line: number, textOverride?: string
): Promise<NearestEntriesResult> {
  if (textOverride === undefined) return findNearestEntries(index, relativeFile, line);
  const file = normalizePointerFile(relativeFile);
  if (!file || !Number.isSafeInteger(line) || line < 1) return { candidates: [], complete: false, unresolved: [] };
  const bucket = ownBucket(index, file);
  return rankBucket(bucket ? await resolveBucket(bucket.entries, textOverride, bucket) : undefined, line);
}
