/** Portable Pointer schema. The resolved range is the exact inverse scope. */
export type PointerMode = 'lines' | 'regex';
interface PointerBase {
  file: string;
  priority?: number;
}
export interface EntryPointerLines extends PointerBase {
  mode: 'lines';
  line: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
}
export interface EntryPointerRegex extends PointerBase {
  mode: 'regex';
  pattern: string;
  flags?: string;
  occurrence?: number;
}
export type EntryPointer = EntryPointerLines | EntryPointerRegex;

export function isStructuralPointer(value: unknown): value is EntryPointer {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.file !== 'string' || !p.file.trim()) return false;
  // Obsolete beforeLines/afterLines are unknown fields, regardless of their values.
  if (p.priority !== undefined && (typeof p.priority !== 'number' || !Number.isFinite(p.priority))) return false;
  for (const field of ['column', 'endColumn']) {
    const n = p[field];
    if (n !== undefined && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1)) return false;
  }
  if (p.mode === 'lines') {
    // Preserve the existing normalization of fractional authored line numbers.
    return typeof p.line === 'number' && Number.isFinite(p.line) && p.line >= 1 &&
      (p.endLine === undefined || (typeof p.endLine === 'number' &&
        Number.isFinite(p.endLine) && p.endLine >= p.line));
  }
  return p.mode === 'regex' && typeof p.pattern === 'string' && p.pattern !== '' &&
    (p.flags === undefined || typeof p.flags === 'string') &&
    (p.occurrence === undefined || (typeof p.occurrence === 'number' &&
      Number.isSafeInteger(p.occurrence) && p.occurrence >= 1));
}

/** Preserve supported authored options; discard unknown and obsolete fields. */
export function normalizeEntryPointer(value: unknown): EntryPointer | null {
  if (!isStructuralPointer(value)) return null;
  let out: EntryPointer;
  if (value.mode === 'lines') {
    out = { file: value.file, mode: 'lines', line: Math.floor(value.line) };
    if (value.endLine !== undefined) out.endLine = Math.floor(value.endLine);
    if (value.column !== undefined) out.column = value.column;
    if (value.endColumn !== undefined) out.endColumn = value.endColumn;
  } else {
    out = { file: value.file, mode: 'regex', pattern: value.pattern };
    if (value.flags !== undefined) out.flags = value.flags;
    if (value.occurrence !== undefined) out.occurrence = value.occurrence;
  }
  if (value.priority !== undefined) out.priority = value.priority;
  return out;
}

/** Reject lexical traversal (even if it would reenter), POSIX/Windows absolute paths and NUL.
 * Keep the logical path: legitimate .lake dependency symlinks are followed by the disk reader.
 */
export function normalizePointerFile(file: string): string | undefined {
  const rel = file.replace(/\\/g, '/');
  if (!rel.trim() || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.includes('\0') ||
      rel.split('/').includes('..')) return undefined;
  const clean = rel.split('/').filter(part => part && part !== '.').join('/');
  return clean || undefined;
}
