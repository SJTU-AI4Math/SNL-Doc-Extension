/** Portable Pointer schema. Missing directional thresholds independently mean 15 lines. */
export type PointerMode = 'lines' | 'regex';
interface PointerBase {
  file: string;
  beforeLines?: number;
  afterLines?: number;
}
export interface EntryPointerLines extends PointerBase {
  mode: 'lines';
  line: number;
  endLine?: number;
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
  for (const field of ['beforeLines', 'afterLines']) {
    const n = p[field];
    if (n !== undefined && (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) return false;
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

/** Keep authored omission vs explicit zero; discard unknown fields. */
export function normalizeEntryPointer(value: unknown): EntryPointer | null {
  if (!isStructuralPointer(value)) return null;
  let out: EntryPointer;
  if (value.mode === 'lines') {
    out = { file: value.file, mode: 'lines', line: Math.floor(value.line) };
    if (value.endLine !== undefined) out.endLine = Math.floor(value.endLine);
  } else {
    out = { file: value.file, mode: 'regex', pattern: value.pattern };
    if (value.flags !== undefined) out.flags = value.flags;
    if (value.occurrence !== undefined) out.occurrence = value.occurrence;
  }
  if (value.beforeLines !== undefined) out.beforeLines = value.beforeLines;
  if (value.afterLines !== undefined) out.afterLines = value.afterLines;
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
