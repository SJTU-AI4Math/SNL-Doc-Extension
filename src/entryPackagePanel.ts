import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import { entryBelongsToPackage, readEntryPackagePanelSnapshot } from './snlDoc';
import { packageManifestPath } from './entityStorage';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage, webviewLocalResourceRoots } from './panelUtil';
import { readEntryMetricThresholds } from './entryMetricSettings';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { extension_preferences_runtime } from './preferences';

const MESSAGES = defineHostMessages({
  title: 'SNL Entries — {package}', noWorkspace: 'No workspace folder is open.'
}, {
  title: 'SNL 条目 — {package}', noWorkspace: '未打开工作区文件夹。'
});
export function createEntryPackageHostTranslator(language: string) {
  return createHostTranslator(language, MESSAGES);
}
function t() { return createEntryPackageHostTranslator(extension_preferences_runtime.query_environment().language); }

/** Per-Package Entry management surface. Instances are keyed by stable Package id. */
export class EntryPackagePanel {
  private static readonly panels = new Map<string, EntryPackagePanel>();
  private static readonly viewType = 'snlEntryPackage';
  private readonly disposables: vscode.Disposable[] = [];
  private generation = 0;
  private disposed = false;

  public static createOrShow(extensionUri: vscode.Uri, packageId: string): void {
    const existing = this.panels.get(packageId);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel(this.viewType, t()('title', { package: packageId }), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewLocalResourceRoots(extensionUri)
    });
    bind_preferences_panel_title(panel, () => t()('title', { package: packageId }));
    this.panels.set(packageId, new EntryPackagePanel(panel, extensionUri, packageId));
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private readonly packageId: string) {
    panel.webview.html = buildPanelHtml(extensionUri, panel.webview, 'entryPackagePanel', t()('title', { package: packageId }), this.disposables);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    this.installWatcher();
    panel.onDidDispose(() => this.dispose(false), null, this.disposables);
  }

  private installWatcher(): void {
    const root = firstWorkspaceFolder();
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; if (!this.disposed) void this.pushPackage(); }, 120);
    };
    this.disposables.push({ dispose: () => { if (timer) clearTimeout(timer); } });
    const install = (glob: string, disposeOnDelete = false): void => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, glob));
      watcher.onDidCreate(refresh, null, this.disposables);
      watcher.onDidChange(refresh, null, this.disposables);
      watcher.onDidDelete(disposeOnDelete ? () => this.dispose() : refresh, null, this.disposables);
      this.disposables.push(watcher);
    };
    install(`.SNL_Doc/${packageManifestPath(this.packageId)}`);
    // Identity filenames end in one fixed 20-hex digest, so exactly twenty
    // single-character globs avoid prefix collisions such as a vs a-b.
    install(`.SNL_Doc/entries/${this.packageId}-${'?'.repeat(20)}.json`);
    install('.SNL_Doc/config.json');
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('snlDoc.metrics')) refresh();
    }));
  }

  private async pushPackage(): Promise<void> {
    const generation = ++this.generation;
    const root = firstWorkspaceFolder();
    if (!root) {
      if (this.disposed || generation !== this.generation) return;
      void this.panel.webview.postMessage({ type: 'error', message: t()('noWorkspace') });
      return;
    }
    try {
      const snapshot = await readEntryPackagePanelSnapshot(root, this.packageId);
      if (this.disposed || generation !== this.generation) return;
      if (snapshot.selected.status === 'noPackage') {
        void this.panel.webview.postMessage({ type: 'noEntryPackage', packageId: this.packageId });
        return;
      }
      void this.panel.webview.postMessage({
        type: 'entryPackage', package: snapshot.selected.package, entries: snapshot.selected.entries,
        entryKinds: snapshot.entryKinds, metricMacroSources: snapshot.metricMacroSources,
        metricThresholds: readEntryMetricThresholds()
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as { type?: unknown; id?: unknown } | undefined;
    if (!msg || typeof msg.type !== 'string') return;
    if (await handlePanelNavMessage(message, () => this.pushPackage())) return;
    if (msg.type === 'ready') await this.pushPackage();
    else if (msg.type === 'createEntry') {
      await vscode.commands.executeCommand('snlDoc.createEntry', undefined, this.packageId);
    } else if ((msg.type === 'editEntry' || msg.type === 'deleteEntry') &&
               typeof msg.id === 'string' && msg.id) {
      const root = firstWorkspaceFolder();
      if (!root || !(await entryBelongsToPackage(root, this.packageId, msg.id))) return;
      await vscode.commands.executeCommand(
        msg.type === 'editEntry' ? 'snlDoc.editEntry' : 'snlDoc.deleteEntry',
        msg.id,
        this.packageId
      );
    }
  }

  public dispose(disposePanel = true): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.generation;
    EntryPackagePanel.panels.delete(this.packageId);
    if (disposePanel) this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
