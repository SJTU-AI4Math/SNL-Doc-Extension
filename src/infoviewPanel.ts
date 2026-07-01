import * as vscode from 'vscode';
import {
  readEntries,
  readEntryKinds,
  type EntryData,
  type EntryKind
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Singleton manager for the SNL Infoview webview panel.
 *
 * The Infoview is the READING surface (renders SNL documents). Compare with
 * {@link DashboardPanel}, which is the *management* surface.
 *
 * Creates (or reveals an existing) webview panel in the Beside column and
 * loads the Vite-built `main.js` bundle. HTML boilerplate (CSP / nonce /
 * optional CSS link) is shared via {@link buildPanelHtml}.
 *
 * Message protocol with the webview (`main.js`):
 *  - in  : `{ type: 'ready' }`                 → reply with `entries`
 *        | `{ type: 'selectEntry', id }`       → reply with `entryDetails`
 *        | `{ type: 'log', level, msg }`       → forward to the output channel
 *  - out : `{ type: 'entries', entries: EntryOption[] }`
 *        | `{ type: 'entryDetails', entry: EntryData, kind: EntryKind | null }`
 */
export class InfoviewPanel {
  public static currentPanel: InfoviewPanel | undefined;

  private static readonly viewType = 'snlInfoview';
  private static output: vscode.OutputChannel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (InfoviewPanel.currentPanel) {
      InfoviewPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InfoviewPanel.viewType,
      'SNL Infoview',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InfoviewPanel.currentPanel = new InfoviewPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'main',
      'SNL Infoview'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private static getOutput(): vscode.OutputChannel {
    if (!InfoviewPanel.output) {
      InfoviewPanel.output = vscode.window.createOutputChannel('SNL Infoview');
    }
    return InfoviewPanel.output;
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; id?: string; level?: string; msg?: string }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    switch (msg.type) {
      case 'ready':
        await this.pushEntries();
        return;
      case 'selectEntry':
        if (typeof msg.id === 'string') {
          await this.pushEntryDetails(msg.id);
        }
        return;
      case 'log': {
        // Log-only: surface consumer-injected hook events (e.g. onHover) in
        // the output channel without spamming toasts.
        const level = typeof msg.level === 'string' ? msg.level : 'info';
        const text = typeof msg.msg === 'string' ? msg.msg : '';
        InfoviewPanel.getOutput().appendLine(`[${level}] ${text}`);
        return;
      }
      default:
        return;
    }
  }

  /** Send the picker list: every entry, flagged by whether it has SNL content. */
  private async pushEntries(): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'entries', entries: [] });
      return;
    }
    try {
      const entries = await readEntries(root);
      const options = entries
        .filter(
          (e) =>
            typeof e.content?.snl === 'string' &&
            e.content.snl.trim().length > 0
        )
        .map((e) => ({ id: e.id, title: e.title, hasContent: true }));
      void this.panel.webview.postMessage({
        type: 'entries',
        entries: options
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to read entries: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'entries', entries: [] });
    }
  }

  /** Look up one entry by id + resolve its kind, and send back the details. */
  private async pushEntryDetails(id: string): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      return;
    }
    try {
      const entries = await readEntries(root);
      const entry: EntryData | undefined = entries.find((e) => e.id === id);
      if (!entry) {
        return;
      }
      const kinds = await readEntryKinds(root);
      const kind: EntryKind | null =
        kinds.find((k) => k.id === entry.kind) ?? null;
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry,
        kind
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to load entry: ${text}`
      );
    }
  }

  public dispose(): void {
    InfoviewPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
