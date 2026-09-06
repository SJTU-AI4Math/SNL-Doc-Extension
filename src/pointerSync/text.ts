import { EntryPointer, EntryPointerRegex, normalizeEntryPointer, normalizePointerFile } from './schema';

/** 1-based UTF-16 half-open coordinates. coveredEndLine is inclusive for line distance.
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

function lineCol(text: string, offset: number): [number, number] {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) { line++; lastNewline = i; }
  }
  return [line, offset - lastNewline];
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
    const lines = text.split(/\r?\n/);
    if (pointer.line > lines.length) {
      return { status: 'line-out-of-range', file: pointer.file, line: pointer.line, totalLines: lines.length };
    }
    const endLine = Math.min(pointer.endLine ?? pointer.line, lines.length);
    const endColumn = lines[endLine - 1].length + 1;
    // Explicit lines ranges include the named last row, even when that row is empty.
    const coveredEndLine = endLine;
    return { status: 'ok', range: { startLine: pointer.line, startColumn: 1,
      endLine, endColumn, coveredEndLine } };
  }
  const match = offsets ?? resolveRegexOffsets(pointer, text);
  if (match.status !== 'ok') return match;
  const [startLine, startColumn] = lineCol(text, match.start);
  const [endLine, endColumn] = lineCol(text, match.end);
  const coveredEndLine = endColumn === 1 && endLine > startLine ? endLine - 1 : endLine;
  return { status: 'ok', range: { startLine, startColumn, endLine, endColumn, coveredEndLine } };
}
