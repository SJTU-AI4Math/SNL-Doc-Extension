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
      const flatEntries: {
        id: string;
        title: string;
        hasContent: boolean;
      }[] = [];
      for (const node of graph.nodes) {
        if (node.label !== 'Entry') continue;
        const entryId = node.props?.entryId;
        if (typeof entryId !== 'string' || !entryId) continue;
        const e = entriesById.get(entryId);
        if (!e) continue;
        flatEntries.push({
          id: e.id,
          title: e.title,
          hasContent:
            typeof e.content?.snl === 'string' &&
            e.content.snl.trim().length > 0
        });
      }

      // Build the outline tree. numberFor needs the same graph + pool +
      // kinds inputs, so hand them straight through — a thin view of each.
      const entryKindRefById = new Map<string, { kind?: string }>();
      for (const [id, e] of entriesById) {
        entryKindRefById.set(id, { kind: e.kind });
      }
      const kindNumberingById = new Map<string, { numbering: string }>();
      for (const [id, k] of kindsById) {
        kindNumberingById.set(id, { numbering: k.numbering });
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
