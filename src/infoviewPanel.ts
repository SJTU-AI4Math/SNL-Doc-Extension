import * as vscode from 'vscode';
import {
  readEntries,
  readEntryKinds,
  type EntryData,
  type EntryKind
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Manager for the SNL Infoview webview panels.
 *
 * The Infoview is the READING surface (renders SNL documents). Compare with
 * {@link DashboardPanel}, which is the *management* surface.
 *
 * There are two panel flavours, both hosted by this one class:
 *  - the **picker** (singleton, {@link createOrShow}) — a directory of every
 *    entry that loads the `main` bundle. Selecting an entry renders it inline;
 *    Ctrl+clicking a rendered title spawns a dedicated per-entry panel.
 *  - the **per-entry** panels (multi-instance, {@link createOrShowForEntry},
 *    keyed by entryId in {@link panels}) — one dedicated tab per entry that
 *    loads the `entryInfoview` bundle and renders a single Entry.
 *
 * HTML boilerplate (CSP / nonce / optional CSS link) is shared via
 * {@link buildPanelHtml}.
 *
 * Message protocol with the webview:
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'selectEntry', id }`            (picker only)
 *        | `{ type: 'openEntryInfoview', entryId }` (spawn per-entry panel)
 *        | `{ type: 'log', level, msg }`            → forward to output channel
 *  - out : `{ type: 'entries', entries: EntryOption[] }`                (picker)
 *        | `{ type: 'entryDetails', entry, kind }`                      (picker)
 *        | `{ type: 'entryDetails', entry, kind, entries }`             (per-entry)
 */
export class InfoviewPanel {
  /** The single picker instance (loads `main`), or undefined when closed. */
  private static pickerPanel: InfoviewPanel | undefined;
  /** Per-entry panels keyed by entryId (loads `entryInfoview`). */
  public static readonly panels = new Map<string, InfoviewPanel>();

  private static readonly pickerViewType = 'snlInfoview';
  private static output: vscode.OutputChannel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  /** null → picker instance; non-null → dedicated panel for this entryId. */
  private readonly entryId: string | null;
  private disposables: vscode.Disposable[] = [];

  /** Open (or reveal) the singleton picker panel. */
  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (InfoviewPanel.pickerPanel) {
      InfoviewPanel.pickerPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InfoviewPanel.pickerViewType,
      'SNL Infoview',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InfoviewPanel.pickerPanel = new InfoviewPanel(
      panel,
      extensionUri,
      null,
      'main',
      'SNL Infoview'
    );
  }

  /**
   * Open (or reveal) the dedicated panel for a single entry. One panel per
   * entryId; re-invoking reveals the existing panel instead of spawning a
   * duplicate. The tab title is refreshed to the resolved entry title once the
   * webview asks for details (falls back to the entryId until then).
   */
  public static createOrShowForEntry(
    extensionUri: vscode.Uri,
    entryId: string
  ): void {
    const existing = InfoviewPanel.panels.get(entryId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      `snlInfoview.entry.${entryId}`,
      `SNL — ${entryId}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    const instance = new InfoviewPanel(
      panel,
      extensionUri,
      entryId,
      'entryInfoview',
      `SNL — ${entryId}`
    );
    InfoviewPanel.panels.set(entryId, instance);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    entryId: string | null,
    webviewEntry: string,
    title: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.entryId = entryId;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      webviewEntry,
      title
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
      | {
          type?: string;
          id?: string;
          entryId?: string;
          level?: string;
          msg?: string;
        }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    switch (msg.type) {
      case 'ready':
        if (this.entryId === null) {
          await this.pushEntries();
        } else {
          await this.pushEntryDetailsForEntry(this.entryId);
        }
        return;
      case 'selectEntry':
        if (this.entryId === null && typeof msg.id === 'string') {
          await this.pushEntryDetails(msg.id);
        }
        return;
      case 'openEntryInfoview':
        if (typeof msg.entryId === 'string' && msg.entryId.trim()) {
          void vscode.commands.executeCommand(
            'snlDoc.openEntryInfoview',
            msg.entryId.trim()
          );
        }
        return;
      case 'log': {
        // Log-only: surface consumer-injected hook events in the output
        // channel without spamming toasts.
        const level = typeof msg.level === 'string' ? msg.level : 'info';
        const text = typeof msg.msg === 'string' ? msg.msg : '';
        InfoviewPanel.getOutput().appendLine(`[${level}] ${text}`);
        return;
      }
      default:
        return;
    }
  }

  /** Build the picker option list: every entry that has SNL content. */
  private async readEntryOptions(): Promise<
    { id: string; title: string; hasContent: true }[]
  > {
    const root = firstWorkspaceFolder();
    if (!root) {
      return [];
    }
    const entries = await readEntries(root);
    return entries
      .filter(
        (e) =>
          typeof e.content?.snl === 'string' && e.content.snl.trim().length > 0
      )
      .map((e) => ({ id: e.id, title: e.title, hasContent: true as const }));
  }

  /** Send the picker list: every entry, flagged by whether it has SNL content. */
  private async pushEntries(): Promise<void> {
    try {
      const options = await this.readEntryOptions();
      void this.panel.webview.postMessage({ type: 'entries', entries: options });
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

  /**
   * Per-entry panel payload: the single entry + its kind, PLUS the full entry
   * pool (so the webview's resolveSource can link macros to other entries).
   * Also refreshes the tab title to the resolved entry title.
   */
  private async pushEntryDetailsForEntry(id: string): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry: null,
        kind: null,
        entries: []
      });
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
        .map((e) => ({ id: e.id, title: e.title, hasContent: true as const }));
      const entry: EntryData | undefined = entries.find((e) => e.id === id);
      if (!entry) {
        void this.panel.webview.postMessage({
          type: 'entryDetails',
          entry: null,
          kind: null,
          entries: options
        });
        return;
      }
      this.panel.title = `SNL — ${entry.title}`;
      const kinds = await readEntryKinds(root);
      const kind: EntryKind | null =
        kinds.find((k) => k.id === entry.kind) ?? null;
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry,
        kind,
        entries: options
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to load entry: ${text}`
      );
    }
  }

  public dispose(): void {
    if (this.entryId === null) {
      InfoviewPanel.pickerPanel = undefined;
    } else {
      InfoviewPanel.panels.delete(this.entryId);
    }

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
