import { EntryPointer, EntryPointerRegex, normalizeEntryPointer, normalizePointerFile } from './schema';

/** Raw forward target, in 1-based UTF-16 half-open coordinates.
 * coveredEndLine is the last covered row used once by inverse compilation.
 * A zero-width match covers its start line. Lines mode excludes the final newline.
 */
export interface PointerRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  coveredEndLine: number;
}
export type PointerDiagnostic =
  | { status: 'invalid-shape'; message: string }
  | { status: 'file-missing'; file: string }
  | { status: 'file-read-error'; file: string; message: string }
  | { status: 'line-out-of-range'; file: string; line: number; totalLines: number }
  | { status: 'invalid-regex'; message: string }
  | { status: 'regex-no-match'; file: string; pattern: string; occurrence: number }
  | { status: 'regex-timeout'; file: string; timeoutMs: number }
  | { status: 'regex-worker-error'; file: string; message: string };
export type TextResolution = { status: 'ok'; range: PointerRange } | PointerDiagnostic;
export type RegexOffsets = { status: 'ok'; start: number; end: number } | PointerDiagnostic;

/** Self-contained function: also serialized into a bounded Node worker (no module dependencies).
 * Whole-file JS flags/occurrence semantics, including sticky mode, match forward navigation.
 */
export function resolveRegexOffsets(pointer: EntryPointerRegex, text: string): RegexOffsets {
  let re: RegExp;
  try {
    re = new RegExp(pointer.pattern, pointer.flags ?? 'g');
    if (!re.global) re = new RegExp(re.source, re.flags + 'g');
  } catch (error) {
    return { status: 'invalid-regex', message: error instanceof Error ? error.message : String(error) };
  }
  const occurrence = pointer.occurrence ?? 1;
  let seen = 0;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text)) !== null) {
    if (++seen === occurrence) return { status: 'ok', start: hit.index, end: hit.index + hit[0].length };
    if (hit[0].length === 0) {
      // AdvanceStringIndex: advancing one UTF-16 unit with /u can rewind to a surrogate start.
      const index = re.lastIndex;
      const first = text.charCodeAt(index);
      const next = text.charCodeAt(index + 1);
      re.lastIndex += (re.unicode || re.flags.includes('v')) && first >= 0xd800 && first <= 0xdbff &&
        next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    }
  }
  return { status: 'regex-no-match', file: pointer.file, pattern: pointer.pattern, occurrence };
}

/** The editor's LF/CRLF/CR rows, with offsets into the unchanged UTF-16 string. */
export function sourceTextLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [], starts = [0];
  let start = 0;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push(text.slice(start, match.index));
    start = match.index + match[0].length;
    starts.push(start);
  }
  lines.push(text.slice(start));
  return { lines, starts };
}

function lineCol(rows: ReturnType<typeof sourceTextLines>, offset: number): [number, number] | null {
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let lo = 0, hi = rows.starts.length;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (rows.starts[mid] <= offset) lo = mid; else hi = mid;
  }
  const column = offset - rows.starts[lo] + 1;
  // A position between CR and LF has no exact VS Code/Monaco caret.
  return column <= rows.lines[lo].length + 1 ? [lo + 1, column] : null;
}

/** Pure resolver for trusted/bounded text processing. Host callers use resolvePointerTextAsync
 * instead: arbitrary authored regex must never run on the extension host thread.
 * The optional offsets let that worker share the exact same coordinate conversion.
 */
export function resolvePointerText(value: EntryPointer, text: string, offsets?: RegexOffsets): TextResolution {
  const pointer = normalizeEntryPointer(value);
  if (!pointer || !normalizePointerFile(pointer.file)) {
    return { status: 'invalid-shape', message: 'pointer failed structural/path validation' };
  }
  if (pointer.mode === 'lines') {
    const { lines } = sourceTextLines(text);
    if (pointer.line > lines.length) {
      return { status: 'line-out-of-range', file: pointer.file, line: pointer.line, totalLines: lines.length };
    }
    const endLine = Math.min(pointer.endLine ?? pointer.line, lines.length);
    const startColumn = pointer.column ?? 1;
    const endColumn = pointer.endColumn ?? lines[endLine - 1].length + 1;
    if (startColumn > lines[pointer.line - 1].length + 1 ||
        endColumn > lines[endLine - 1].length + 1 ||
        (pointer.endColumn !== undefined && (pointer.endLine ?? pointer.line) > lines.length) ||
        (endLine === pointer.line && endColumn < startColumn)) {
      return { status: 'invalid-shape', message: 'pointer columns exceed source bounds or form a reversed range' };
    }
    // Legacy whole rows include an empty last row; precise endpoints are half-open.
    const coveredEndLine = pointer.endColumn !== undefined && endColumn === 1 && endLine > pointer.line ? endLine - 1 : endLine;
    return { status: 'ok', range: { startLine: pointer.line, startColumn,
      endLine, endColumn, coveredEndLine } };
  }
  const match = offsets ?? resolveRegexOffsets(pointer, text);
  if (match.status !== 'ok') return match;
  const rows = sourceTextLines(text);
  const start = lineCol(rows, match.start), end = lineCol(rows, match.end);
  if (!start || !end || match.end < match.start) {
    return { status: 'invalid-shape', message: 'regex endpoint has no exact editor position (inside CRLF or outside source)' };
  }
  const [startLine, startColumn] = start;
  const [endLine, endColumn] = end;
  const coveredEndLine = endColumn === 1 && endLine > startLine ? endLine - 1 : endLine;
  return { status: 'ok', range: { startLine, startColumn, endLine, endColumn, coveredEndLine } };
}
