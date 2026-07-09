import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { CreateLibraryPanel } from './createLibraryPanel';
import { DashboardPanel } from './dashboardPanel';
import { InitEntryKindsPanel } from './initEntryKindsPanel';
import { CreateEntryKindPanel } from './createEntryKindPanel';
import { InitMacroKindsPanel } from './initMacroKindsPanel';
import { CreateMacroKindPanel } from './createMacroKindPanel';
import { CreateEntryPanel } from './createEntryPanel';
import { CreateMacroPackagePanel } from './createMacroPackagePanel';
import { PackagePanel } from './packagePanel';
import { CreateMacroPanel } from './createMacroPanel';
import { initSnlDoc } from './snlDoc';
import { firstWorkspaceFolder } from './panelUtil';

// TODO: import SNL_render from snl-script lib

/** Regex for safe bare package filenames (path-traversal guard). */
const MACRO_FILE_RE = /^[a-zA-Z0-9_-]+(\.json)?$/;

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

  // No palette entry (see package.json `when: false`): invoked via
  // executeCommand('snlDoc.openEntryInfoview', entryId) from a Ctrl+click on
  // an EntryRender title or a hover popover.
  const openEntryInfoview = vscode.commands.registerCommand(
    'snlDoc.openEntryInfoview',
    (entryId?: unknown) => {
      if (typeof entryId !== 'string' || !entryId.trim()) {
        return;
      }
      InfoviewPanel.createOrShowForEntry(context.extensionUri, entryId.trim());
    }
  );

  // Manual refresh — force every open Infoview panel (browser + per-entry)
  // to re-fetch its data from disk. The auto-refresh watcher covers the
  // usual write paths (Dashboard save, .SNL_Doc/* edits) but doesn't catch
  // out-of-band writes like `git pull` or external scripts that mutate
  // `.SNL_Doc/`. Cat 2026-07-09.
  const refreshInfoview = vscode.commands.registerCommand(
    'snlDoc.refreshInfoview',
    () => {
      void InfoviewPanel.refreshAll();
    }
  );

  const init = vscode.commands.registerCommand('snlDoc.init', runInit);

  const createLibrary = vscode.commands.registerCommand(
    'snlDoc.createLibrary',
    () => {
      CreateLibraryPanel.createOrShow(context.extensionUri);
    }
  );

  // Edit by slug. Slug validation is intentionally light — we trust it
  // because it comes either from the Dashboard's overview (i.e. from disk)
  // or from the user's own config. The panel re-verifies existence when
  // reading context.
  const editLibrary = vscode.commands.registerCommand(
    'snlDoc.editLibrary',
    (slug?: unknown) => {
      if (typeof slug !== 'string' || !slug.trim()) {
        return;
      }
      CreateLibraryPanel.editOrShow(context.extensionUri, slug.trim());
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

  const editEntryKind = vscode.commands.registerCommand(
    'snlDoc.editEntryKind',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateEntryKindPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const initMacroKinds = vscode.commands.registerCommand(
    'snlDoc.initMacroKinds',
    () => {
      InitMacroKindsPanel.createOrShow(context.extensionUri);
    }
  );

  const createMacroKind = vscode.commands.registerCommand(
    'snlDoc.createMacroKind',
    () => {
      CreateMacroKindPanel.createOrShow(context.extensionUri);
    }
  );

  const editMacroKind = vscode.commands.registerCommand(
    'snlDoc.editMacroKind',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateMacroKindPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const createEntry = vscode.commands.registerCommand(
    'snlDoc.createEntry',
    () => {
      CreateEntryPanel.createOrShow(context.extensionUri);
    }
  );

  const editEntry = vscode.commands.registerCommand(
    'snlDoc.editEntry',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateEntryPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const createMacroPackage = vscode.commands.registerCommand(
    'snlDoc.createMacroPackage',
    () => {
      CreateMacroPackagePanel.createOrShow(context.extensionUri);
    }
  );

  const editMacroPackage = vscode.commands.registerCommand(
    'snlDoc.editMacroPackage',
    (file?: unknown) => {
      if (typeof file !== 'string' || !MACRO_FILE_RE.test(file)) {
        return;
      }
      CreateMacroPackagePanel.editOrShow(context.extensionUri, file);
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
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to open macro package with unsafe name: "${file}".`
        );
        return;
      }
      PackagePanel.createOrShow(context.extensionUri, file);
    }
  );

  // No palette entry: invoked via executeCommand('snlDoc.createMacro', file)
  // from a PackagePanel's "+ Create Macro" bar.
  const createMacro = vscode.commands.registerCommand(
    'snlDoc.createMacro',
    (file?: unknown) => {
      if (typeof file !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to create a macro in package with unsafe name: "${file}".`
        );
        return;
      }
      CreateMacroPanel.createOrShow(context.extensionUri, file);
    }
  );

  // No palette entry: invoked via executeCommand('snlDoc.editMacro', file, macroName)
  // from a PackagePanel's clickable macro row.
  const editMacro = vscode.commands.registerCommand(
    'snlDoc.editMacro',
    (file?: unknown, macroName?: unknown) => {
      if (typeof file !== 'string' || typeof macroName !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(
          `Refusing to edit a macro in package with unsafe name: "${file}".`
        );
        return;
      }
      if (!macroName.trim()) {
        return;
      }
      CreateMacroPanel.editOrShow(context.extensionUri, file, macroName.trim());
    }
  );

  context.subscriptions.push(
    openInfoview,
    openEntryInfoview,
    refreshInfoview,
    init,
    createLibrary,
    editLibrary,
    openDashboard,
    initEntryKinds,
    createEntryKind,
    editEntryKind,
    initMacroKinds,
    createMacroKind,
    editMacroKind,
    createEntry,
    editEntry,
    createMacroPackage,
    editMacroPackage,
    openMacroPackage,
    createMacro,
    editMacro
  );
}

export function deactivate(): void {
  // no-op
}
