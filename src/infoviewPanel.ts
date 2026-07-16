import * as vscode from 'vscode';
import {
  listLibraries,
  readAllMacros,
  readEntries,
  readEntryKinds,
  readLibraryGraph,
  readRelationships,
  type EntryData,
  type EntryKind,
  type LibraryEntry,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';
import {
  numberFor,
  type LibraryGraph,
  type GraphNode
} from './libraryGraph';

/**
 * One node in the outline tree pushed to the webview for the Library page
 * (layer 2). Materialises everything the webview needs to render an entry in
 * place — full entry data, resolved kind, computed counter label, and its
 * child subtree — so the client doesn't have to re-resolve anything.
 *
 * `entry` is null for placeholder nodes (graph node with no entryId, or an
 * entryId that doesn't resolve in the shared pool). The webview shows those
 * as a stub so the outline tree is still fully visible.
 */
interface OutlineNode {
  nodeId: string;
  entry: EntryData | null;
  kind: EntryKind | null;
  counterLabel: string | null;
  children: OutlineNode[];
}

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
  /**
   * Browser-mode navigation memory: the slug the webview last requested via
   * `selectLibrary`. `null` means the webview is on the Library-list root
   * (never selected a library, or navigated 'back' out of one). Used only
   * by the auto-refresh path — the webview drives normal navigation.
   */
  private currentLibrarySlug: string | null = null;
  private disposables: vscode.Disposable[] = [];

  /** Open (or reveal) the singleton browser panel. */
  /**
   * Show the browser Infoview. When `initialLibrarySlug` is provided, the
   * panel opens directly on that library's outline (used by
   * `CreateLibrary`'s "View in Infoview" nav button — cat 2026-07-09).
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    initialLibrarySlug?: string
  ): void {
    const column = vscode.ViewColumn.Beside;

    if (InfoviewPanel.browserPanel) {
      InfoviewPanel.browserPanel.panel.reveal(column);
      if (initialLibrarySlug) {
        // Navigate the already-open panel to the requested library.
        InfoviewPanel.browserPanel.currentLibrarySlug = initialLibrarySlug;
        void InfoviewPanel.browserPanel.pushLibraryEntries(initialLibrarySlug);
      }
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

    const instance = new InfoviewPanel(
      panel,
      extensionUri,
      null,
      'main',
      'SNL Infoview'
    );
    InfoviewPanel.browserPanel = instance;
    if (initialLibrarySlug) {
      // Wait a tick for the webview to send `ready` — the webview's own
      // context initialization will then call pushLibraries; we override
      // by seeding the slug so the very first push is the library page.
      instance.currentLibrarySlug = initialLibrarySlug;
    }
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

    this.installWatcher();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Watch `.SNL_Doc/` for relevant JSON changes and re-push the current view.
   *
   * Cat 2026-07-09: Infoview's browser mode (Library outline) and per-Entry
   * mode both went stale when the Dashboard / VS Code editor wrote to
   * `entries.json`, `graph.json`, `config.json`, or `term_macros/*.json` —
   * user had to close and reopen the panel to see updates. Mirrors the
   * DashboardPanel / PackagePanel watcher pattern (same globs, same three
   * event bindings).
   *
   * Refresh strategy: re-push whatever the panel is currently showing.
   *   - Per-entry panel (entryId !== null): re-push that entry's details.
   *   - Browser panel (entryId === null): we don't track which page the
   *     webview is on (Library list vs Library outline), so we re-push the
   *     Library list — the webview's back-button handler already treats
   *     'root push' as "go home from wherever". This is intentionally
   *     coarser than the Dashboard's refresh: cat can always click into a
   *     Library again to see the updated outline.
   */
  private installWatcher(): void {
    const root = firstWorkspaceFolder();
    if (!root) {
      return;
    }
    // Same coverage as DashboardPanel — narrow enough to not fire on every
    // webview build write, broad enough to catch all data the panel reads.
    const patterns: vscode.GlobPattern[] = [
      new vscode.RelativePattern(root, '.SNL_Doc/config.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/entries.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/relationships.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*/graph.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*/meta.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*'),
      new vscode.RelativePattern(root, '.SNL_Doc/term_macros/*.json'),
      new vscode.RelativePattern(root, '.SNL_Doc')
    ];

    const refresh = (): void => {
      void this.refresh();
    };

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(refresh, null, this.disposables);
      watcher.onDidChange(refresh, null, this.disposables);
      watcher.onDidDelete(refresh, null, this.disposables);
      this.disposables.push(watcher);
    }
  }

  /**
   * Re-push whatever this panel is currently showing. Called by the file
   * watcher and by the manual `SNL: Refresh Infoview` command. Safe to call
   * on a disposed panel — the webview.postMessage no-ops after dispose.
   */
  public async refresh(): Promise<void> {
    if (this.entryId !== null) {
      // Per-entry panel: re-push that entry's details.
      await this.pushEntryDetailsForEntry(this.entryId);
      return;
    }
    // Browser panel: preserve the user's spot in the 2-layer stack.
    //   - If they'd selected a library → re-push that library's outline
    //     (does NOT reset the webview's route; webview treats the
    //     'libraryEntries' message the same whether it's initial or a
    //     refresh, so scroll position is preserved).
    //   - Otherwise → re-push the Library list (root).
    if (this.currentLibrarySlug) {
      await this.pushLibraryEntries(this.currentLibrarySlug);
    } else {
      await this.pushLibraries();
    }
  }

  /**
   * Refresh every open Infoview panel. Used by the `SNL: Refresh Infoview`
   * command so a single keystroke updates both browser and per-entry views
   * without the user having to focus each one.
   */
  public static async refreshAll(): Promise<void> {
    const panels: InfoviewPanel[] = [];
    if (InfoviewPanel.browserPanel) {
      panels.push(InfoviewPanel.browserPanel);
    }
    for (const p of InfoviewPanel.panels.values()) {
      panels.push(p);
    }
    await Promise.all(panels.map((p) => p.refresh()));
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
          this.currentLibrarySlug = msg.slug;
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
          // Webview navigated 'back' to the Library-list root, so clear
          // the remembered slug — the auto-refresh path should no longer
          // treat this panel as sitting inside a library outline.
          this.currentLibrarySlug = null;
          await this.pushLibraries();
        }
        return;
      case 'openDashboard':
        // Jump to the management surface. Fire-and-forget; the Dashboard
        // command creates or reveals its own panel.
        void vscode.commands.executeCommand('snlDoc.openDashboard');
        return;
      case 'editLibrary':
        // Cat 2026-07-09: from a Library's Infoview page, "Edit this
        // Library" should open THAT library's editor directly — not the
        // Dashboard root the user would then have to click through.
        if (typeof msg.slug === 'string' && msg.slug.trim()) {
          void vscode.commands.executeCommand(
            'snlDoc.editLibrary',
            msg.slug.trim()
          );
        }
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
      case 'revealPointer':
        // Cat 2026-07-11: entry pointer jump-to-source button.
        if (typeof msg.entryId === 'string' && msg.entryId.trim()) {
          void vscode.commands.executeCommand(
            'snlDoc.revealEntryPointer',
            msg.entryId.trim()
          );
        }
        return;
      case 'editEntry':
        // Cat 2026-07-10 §2: per-entry panel edit button.
        if (typeof msg.entryId === 'string' && msg.entryId.trim()) {
          void vscode.commands.executeCommand(
            'snlDoc.editEntry',
            msg.entryId.trim()
          );
        }
        return;
      case 'openInfoviewGraph':
        void vscode.commands.executeCommand('snlDoc.openInfoviewGraph');
        return;
      case 'openInfoviewGraphForLibrary':
        if (typeof msg.slug === 'string' && msg.slug.trim()) {
          void vscode.commands.executeCommand(
            'snlDoc.openInfoviewGraphForLibrary',
            msg.slug.trim()
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
   * Send the entries belonging to one Library (layer 2 of 3). Ships:
   *  - `entries`: the flat picker pool (id / title / hasContent) — legacy
   *    field kept for popover source resolution etc.
   *  - `outline`: DFS-ordered outline tree with each node carrying its full
   *    EntryData + resolved kind + computed counter label, so the webview
   *    can render every entry inline with proper numbering. Placeholder
   *    nodes (no entryId or unresolved entryId) get `entry: null` so the
   *    tree structure stays intact.
   *
   * Warnings from `readLibraryGraph` and per-node resolution failures both
   * feed into the `warnings` list.
   */
  private async pushLibraryEntries(slug: string): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'libraryEntries',
        slug,
        title: slug,
        entries: [],
        outline: [],
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
      let graph: LibraryGraph = { nodes: [], relationships: [] };
      if (graphResult.status === 'ok') {
        warnings.push(...graphResult.result.warnings);
        graph = graphResult.result.graph;
      } else if (graphResult.status === 'error') {
        warnings.push(graphResult.message);
      }

      // Shared pool + kinds for entry / kind / counter resolution.
      const entryPool = await readEntries(root);
      const kinds = await readEntryKinds(root);
      const entriesById = new Map<string, EntryData>();
      for (const e of entryPool) {
        entriesById.set(e.id, e);
      }
      const kindsById = new Map<string, EntryKind>();
      for (const k of kinds) {
        kindsById.set(k.id, k);
      }

      // Legacy flat pool (order = graph declaration order for Entry nodes).
      // Cat 2026-07-09 Stage 1 lookup: include content.snl so the webview
      // can build the cross-entry `x@foo` bvar-upgrade index. hasContent
      // stays for callers that only care about non-emptiness.
      const flatEntries: {
        id: string;
        title: string;
        hasContent: boolean;
        snl?: string;
      }[] = [];
      for (const node of graph.nodes) {
        if (node.label !== 'Entry') continue;
        const entryId = node.props?.entryId;
        if (typeof entryId !== 'string' || !entryId) continue;
        const e = entriesById.get(entryId);
        if (!e) continue;
        const snl = typeof e.content?.snl === 'string' ? e.content.snl : '';
        flatEntries.push({
          id: e.id,
          title: e.title,
          hasContent: snl.trim().length > 0,
          snl: snl || undefined
        });
      }

      // Build the outline tree. numberFor needs the same graph + pool +
      // kinds inputs, so hand them straight through — a thin view of each.
      const entryKindRefById = new Map<string, { kind?: string }>();
      for (const [id, e] of entriesById) {
        entryKindRefById.set(id, { kind: e.kind });
      }
      const kindNumberingById = new Map<string, { numbering: string }>();
      for (const [id] of kindsById) {
        // 2026-07-16: EntryKind.numbering was renamed to defaultCounterName
        // (a counter NAME, not a DSL). The numbering engine still takes a
        // per-kind DSL view here; it is rewired to consume the library's
        // counter tree in a follow-up (Commit 3). Until then, no per-kind
        // DSL source exists, so the template falls back to the engine
        // default ('.1').
        kindNumberingById.set(id, { numbering: '' });
      }
      const outline = buildOutline(
        graph,
        entriesById,
        kindsById,
        entryKindRefById,
        kindNumberingById,
        warnings
      );

      const macros = await this.readMacroDb();

      void this.panel.webview.postMessage({
        type: 'libraryEntries',
        slug,
        title: displayTitle,
        description,
        entries: flatEntries,
        outline,
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
        outline: [],
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
        .map((e) => ({
          id: e.id,
          title: e.title,
          hasContent: true as const,
          // Cat 2026-07-09 Stage 1 lookup: include snl so webview's
          // buildContextIndex can flip `x@foo` fvars to bvar.
          snl: e.content?.snl
        }));
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
        .map((e) => ({
          id: e.id,
          title: e.title,
          hasContent: true as const,
          // Cat 2026-07-09 Stage 1 lookup: include snl so webview's
          // buildContextIndex can flip `x@foo` fvars to bvar.
          snl: e.content?.snl
        }));
      const macros = await this.readMacroDb();
      const entry: EntryData | undefined = entries.find((e) => e.id === id);
      if (!entry) {
        void this.panel.webview.postMessage({
          type: 'entryDetails',
          entry: null,
          kind: null,
          entries: options,
          macros,
          relatedEntries: null
        });
        return;
      }
      this.panel.title = `SNL — ${entry.title}`;
      const kinds = await readEntryKinds(root);
      const kind: EntryKind | null =
        kinds.find((k) => k.id === entry.kind) ?? null;
      // Cat 2026-07-10 §2: single-Entry panel now surfaces two
      // collapsible lists — the entries providing CONTEXT bindings
      // (uses_context edges FROM this entry) and the entries this
      // entry DEPENDS on (depends edges FROM this entry). Rows outgoing
      // from `id` win: cat's rule is "下面的条目依赖上面的" so we list
      // things this entry consumes, sorted by title.
      let relatedEntries: {
        context: Array<{ id: string; title: string; kindId?: string }>;
        dependencies: Array<{
          id: string;
          title: string;
          kindId?: string;
          isAtomic: boolean | null;
        }>;
      } = { context: [], dependencies: [] };
      try {
        const rels = await readRelationships(root);
        const byId = new Map(entries.map((e) => [e.id, e]));
        const ctxRows: typeof relatedEntries.context = [];
        const depRows: typeof relatedEntries.dependencies = [];
        const seenCtx = new Set<string>();
        const seenDep = new Set<string>();
        for (const r of rels) {
          if (r.from !== id) continue;
          const target = byId.get(r.to);
          if (!target) continue;
          if (r.label === 'uses_context' && !seenCtx.has(r.to)) {
            seenCtx.add(r.to);
            ctxRows.push({
              id: target.id,
              title: target.title ?? '',
              kindId: target.kind
            });
          } else if (r.label === 'depends' && !seenDep.has(r.to)) {
            seenDep.add(r.to);
            const isAtomic =
              r.metadata &&
              typeof r.metadata === 'object' &&
              typeof (r.metadata as { isAtomic?: unknown }).isAtomic === 'boolean'
                ? (r.metadata as { isAtomic: boolean }).isAtomic
                : null;
            depRows.push({
              id: target.id,
              title: target.title ?? '',
              kindId: target.kind,
              isAtomic
            });
          }
        }
        ctxRows.sort((a, b) => a.title.localeCompare(b.title));
        depRows.sort((a, b) => a.title.localeCompare(b.title));
        relatedEntries = { context: ctxRows, dependencies: depRows };
      } catch {
        // relationships.json missing/malformed → empty lists, no crash.
      }
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry,
        kind,
        entries: options,
        macros,
        relatedEntries
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
        // Cat 2026-07-10: cross-library hover should still resolve
        // against the shared pool — but if the id genuinely doesn't
        // exist we tell the webview so it can render a "not found"
        // popover instead of spinning on "Loading…" forever.
        void this.panel.webview.postMessage({
          type: 'popoverEntryDetails',
          entryId: id,
          entry: null,
          kind: null
        });
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

// ---------------------------------------------------------------------------
// Outline construction (Library page tree)
// ---------------------------------------------------------------------------

/**
 * Build the DFS outline tree used by the Library page. Nodes are visited in
 * `graph.nodes[]` declaration order for roots and `graph.relationships[]`
 * declaration order for children — same rule as `readingOrder` in
 * {@link ./libraryGraph}. Orphan Entry nodes (had a parent that doesn't
 * exist) are appended after the roots so no entry silently disappears.
 *
 * `entriesById` maps shared-pool entryId -> EntryData (source of truth for
 * title / kind id / content). `kindsById` maps kind.id -> EntryKind (for
 * palette + numbering template).
 *
 * Unresolvable entries (graph node has an entryId but the pool doesn't
 * have it) push a warning; the outline still emits a stub node with
 * `entry: null` so the tree structure survives.
 */
function buildOutline(
  graph: LibraryGraph,
  entriesById: Map<string, EntryData>,
  kindsById: Map<string, EntryKind>,
  entryKindRefById: Map<string, { kind?: string }>,
  kindNumberingById: Map<string, { numbering: string }>,
  warnings: string[]
): OutlineNode[] {
  const nodesById = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    nodesById.set(n.id, n);
  }
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const r of graph.relationships) {
    if (r.label !== 'branch') continue;
    const list = childrenOf.get(r.from);
    if (list) {
      list.push(r.to);
    } else {
      childrenOf.set(r.from, [r.to]);
    }
    if (!parentOf.has(r.to)) {
      parentOf.set(r.to, r.from);
    }
  }

  const visited = new Set<string>();

  const buildNode = (nodeId: string): OutlineNode | null => {
    if (visited.has(nodeId)) return null; // defensive: cycles / dupes
    visited.add(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) return null;

    let entry: EntryData | null = null;
    let kind: EntryKind | null = null;
    const entryId = node.props?.entryId;
    if (typeof entryId === 'string' && entryId) {
      const resolved = entriesById.get(entryId);
      if (resolved) {
        entry = resolved;
        kind = kindsById.get(resolved.kind) ?? null;
      } else {
        warnings.push(
          `Entry "${entryId}" referenced by node "${nodeId}" not found in shared pool`
        );
      }
    }

    const counterLabel = numberFor(
      graph,
      nodeId,
      entryKindRefById,
      kindNumberingById
    );

    const childIds = childrenOf.get(nodeId) ?? [];
    const children: OutlineNode[] = [];
    for (const cid of childIds) {
      const built = buildNode(cid);
      if (built) children.push(built);
    }

    return {
      nodeId,
      entry,
      kind,
      counterLabel,
      children
    };
  };

  const roots: OutlineNode[] = [];
  // Root pass: nodes[] declaration order, taking only nodes with no branch
  // parent — matches the numbering engine's root-ordering rule.
  for (const n of graph.nodes) {
    if (parentOf.has(n.id)) continue;
    const built = buildNode(n.id);
    if (built) roots.push(built);
  }
  // Orphan pass: Entry nodes with a parent that doesn't exist in nodes[]
  // wouldn't have been reached — append them so the tree isn't lossy.
  for (const n of graph.nodes) {
    if (visited.has(n.id)) continue;
    const built = buildNode(n.id);
    if (built) roots.push(built);
  }
  return roots;
}
