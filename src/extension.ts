import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { CreateLibraryPanel } from './createLibraryPanel';
import { DashboardPanel } from './dashboardPanel';
import { InitEntryKindsPanel } from './initEntryKindsPanel';
import { CreateEntryKindPanel } from './createEntryKindPanel';
import { CreateEntryPanel } from './createEntryPanel';
import { CreateMacroPackagePanel } from './createMacroPackagePanel';
import { PackagePanel } from './packagePanel';
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

  const createMacroPackage = vscode.commands.registerCommand(
    'snlDoc.createMacroPackage',
    () => {
      CreateMacroPackagePanel.createOrShow(context.extensionUri);
    }
  );

  // No palette entry (see package.json `when: false`): invoked via
  // executeCommand('snlDoc.openMacroPackage', file) from the Dashboard row
  // click and from CreateMacroPackagePanel after a successful create.
  const openMacroPackage = vscode.commands.registerCommand(
    'snlDoc.openMacroPackage',
    (file?: unknown) => {
      if (typeof file !== 'string') {
        return;
      }
      // Path-traversal safety: only bare filenames (optionally `.json`).
      if (!/^[a-zA-Z0-9_-]+(\.json)?$/.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to open macro package with unsafe name: "${file}".`
        );
        return;
      }
      PackagePanel.createOrShow(context.extensionUri, file);
    }
  );

  context.subscriptions.push(
    openInfoview,
    init,
    createLibrary,
    openDashboard,
    initEntryKinds,
    createEntryKind,
    createEntry,
    createMacroPackage,
    openMacroPackage
  );
}

export function deactivate(): void {
  // no-op
}
