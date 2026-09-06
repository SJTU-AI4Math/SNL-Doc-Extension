// VS Code forward-navigation adapter. Portable schema and shared text semantics live
// in pointerSync/; regex resolution runs in a bounded worker, never on the host thread.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { readPointerSource, resolvePointerTextAsync } from './pointerSync/resolve';
import type { PointerDiagnostic } from './pointerSync/text';
export { resolvePointerText } from './pointerSync/text';
export { resolvePointerTextAsync } from './pointerSync/resolve';

export * from './pointerSync/schema';
import { EntryPointer, isStructuralPointer, normalizePointerFile } from './pointerSync/schema';

export type ResolvedPointer =
  | { status: 'ok'; absolutePath: string; startLine: number; endLine: number;
      startColumn?: number; endColumn?: number; coveredEndLine?: number; documentVersion?: number }
  | { status: 'no-workspace' }
  | { status: 'source-changed' }
  | PointerDiagnostic;

/** Disk and dirty-buffer callers share the same text/coordinate resolver. */
export async function resolveEntryPointer(
  workspaceRoot: vscode.Uri, pointer: EntryPointer
): Promise<ResolvedPointer> {
  if (!isStructuralPointer(pointer)) {
    return { status: 'invalid-shape', message: 'pointer failed structural validation' };
  }
  const file = normalizePointerFile(pointer.file);
  if (!file) return { status: 'invalid-shape', message: 'pointer.file must be workspace-relative' };
  const absolutePath = path.resolve(workspaceRoot.fsPath, file);
  const document = vscode.workspace.textDocuments?.find(doc => doc.uri.scheme === 'file' && path.relative(absolutePath, doc.uri.fsPath) === '');
  const version = document?.version;
  const source = document ? { status: 'ok' as const, text: document.getText(), absolutePath } : await readPointerSource(workspaceRoot.fsPath, file);
  if (source.status !== 'ok') return source;
  const result = await resolvePointerTextAsync(pointer, source.text);
  if (document && (document.isClosed || document.version !== version)) return { status: 'source-changed' };
  if (result.status !== 'ok') return result;
  return { status: 'ok', absolutePath: source.absolutePath, ...result.range, ...(version === undefined ? {} : { documentVersion: version }) };
}

/**
 * Human-readable message for a non-ok resolution, suitable for a VS Code
 * error toast.
 */
export function describeResolutionFailure(r: ResolvedPointer): string {
  switch (r.status) {
    case 'ok':
      return '';
    case 'source-changed':
      return 'Source changed while resolving the Pointer; retry navigation.';
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
    case 'regex-timeout':
      return `Pointer regex exceeded ${r.timeoutMs} ms in ${r.file}.`;
    case 'regex-worker-error':
      return `Pointer regex worker failed for ${r.file}: ${r.message}`;
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
  if (resolved.documentVersion !== undefined && doc.version !== resolved.documentVersion) {
    void vscode.window.showWarningMessage(describeResolutionFailure({ status: 'source-changed' }));
    return;
  }
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
