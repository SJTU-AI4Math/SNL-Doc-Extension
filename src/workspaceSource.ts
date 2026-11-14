import * as vscode from 'vscode';

const SOURCE_KEY = 'snlDoc.workspaceSource';
let activeSource: string | undefined;
let selecting = false;

/** Bind once per extension host. An open panel must never switch its write
 * destination just because a folder was reordered, removed or selected. */
export function bindWorkspaceSource(state: vscode.Memento | undefined): void {
  activeSource = state?.get<string>(SOURCE_KEY) ??
    vscode.workspace.workspaceFolders?.[0]?.uri.toString(true);
}

export function getWorkspaceSource(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (activeSource === undefined) return folders?.[0]?.uri;
  return folders?.find(folder => folder.uri.toString(true) === activeSource)?.uri;
}

export async function selectWorkspaceSource(
  state: vscode.Memento,
  labels: { noFolder: string; current: string; prompt: string; reload: string; change: string },
): Promise<void> {
  if (selecting) return;
  selecting = true;
  try {
    await chooseSource(state, labels);
  } finally {
    selecting = false;
  }
}

async function chooseSource(
  state: vscode.Memento,
  labels: { noFolder: string; current: string; prompt: string; reload: string; change: string },
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showInformationMessage(labels.noFolder);
    return;
  }
  const picked = await vscode.window.showQuickPick(folders.map(folder => ({
    label: folder.name,
    description: folder.uri.toString(true) === activeSource ? labels.current : undefined,
    detail: folder.uri.scheme === 'file' ? folder.uri.fsPath : folder.uri.toString(true),
    uri: folder.uri.toString(true),
  })), { placeHolder: labels.prompt });
  if (!picked || picked.uri === activeSource) return;
  const confirm = await vscode.window.showWarningMessage(labels.reload, { modal: true }, labels.change);
  if (confirm !== labels.change || !vscode.workspace.workspaceFolders?.some(folder => folder.uri.toString(true) === picked.uri)) return;
  await state.update(SOURCE_KEY, picked.uri);
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
