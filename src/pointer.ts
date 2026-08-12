// Pointer schema + resolver for EntryData.pointer (cat 2026-07-11).
//
// An Entry can bind to a location in a source file via a small pointer
// object. Two modes supported at MVP:
//
//   lines: { file, mode:'lines', line, endLine? }
//     — 1-indexed line range. endLine defaults to line.
//   regex: { file, mode:'regex', pattern, flags?, occurrence? }
//     — regex against the file's text; nth match (1-indexed, default 1).
//
// Paths are resolved relative to the workspace root. Resolution errors
// (missing file, out-of-range line, non-matching regex) surface as an
// error toast at click time — we do not pre-scan every entry on push
// (would add filesystem traffic to every panel reload without user
// intent to jump).

import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';

export type PointerMode = 'lines' | 'regex';

export interface EntryPointerLines {
  file: string;
  mode: 'lines';
  line: number;
  endLine?: number;
}

export interface EntryPointerRegex {
  file: string;
  mode: 'regex';
  pattern: string;
  flags?: string;
  occurrence?: number;
}

export type EntryPointer = EntryPointerLines | EntryPointerRegex;

export type ResolvedPointer =
  | {
      status: 'ok';
      absolutePath: string;
      startLine: number; // 1-indexed
      endLine: number; // 1-indexed, inclusive
      startColumn?: number; // 1-indexed
      endColumn?: number; // 1-indexed, exclusive
    }
  | { status: 'no-workspace' }
  | { status: 'file-missing'; file: string }
  | { status: 'file-read-error'; file: string; message: string }
  | { status: 'invalid-shape'; message: string }
  | { status: 'line-out-of-range'; file: string; line: number; totalLines: number }
  | { status: 'invalid-regex'; message: string }
  | { status: 'regex-no-match'; file: string; pattern: string; occurrence: number };

/**
 * Structural validation: does the value look like a well-formed pointer?
 * Does NOT touch the filesystem. Used by webview to decide whether to
 * show the jump button at all (before an invocation that would do the
 * fs work).
 */
export function isStructuralPointer(value: unknown): value is EntryPointer {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.file !== 'string' || p.file.trim() === '') return false;
  if (p.mode === 'lines') {
    if (typeof p.line !== 'number' || !Number.isFinite(p.line) || p.line < 1) {
      return false;
    }
    if (
      p.endLine !== undefined &&
      (typeof p.endLine !== 'number' ||
        !Number.isFinite(p.endLine) ||
        p.endLine < p.line)
    ) {
      return false;
    }
    return true;
  }
  if (p.mode === 'regex') {
    if (typeof p.pattern !== 'string' || p.pattern === '') return false;
    if (p.flags !== undefined && typeof p.flags !== 'string') return false;
    if (
      p.occurrence !== undefined &&
      (typeof p.occurrence !== 'number' ||
        !Number.isInteger(p.occurrence) ||
        p.occurrence < 1)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Normalize a pointer field read from entries.json — pass structurally
 * valid pointers through, drop everything else (null, missing fields,
 * unknown mode). Preserves forward-compat with future modes by dropping
 * cleanly rather than throwing.
 */
export function normalizeEntryPointer(value: unknown): EntryPointer | null {
  if (isStructuralPointer(value)) {
    // Rebuild a clean object so extra fields don't leak in.
    if (value.mode === 'lines') {
      const out: EntryPointerLines = {
        file: value.file,
        mode: 'lines',
        line: Math.floor(value.line)
      };
      if (value.endLine !== undefined) out.endLine = Math.floor(value.endLine);
      return out;
    }
    const out: EntryPointerRegex = {
      file: value.file,
      mode: 'regex',
      pattern: value.pattern
    };
    if (value.flags !== undefined) out.flags = value.flags;
    if (value.occurrence !== undefined) {
      out.occurrence = Math.floor(value.occurrence);
    }
    return out;
  }
  return null;
}

/**
 * Resolve a pointer against the workspace filesystem. Returns a
 * discriminated `status` union — callers pick the ok branch to actually
 * navigate, all other branches carry enough info for a user-facing toast.
 */
export async function resolveEntryPointer(
  workspaceRoot: vscode.Uri,
  pointer: EntryPointer
): Promise<ResolvedPointer> {
  if (!isStructuralPointer(pointer)) {
    return { status: 'invalid-shape', message: 'pointer failed structural validation' };
  }

  // Reject absolute paths — pointers are workspace-relative by contract.
  // Also normalize any `..` traversal so we don't escape the workspace.
  const rel = pointer.file.replace(/\\/g, '/');
  if (path.isAbsolute(rel)) {
    return { status: 'invalid-shape', message: 'pointer.file must be workspace-relative' };
  }
  const absolutePath = path.resolve(workspaceRoot.fsPath, rel);
  const rootReal = path.resolve(workspaceRoot.fsPath);
  if (!absolutePath.startsWith(rootReal + path.sep) && absolutePath !== rootReal) {
    return {
      status: 'invalid-shape',
      message: 'pointer.file resolves outside workspace root'
    };
  }

  let text: string;
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return { status: 'file-missing', file: rel };
    }
    text = await fs.readFile(absolutePath, 'utf8');
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'file-missing', file: rel };
    }
    return {
      status: 'file-read-error',
      file: rel,
      message: err instanceof Error ? err.message : String(err)
    };
  }

  if (pointer.mode === 'lines') {
    // Count lines. Split on any newline style but keep 1-indexed count
    // matching the editor's presentation.
    const lines = text.split(/\r?\n/);
    const totalLines = lines.length;
    const startLine = pointer.line;
    const endLine = pointer.endLine ?? startLine;
    if (startLine < 1 || startLine > totalLines) {
      return {
        status: 'line-out-of-range',
        file: rel,
        line: startLine,
        totalLines
      };
    }
    // endLine clamped: pointing past EOF is not a hard error, just
    // trim to last line.
    const finalEnd = Math.min(endLine, totalLines);
    return {
      status: 'ok',
      absolutePath,
      startLine,
      endLine: finalEnd
    };
  }

  // regex mode
  let re: RegExp;
  try {
    re = new RegExp(pointer.pattern, pointer.flags ?? 'g');
  } catch (err) {
    return {
      status: 'invalid-regex',
      message: err instanceof Error ? err.message : String(err)
    };
  }
  // Force 'g' semantics so we can iterate matches deterministically.
  if (!re.flags.includes('g')) {
    re = new RegExp(re.source, re.flags + 'g');
  }
  const wantOccurrence = pointer.occurrence ?? 1;
  let m: RegExpExecArray | null;
  let seen = 0;
  let hit: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) {
    seen += 1;
    if (seen === wantOccurrence) {
      hit = m;
      break;
    }
    // Guard against zero-width infinite loop.
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  if (!hit) {
    return {
      status: 'regex-no-match',
      file: rel,
      pattern: pointer.pattern,
      occurrence: wantOccurrence
    };
  }
  // Map char offset → line/column (1-indexed).
  const offset = hit.index;
  const endOffset = offset + hit[0].length;
  const [sL, sC] = offsetToLineCol(text, offset);
  const [eL, eC] = offsetToLineCol(text, endOffset);
  return {
    status: 'ok',
    absolutePath,
    startLine: sL,
    endLine: eL,
    startColumn: sC,
    endColumn: eC
  };
}

function offsetToLineCol(text: string, offset: number): [number, number] {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }
  const col = offset - lastNewline; // 1-indexed
  return [line, col];
}

/**
 * Human-readable message for a non-ok resolution, suitable for a VS Code
 * error toast.
 */
export function describeResolutionFailure(r: ResolvedPointer): string {
  switch (r.status) {
    case 'ok':
      return '';
    case 'no-workspace':
      return 'Pointer cannot be resolved: no workspace folder is open.';
    case 'invalid-shape':
      return `Pointer is malformed: ${r.message}.`;
    case 'file-missing':
      return `Pointer file not found: ${r.file}`;
    case 'file-read-error':
      return `Failed to read ${r.file}: ${r.message}`;
    case 'line-out-of-range':
      return `Pointer line ${r.line} exceeds file ${r.file} (only ${r.totalLines} line${r.totalLines === 1 ? '' : 's'}).`;
    case 'invalid-regex':
      return `Pointer regex is invalid: ${r.message}.`;
    case 'regex-no-match':
      return `Pointer regex /${r.pattern}/ has no match #${r.occurrence} in ${r.file}.`;
  }
}

/**
 * Open the resolved pointer in VS Code: reveal the file, select the
 * range, scroll into view. Uses `showTextDocument` (which honours
 * `editor.showEditorViewColumn` settings) so this feels native.
 */
export async function revealResolvedPointer(resolved: ResolvedPointer): Promise<void> {
  if (resolved.status !== 'ok') return;
  const uri = vscode.Uri.file(resolved.absolutePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  // Convert 1-indexed line/col to 0-indexed vscode.Position.
  const startPos = new vscode.Position(
    resolved.startLine - 1,
    (resolved.startColumn ?? 1) - 1
  );
  // For lines mode without explicit column, extend selection to end of endLine.
  let endPos: vscode.Position;
  if (resolved.endColumn !== undefined) {
    endPos = new vscode.Position(
      resolved.endLine - 1,
      resolved.endColumn - 1
    );
  } else {
    const endLineText = doc.lineAt(Math.min(resolved.endLine - 1, doc.lineCount - 1));
    endPos = endLineText.range.end;
  }
  const selection = new vscode.Selection(startPos, endPos);
  const targetUri = uri.toString();
  const existingGroup = vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetUri
    )
  );
  await vscode.window.showTextDocument(doc, {
    viewColumn: existingGroup?.viewColumn ?? vscode.ViewColumn.One,
    selection,
    preserveFocus: false,
    preview: false
  });
}
