import * as vscode from 'vscode';
import {
  listLibraries,
  readAllMacros,
  readEntries,
  readEntryKinds,
  readLibraryGraph,
  type EntryData,
  type EntryKind,
  type LibraryEntry,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Manager for the SNL Infoview webview panels.
 *
 * The Infoview is the READING surface (renders SNL documents). Compare with
 * {@link DashboardPanel}, which is the *management* surface. Per cat
 * 2026-07-06 design: reader-facing browsing surface is a 3-layer drill-down
 *   Libraries list → Entries in a library → single entry render
 * with a top-right "Edit in Dashboard" button that jumps to the management
 * surface, and a Back button to walk the stack back up.
 *
 * There are two panel flavours, both hosted by this one class:
 *  - the **browser** (singleton, {@link createOrShow}) — loads the `main`
 *    bundle. Starts on the Libraries list. Selecting a library shows its
 *    entries; selecting an entry renders it inline. Ctrl+clicking a rendered
 *    entry title spawns a dedicated per-entry panel.
 *  - the **per-entry** panels (multi-instance, {@link createOrShowForEntry},
 *    keyed by entryId in {@link panels}) — one dedicated tab per entry that
 *    loads the `entryInfoview` bundle and renders a single Entry.
 *
 * HTML boilerplate (CSP / nonce / optional CSS link) is shared via
 * {@link buildPanelHtml}.
 *
 * Message protocol with the browser webview (`main` bundle):
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'selectLibrary', slug }`
 *        | `{ type: 'selectEntry', id }`
 *        | `{ type: 'back' }`
 *        | `{ type: 'openDashboard' }`
 *        | `{ type: 'openDashboardForEntry', entryId }`
 *        | `{ type: 'openEntryInfoview', entryId }`
 *        | `{ type: 'requestEntryDetails', entryId }`
 *        | `{ type: 'log', level, msg }`
 *  - out : `{ type: 'libraries', libraries }`
 *        | `{ type: 'libraryEntries', slug, title, description?, entries, macros, warnings }`
 *        | `{ type: 'entryDetails', slug?, entry, kind, entries, macros }`
 *        | `{ type: 'popoverEntryDetails', entryId, entry, kind }`
 *
 * Message protocol with the per-entry webview (`entryInfoview` bundle) is
 * unchanged: expects `entryDetails` with the full entry pool + macros.
 */
export class InfoviewPanel {
  /** The single browser instance (loads `main`), or undefined when closed. */
  private static browserPanel: InfoviewPanel | undefined;
  /** Per-entry panels keyed by entryId (loads `entryInfoview`). */
  public static readonly panels = new Map<string, InfoviewPanel>();

  private static readonly browserViewType = 'snlInfoview';
  private static output: vscode.OutputChannel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  /** null → browser instance; non-null → dedicated panel for this entryId. */
  private readonly entryId: string | null;
  private disposables: vscode.Disposable[] = [];

  /** Open (or reveal) the singleton browser panel. */
  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Beside;

    if (InfoviewPanel.browserPanel) {
      InfoviewPanel.browserPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InfoviewPanel.browserViewType,
      'SNL Infoview',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InfoviewPanel.browserPanel = new InfoviewPanel(
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
          slug?: string;
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
          await this.pushLibraries();
        } else {
          await this.pushEntryDetailsForEntry(this.entryId);
        }
        return;
      case 'selectLibrary':
        if (this.entryId === null && typeof msg.slug === 'string' && msg.slug) {
          await this.pushLibraryEntries(msg.slug);
        }
        return;
      case 'selectEntry':
        if (this.entryId === null && typeof msg.id === 'string') {
          await this.pushEntryDetails(msg.id);
        }
        return;
      case 'back':
        // Client-driven navigation in the browser view. Host doesn't track
        // history; on 'back' from the entry view the webview re-requests the
        // library entries (needs slug it already knows), and 'back' from the
        // library view re-requests libraries. We just re-push the libraries
        // root on the assumption 'back' at the top of the stack means "go
        // home"; deeper back-steps are handled entirely in the webview.
        if (this.entryId === null) {
          await this.pushLibraries();
        }
        return;
      case 'openDashboard':
        // Jump to the management surface. Fire-and-forget; the Dashboard
        // command creates or reveals its own panel.
        void vscode.commands.executeCommand('snlDoc.openDashboard');
        return;
      case 'openDashboardForEntry':
        // Open the Dashboard and then jump to editing THIS entry (per cat
        // 2026-07-06 spec §"编辑界面也应有一个保存并回到浏览的按钮"). The Dashboard
        // command is what materializes the per-entry editor; we go through
        // its editEntry command so the two panels' UX matches.
        if (typeof msg.entryId === 'string' && msg.entryId.trim()) {
          void vscode.commands.executeCommand(
            'snlDoc.openDashboard'
          );
          void vscode.commands.executeCommand(
            'snlDoc.editEntry',
            msg.entryId.trim()
          );
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
      case 'requestEntryDetails':
        if (typeof msg.entryId === 'string' && msg.entryId.trim()) {
          await this.pushPopoverEntryDetails(msg.entryId.trim());
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

  /** Send the top-level Libraries list (layer 1 of 3). */
  private async pushLibraries(): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'libraries', libraries: [] });
      return;
    }
    try {
      const libraries = await listLibraries(root);
      void this.panel.webview.postMessage({ type: 'libraries', libraries });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to list libraries: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'libraries', libraries: [] });
    }
  }

  /**
   * Send the entries belonging to one Library (layer 2 of 3). "Belonging"
   * = the Entry-labelled nodes in `libraries/<slug>/graph.json`, resolved
   * to full EntryData via the shared pool. Entries that appear in the
   * graph but not in the shared pool are surfaced as warnings but still
   * listed (with a "missing entry" title) so cat can see what's dangling.
   */
  private async pushLibraryEntries(slug: string): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'libraryEntries',
        slug,
        title: slug,
        entries: [],
        macros: {},
        warnings: []
      });
      return;
    }

    try {
      const libraries = await listLibraries(root);
      const lib: LibraryEntry | undefined = libraries.find(
        (l) => l.slug === slug
      );
      const displayTitle = lib?.title ?? slug;
      const description = lib?.description;

      const graphResult = await readLibraryGraph(root, slug);
      const warnings: string[] = [];
      const graphEntryIds: string[] = [];
      if (graphResult.status === 'ok') {
        warnings.push(...graphResult.result.warnings);
        for (const node of graphResult.result.graph.nodes) {
          if (node.label !== 'Entry') continue;
          const entryId = node.props?.entryId;
          if (typeof entryId === 'string' && entryId) {
            graphEntryIds.push(entryId);
          }
        }
      } else if (graphResult.status === 'error') {
        warnings.push(graphResult.message);
      }

      // Resolve to full entry rows via the shared pool. Preserve the graph's
      // declaration order (v1 doesn't have a reading-order fold-in here — the
      // browser view just shows the list; ordering by numberFor() is a later
      // enhancement).
      const entryPool = await readEntries(root);
      const byId = new Map<string, EntryData>();
      for (const e of entryPool) {
        byId.set(e.id, e);
      }
      const entries = graphEntryIds
        .map((id) => byId.get(id))
        .filter((e): e is EntryData => e !== undefined)
        .map((e) => ({
          id: e.id,
          title: e.title,
          hasContent:
            typeof e.content?.snl === 'string' &&
            e.content.snl.trim().length > 0
        }));

      const macros = await this.readMacroDb();

      void this.panel.webview.postMessage({
        type: 'libraryEntries',
        slug,
        title: displayTitle,
        description,
        entries,
        macros,
        warnings
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to load library "${slug}": ${text}`
      );
      void this.panel.webview.postMessage({
        type: 'libraryEntries',
        slug,
        title: slug,
        entries: [],
        macros: {},
        warnings: [text]
      });
    }
  }

  /**
   * Load the flat name→macro map from `.SNL_Doc/term_macros/*.json`. Best
   * effort: returns `{}` when the workspace is missing or `readAllMacros`
   * throws (individual broken packages are already swallowed inside it).
   */
  private async readMacroDb(): Promise<Record<string, MacroPackageEntry>> {
    const root = firstWorkspaceFolder();
    if (!root) {
      return {};
    }
    try {
      return await readAllMacros(root);
    } catch {
      return {};
    }
  }

  /** Look up one entry by id + resolve its kind, and send back the details.
   *  Includes the full entry pool + macros so the render can link between
   *  entries via macro popovers. */
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
      const options = entries
        .filter(
          (e) =>
            typeof e.content?.snl === 'string' &&
            e.content.snl.trim().length > 0
        )
        .map((e) => ({ id: e.id, title: e.title, hasContent: true as const }));
      const macros = await this.readMacroDb();
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry,
        kind,
        entries: options,
        macros
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
        entries: [],
        macros: {}
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
      const macros = await this.readMacroDb();
      const entry: EntryData | undefined = entries.find((e) => e.id === id);
      if (!entry) {
        void this.panel.webview.postMessage({
          type: 'entryDetails',
          entry: null,
          kind: null,
          entries: options,
          macros
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
        entries: options,
        macros
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to load entry: ${text}`
      );
    }
  }

  /**
   * Popover preview payload: a single entry + its kind, echoed back with the
   * entryId so the requesting webview popover can match it. Distinct from
   * `entryDetails` so it never disturbs the browser's main selection.
   */
  private async pushPopoverEntryDetails(id: string): Promise<void> {
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
        type: 'popoverEntryDetails',
        entryId: id,
        entry,
        kind
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Infoview: failed to load popover entry: ${text}`
      );
    }
  }

  public dispose(): void {
    if (this.entryId === null) {
      InfoviewPanel.browserPanel = undefined;
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
