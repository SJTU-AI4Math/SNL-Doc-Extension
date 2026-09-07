import type { EntryPointer } from './schema';
import type { PointerDiagnostic, PointerRange } from './text';

/** The ONLY reverse-reference geometry. No raw range, distance or thresholds survive
 * compilation. Offsets/spans count original UTF-16 units (including CRLF's two units).
 * endInclusive admits the final EOL/empty EOF caret for whole rows, added buffer
 * rows and true points. Other precise endpoints are half-open. */
export interface CompiledPointerScope extends PointerRange {
  startOffset: number;
  endOffset: number;
  span: number;
  priority: number;
  endInclusive: boolean;
}
export type ScopeResolution = { status: 'ok'; scope: CompiledPointerScope } | PointerDiagnostic;

export function compilePointerScope(pointer: EntryPointer, raw: PointerRange, text: string): CompiledPointerScope {
  const rows = text.split('\n');
  const lengths = rows.map(row => row.endsWith('\r') ? row.length - 1 : row.length);
  const starts: number[] = []; let offset = 0;
  for (const row of rows) { starts.push(offset); offset += row.length + 1; }
  const before = pointer.beforeLines ?? 15, after = pointer.afterLines ?? 15;
  const startLine = before > 0 ? Math.max(1, raw.startLine - before) : raw.startLine;
  const startColumn = before > 0 ? 1 : raw.startColumn;
  // Buffer after the last actually covered row; a match ending at next-row column 1
  // does not itself cover that row. Positive buffering includes full added rows.
  const endLine = after > 0 ? Math.min(rows.length, raw.coveredEndLine + after) : raw.endLine;
  const endColumn = after > 0 ? lengths[endLine - 1] + 1 : raw.endColumn;
  const startOffset = starts[startLine - 1] + startColumn - 1;
  const endOffset = starts[endLine - 1] + endColumn - 1;
  const point = raw.startLine === raw.endLine && raw.startColumn === raw.endColumn;
  const endInclusive = after > 0 || (pointer.mode === 'lines' && pointer.endColumn === undefined) || point;
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

/** Shared host/browser selection: containing scopes, highest priority, smallest
 * actual expanded span, ALL ties. The selector receives compiled scopes only. */
export function rankCompiledScopes<T>(items: readonly T[], scope: (item: T) => CompiledPointerScope, line: number, column?: number): T[] {
  let priority = -Infinity, span = Infinity;
  let selected: T[] = [];
  for (const item of items) {
    const s = scope(item);
    if (!scopeContains(s, line, column) || s.priority < priority || (s.priority === priority && s.span > span)) continue;
    if (s.priority > priority || s.span < span) selected = [];
    priority = s.priority; span = s.span; selected.push(item);
  }
  return selected;
}
