import * as vscode from 'vscode';
import {
  readOverview,
  resolveActiveMacroPackages,
  setActiveMacroPackages
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';
import { readEntryMetricThresholds } from './entryMetricSettings';

/**
 * Singleton manager for the `SNL: Open Dashboard` webview panel.
 *
 * The Dashboard is the *management* surface for SNL Doc (in contrast to the
 * Infoview, which is the *reading* surface). It shows:
 *  - shared Entry pool size (`.SNL_Doc/entries.json` length),
 *  - per-library table (title + entry count + relationship count),
 *  - a "Create Library" button that dispatches `snlDoc.createLibrary`.
 *
 * When `.SNL_Doc/` is missing, the webview renders an initialization
 * placeholder pointing the user at `snlDoc.init`.
 *
 * Auto-refresh: a `FileSystemWatcher` on `.SNL_Doc/(config|entries).json`
 * and `.SNL_Doc/libraries/**​/graph.json` re-reads the overview and
 * pushes it to the webview. The watcher is created once per workspace folder
 * — multi-root projects only watch the first folder for now (matches the
 * single-folder assumption shared with init/create).
 *
 * Message protocol with the webview (`dashboard.js`):
 *  - in  : `{ type: 'ready' }` (initial pull)
 *        | `{ type: 'createLibrary' }` (button click)
 *        | `{ type: 'initEntryKinds' }` (empty-catalog seed button)
 *        | `{ type: 'createEntryKind' }` (add-one button)
 *        | `{ type: 'createEntry' }` (Entries → Create Entry)
 *        | `{ type: 'createMacroPackage' }` (SNL Macros → Add Package)
 *        | `{ type: 'openMacroPackage', file }` (SNL Macros → open row)
 *        | `{ type: 'init' }` (placeholder → init command)
 *  - out : `{ type: 'overview', overview: SnlOverview }`
 */
export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;

  private static readonly viewType = 'snlDashboard';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'SNL Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'dashboard',
      'SNL Dashboard'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.installWatcher();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('snlDoc.metrics')) {
          void this.pushOverview();
        }
      })
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Watch `.SNL_Doc/` for relevant JSON changes and refresh the panel.
   *
   * Patterns intentionally narrow: we don't watch every file under
   * `.SNL_Doc/` (would fire on every webview build write). The three patterns
   * cover everything `readOverview()` consumes.
   */
  private installWatcher(): void {
    const root = firstWorkspaceFolder();
    if (!root) {
      return;
    }
    const patterns: vscode.GlobPattern[] = [
      new vscode.RelativePattern(root, '.SNL_Doc/config.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/entries.json'),
      new vscode.RelativePattern(
        root,
        '.SNL_Doc/libraries/*/graph.json'
      ),
      new vscode.RelativePattern(
        root,
        '.SNL_Doc/libraries/*/meta.json'
      ),
      // Directory-level changes so paste / delete of a whole library dir
      // refreshes the Dashboard without requiring an inner-file touch.
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*'),
      // Macro packages: watch the whole term_macros tree (one file per pkg).
      new vscode.RelativePattern(root, '.SNL_Doc/term_macros/*.json'),
      // Pool-wide relationships file (cat 2026-07-10).
      new vscode.RelativePattern(root, '.SNL_Doc/relationships.json'),
      // Catch `.SNL_Doc/` itself appearing/disappearing.
      new vscode.RelativePattern(root, '.SNL_Doc')
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = (): void => {
        void this.pushOverview();
      };
      watcher.onDidCreate(refresh, null, this.disposables);
      watcher.onDidChange(refresh, null, this.disposables);
      watcher.onDidDelete(refresh, null, this.disposables);
      this.disposables.push(watcher);
    }
  }

  private async pushOverview(): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'overview',
        overview: { hasSnlDoc: false, totalEntryCount: null, libraries: [] }
      });
      return;
    }
    try {
      const overview = await readOverview(root);
      void this.panel.webview.postMessage({
        type: 'overview',
        overview: { ...overview, metricThresholds: readEntryMetricThresholds() }
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Dashboard refresh failed: ${text}`);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: string } | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        await this.pushOverview();
        return;
      case 'openGuiEditor':
        await vscode.commands.executeCommand('snlDoc.openGuiEditor');
        return;
      case 'createLibrary':
        await vscode.commands.executeCommand('snlDoc.createLibrary');
        return;
      case 'editLibrary': {
        const slug = (msg as { slug?: unknown }).slug;
        if (typeof slug === 'string' && slug) {
          await vscode.commands.executeCommand('snlDoc.editLibrary', slug);
        }
        return;
      }
      case 'initEntryKinds':
        await vscode.commands.executeCommand('snlDoc.initEntryKinds');
        return;
      case 'createEntryKind':
        await vscode.commands.executeCommand('snlDoc.createEntryKind');
        return;
      case 'editEntryKind': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.editEntryKind', id);
        }
        return;
      }
      case 'initMacroKinds':
        await vscode.commands.executeCommand('snlDoc.initMacroKinds');
        return;
      case 'createMacroKind':
        await vscode.commands.executeCommand('snlDoc.createMacroKind');
        return;
      case 'editMacroKind': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.editMacroKind', id);
        }
        return;
      }
      case 'createEntry':
        await vscode.commands.executeCommand('snlDoc.createEntry');
        return;
      case 'editEntry': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.editEntry', id);
        }
        return;
      }
      case 'createMacroPackage':
        await vscode.commands.executeCommand('snlDoc.createMacroPackage');
        return;
      case 'openMacroPackage': {
        const file = (msg as { file?: unknown }).file;
        if (typeof file === 'string') {
          await vscode.commands.executeCommand('snlDoc.openMacroPackage', file);
        }
        return;
      }
      case 'setPackageActive': {
        const m = msg as { file?: unknown; active?: unknown };
        if (typeof m.file === 'string' && m.file && typeof m.active === 'boolean') {
          await this.setPackageActive(m.file, m.active);
        }
        return;
      }
      case 'init':
        await vscode.commands.executeCommand('snlDoc.init');
        return;
      case 'openSnoogL': {
        // Cat 2026-07-13: Dashboard headers now carry TWO SNoogL entry
        // points — Entries row → entry search, SNL Macros row → macro
        // search. The message payload's optional `mode` steers which
        // tab the panel opens on.
        const rawMode = (msg as { mode?: unknown }).mode;
        const mode = rawMode === 'macro' || rawMode === 'entry' ? rawMode : undefined;
        await vscode.commands.executeCommand('snlDoc.openSnoogL', mode);
        return;
      }
      case 'createMacroPickPackage':
        // Cat 2026-07-13: SNL Macros header "+ Create Macro" button.
        // Delegates to a QuickPick-then-createMacro flow because
        // createMacro requires a target package file.
        await vscode.commands.executeCommand('snlDoc.createMacroPickPackage');
        return;
      // Delete forwarders (cat 2026-07-09). Dashboard rows now carry a
      // trash-icon action per entity; each posts its type + identifier
      // here and we hand off to the shared `snlDoc.delete*` command,
      // which owns the modal-confirmation UX.
      case 'deleteEntry': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.deleteEntry', id);
        }
        return;
      }
      case 'deleteEntryKind': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.deleteEntryKind', id);
        }
        return;
      }
      case 'deleteMacroKind': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.deleteMacroKind', id);
        }
        return;
      }
      case 'deleteLibrary': {
        const slug = (msg as { slug?: unknown }).slug;
        if (typeof slug === 'string' && slug) {
          await vscode.commands.executeCommand('snlDoc.deleteLibrary', slug);
        }
        return;
      }
      case 'deleteMacroPackage': {
        const file = (msg as { file?: unknown }).file;
        if (typeof file === 'string' && file) {
          await vscode.commands.executeCommand('snlDoc.deleteMacroPackage', file);
        }
        return;
      }
      case 'createRelationship':
        await vscode.commands.executeCommand('snlDoc.createRelationship');
        return;
      case 'editRelationship': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.editRelationship', id);
        }
        return;
      }
      case 'deleteRelationship': {
        const id = (msg as { id?: unknown }).id;
        if (typeof id === 'string' && id) {
          await vscode.commands.executeCommand('snlDoc.deleteRelationship', id);
        }
        return;
      }
      case 'openInfoview':
        // Dashboard → Infoview handoff (per cat 2026-07-06: reader/editor
        // toggle from either surface).
        await vscode.commands.executeCommand('snlDoc.openInfoview');
        return;
      case 'openInfoviewGraph':
        await vscode.commands.executeCommand('snlDoc.openInfoviewGraph');
        return;
      case 'regenerateDependencies':
        await vscode.commands.executeCommand('snlDoc.regenerateDependencies');
        return;
      default:
        return;
    }
  }

  /**
   * Add or remove a package from `config.json#active_macro_packages` and
   * re-push the overview so the Active column reflects the new state.
   */
  private async setPackageActive(file: string, active: boolean): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      return;
    }
    const bare = file.replace(/\.json$/i, '');
    try {
      const current = await resolveActiveMacroPackages(root);
      const set = new Set(current);
      if (active) {
        set.add(bare);
      } else {
        set.delete(bare);
      }
      await setActiveMacroPackages(root, Array.from(set));
      await this.pushOverview();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Dashboard: failed to update active packages: ${text}`
      );
    }
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
