import type { EntryPointer } from './schema';
import { sourceTextLines, type PointerDiagnostic, type PointerRange } from './text';

/** The ONLY reverse-reference geometry. No raw range, distance or thresholds survive
 * compilation. Offsets/spans count original UTF-16 units (including CRLF's two units).
 * endInclusive admits the final EOL/empty EOF caret for whole rows and true
 * points. Other precise endpoints are half-open. No scope expansion occurs. */
export interface CompiledPointerScope extends PointerRange {
  startOffset: number;
  endOffset: number;
  span: number;
  priority: number;
  endInclusive: boolean;
}
export type ScopeResolution = { status: 'ok'; scope: CompiledPointerScope } | PointerDiagnostic;

export function compilePointerScope(pointer: EntryPointer, raw: PointerRange, text: string): CompiledPointerScope {
  const { starts } = sourceTextLines(text);
  const { startLine, startColumn, endLine, endColumn } = raw;
  const startOffset = starts[startLine - 1] + startColumn - 1;
  const endOffset = starts[endLine - 1] + endColumn - 1;
  const point = raw.startLine === raw.endLine && raw.startColumn === raw.endColumn;
  const endInclusive = (pointer.mode === 'lines' && pointer.endColumn === undefined) || point;
  const coveredEndLine = !endInclusive && endColumn === 1 && endLine > startLine ? endLine - 1 : endLine;
  return { startLine, startColumn, endLine, endColumn, coveredEndLine,
    startOffset, endOffset, span: endOffset - startOffset, priority: pointer.priority ?? 0, endInclusive };
}

export function isCompiledPointerScope(value: unknown): value is CompiledPointerScope {
  if (!value || typeof value !== 'object') return false;
  const s = value as CompiledPointerScope;
  if (![s.startLine,s.startColumn,s.endLine,s.endColumn,s.coveredEndLine].every(n => Number.isSafeInteger(n) && n > 0) ||
      ![s.startOffset,s.endOffset,s.span].every(n => Number.isSafeInteger(n) && n >= 0) ||
      typeof s.priority !== 'number' || !Number.isFinite(s.priority) || typeof s.endInclusive !== 'boolean') return false;
  return s.endLine >= s.startLine && (s.endLine !== s.startLine || s.endColumn >= s.startColumn) &&
    s.endOffset >= s.startOffset && s.span === s.endOffset - s.startOffset &&
    (s.endLine !== s.startLine || s.span === s.endColumn - s.startColumn) &&
    s.coveredEndLine === (!s.endInclusive && s.endColumn === 1 && s.endLine > s.startLine ? s.endLine - 1 : s.endLine) &&
    (s.span !== 0 || s.endInclusive);
}

/** Optional column is legacy line-intersection mode, not used by live editors. */
export function scopeContains(s: CompiledPointerScope, line: number, column?: number): boolean {
  if (!Number.isSafeInteger(line) || line < 1 || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return false;
  if (column === undefined) return line >= s.startLine && line <= s.coveredEndLine;
  const start = line > s.startLine || (line === s.startLine && column >= s.startColumn);
  const end = line < s.endLine || (line === s.endLine && (column < s.endColumn || (s.endInclusive && column === s.endColumn)));
  return start && end;
}

/** Locale-independent UTF-16 identity ordering, shared by every navigation surface. */
export function comparePointerIdentity(a: { entryId: string; package?: string }, b: { entryId: string; package?: string }): number {
  if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
  const aPackage = a.package ?? '', bPackage = b.package ?? '';
  return aPackage < bPackage ? -1 : aPackage > bPackage ? 1 : 0;
}

/** Shared host/browser selection: containing scopes, highest priority, smallest
 * actual UTF-16 span, ALL ties in identity order. Geometry is compiled-only. */
export function rankCompiledScopes<T extends { entryId: string; package?: string }>(items: readonly T[], scope: (item: T) => CompiledPointerScope, line: number, column?: number): T[] {
  let priority = -Infinity, span = Infinity;
  let selected: T[] = [];
  for (const item of items) {
    const s = scope(item);
    if (!scopeContains(s, line, column) || s.priority < priority || (s.priority === priority && s.span > span)) continue;
    if (s.priority > priority || s.span < span) selected = [];
    priority = s.priority; span = s.span; selected.push(item);
  }
  return selected.sort(comparePointerIdentity);
}
