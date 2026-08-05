import * as vscode from 'vscode';

/**
 * The `when`-clause context key backing the editor-title 🐱 button.
 *
 * Cat 2026-07-25: 「应该不是面板内的，是 VS Code Extension 好像默认支持在面板
 * 右上角加按钮，比如 Lean 就加了一个。」The button opens the SNL Dashboard, so
 * it only makes sense in a workspace that actually has a `.SNL_Doc/` tree —
 * otherwise it would sprout on every unrelated file in every unrelated project.
 *
 * The key is paired with the `workspaceContains:.SNL_Doc/config.json`
 * activation event in package.json: that event wakes the extension in exactly
 * the workspaces where the button should appear, and `activate()` then flips
 * this key on. Without the activation event the key would never be set (the
 * extension would still be asleep) and the button would never show.
 */
export const SNL_DOC_CONTEXT_KEY = 'snlDoc.hasSnlDoc';

/** Whether `<root>/.SNL_Doc` exists in any open workspace folder. */
export async function workspaceHasSnlDoc(): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, '.SNL_Doc');
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) return true;
    } catch {
      // Missing / unreadable — just not this folder.
    }
  }
  return false;
}

/** Push the current answer into VS Code's `when`-clause context. */
export async function refreshSnlDocContext(): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    SNL_DOC_CONTEXT_KEY,
    await workspaceHasSnlDoc()
  );
}

/**
 * Set the key now and keep it current.
 *
 * `SNL: Init` scaffolds `.SNL_Doc/` inside an already-activated session, so a
 * one-shot check at activation would leave the button missing until reload.
 * We therefore also watch for the folder appearing / disappearing, and re-check
 * when workspace folders change.
 */
export function installSnlDocContextKey(
  disposables: vscode.Disposable[]
): void {
  void refreshSnlDocContext();
  // Watch the sentinel directory itself. Watching `.SNL_Doc/**` caused every
  // entity temp-file create/delete to re-stat all workspace folders and issue
  // a redundant setContext command.
  const watcher = vscode.workspace.createFileSystemWatcher('**/.SNL_Doc');
  const bump = (): void => {
    void refreshSnlDocContext();
  };
  watcher.onDidCreate(bump, null, disposables);
  watcher.onDidDelete(bump, null, disposables);
  disposables.push(watcher);
  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(bump));
}
