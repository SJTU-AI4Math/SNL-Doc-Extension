import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { CreateLibraryPanel } from './createLibraryPanel';
import { DashboardPanel } from './dashboardPanel';
import { InitEntryKindsPanel } from './initEntryKindsPanel';
import { CreateEntryKindPanel } from './createEntryKindPanel';
import { CreateEntryPanel } from './createEntryPanel';
import { initSnlDoc } from './snlDoc';
import { firstWorkspaceFolder } from './panelUtil';

// TODO: import SNL_render from snl-script lib

/**
 * Run `SNL: Init` directly — no webview, no extra UI step.
 *
 * Init is a one-shot scaffold action with no parameters, so opening a panel
 * just to host a single button was friction with zero payoff. We instead
 * call {@link initSnlDoc} synchronously from the command handler and report
 * via toast notifications.
 *
 * Status mapping (see {@link initSnlDoc}):
 *  - `created` → information toast
 *  - `exists`  → warning toast directing to `SNL: Create Library`
 *  - thrown   → error toast with the underlying message
 */
async function runInit(): Promise<void> {
  const workspaceRoot = firstWorkspaceFolder();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(
      'SNL Init requires an open folder / workspace.'
    );
    return;
  }
  try {
    const result = await initSnlDoc(workspaceRoot);
    if (result.status === 'exists') {
      vscode.window.showWarningMessage(
        '.SNL_Doc already exists — use "SNL: Create Library" to add libraries.'
      );
      return;
    }
    vscode.window.showInformationMessage(
      'SNL Doc skeleton initialized. Use "SNL: Create Library" to add your first library.'
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`SNL Init failed: ${text}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const openInfoview = vscode.commands.registerCommand(
    'snlDoc.openInfoview',
    () => {
      InfoviewPanel.createOrShow(context.extensionUri);
    }
  );

  const init = vscode.commands.registerCommand('snlDoc.init', runInit);

  const createLibrary = vscode.commands.registerCommand(
    'snlDoc.createLibrary',
    () => {
      CreateLibraryPanel.createOrShow(context.extensionUri);
    }
  );

  const openDashboard = vscode.commands.registerCommand(
    'snlDoc.openDashboard',
    () => {
      DashboardPanel.createOrShow(context.extensionUri);
    }
  );

  const initEntryKinds = vscode.commands.registerCommand(
    'snlDoc.initEntryKinds',
    () => {
      InitEntryKindsPanel.createOrShow(context.extensionUri);
    }
  );

  const createEntryKind = vscode.commands.registerCommand(
    'snlDoc.createEntryKind',
    () => {
      CreateEntryKindPanel.createOrShow(context.extensionUri);
    }
  );

  const createEntry = vscode.commands.registerCommand(
    'snlDoc.createEntry',
    () => {
      CreateEntryPanel.createOrShow(context.extensionUri);
    }
  );

  context.subscriptions.push(
    openInfoview,
    init,
    createLibrary,
    openDashboard,
    initEntryKinds,
    createEntryKind,
    createEntry
  );
}

export function deactivate(): void {
  // no-op
}
