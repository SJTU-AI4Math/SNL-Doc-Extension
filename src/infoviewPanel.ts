import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  {
    browserTitle: 'SNL Infoview', outputChannel: 'SNL Infoview', entryTitle: 'SNL — {id}', deleteMacro: 'Delete macro “{name}” from package “{file}”?', cannotUndo: 'This cannot be undone.', delete: 'Delete', deleteMacroFailed: 'Delete macro failed: {error}', listLibrariesFailed: 'SNL Infoview: failed to list libraries: {error}', loadLibraryFailed: 'SNL Infoview: failed to load library “{slug}”: {error}', counterMissing: 'Entry node “{nodeId}” pins counterId “{counterId}” which is not in the counter tree; falling back to the kind’s default counter', loadEntryFailed: 'SNL Infoview: failed to load entry: {error}', loadPopoverFailed: 'SNL Infoview: failed to load popover entry: {error}', sharedEntryMissing: 'Entry “{entryId}” referenced by node “{nodeId}” not found in shared pool'
  },
  {
    browserTitle: 'SNL 信息视图', outputChannel: 'SNL 信息视图', entryTitle: 'SNL — {id}', deleteMacro: '要从包“{file}”中删除宏“{name}”吗？', cannotUndo: '此操作无法撤销。', delete: '删除', deleteMacroFailed: '删除宏失败：{error}', listLibrariesFailed: 'SNL 信息视图：无法列出库：{error}', loadLibraryFailed: 'SNL 信息视图：无法加载库“{slug}”：{error}', counterMissing: '条目节点“{nodeId}”指定的计数器 ID“{counterId}”不在计数器树中；将回退到该类型的默认计数器', loadEntryFailed: 'SNL 信息视图：无法加载条目：{error}', loadPopoverFailed: 'SNL 信息视图：无法加载弹出条目：{error}', sharedEntryMissing: '节点“{nodeId}”引用的条目“{entryId}”未在共享池中找到'
  }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
import {
  batchDeleteMacros,
  listLibraries,
  readAllMacros,
  readEntries,
  readEntryKinds,
  readLibraryCounters,
  readLibraryGraph,
  readMacroKinds,
  readAllMacrosWithOrigin,
  readRelationships,
  type EntryData,
  type EntryKind,
  type LibraryEntry,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handleWebviewTraceMessage } from './panelUtil';
import { ExportOptionsPanel, type ExportPayload } from './exportOptionsPanel';
import { countPanelOpen, startTrace, type Trace } from './trace';
import {
  numberFor,
  type CounterNode,
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

function infoviewLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  const roots = [vscode.Uri.joinPath(extensionUri, 'media')];
  const workspace = firstWorkspaceFolder();
  if (workspace) {
    roots.push(vscode.Uri.joinPath(workspace, '.SNL_Doc', 'assets'));
  }
  return roots;
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

  /** Open-path trace, so webview marks land on the same timeline. */
  public openTrace: Trace | undefined;
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
  private entryDisplayTitle: string | null = null;
  private disposables: vscode.Disposable[] = [];
  private viewGeneration = 0;
  private popoverGeneration = 0;

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
    // Cat 2026-07-26 CORRECTED the 07-25 premise: the Infoview is NOT fast on
    // first open. Verbatim: '首次开 Infoview -> Libraries 列表页面不快, 从
    // Libraries 进 单个 Library 的 Infoview 面板快.' What is fast is the
    // Infoview's INNER navigation, because drilling Libraries -> library ->
    // entry is a postMessage inside this already-live webview and never calls
    // createWebviewPanel. The ~1.09s is the cost of standing a webview up, and
    // this panel pays it exactly like every other one. Keep the trace so the
    // two remain comparable, but do not reason from 'the Infoview is special'.
    const trace = startTrace('infoview:open');
    const column = vscode.ViewColumn.Beside;

    if (InfoviewPanel.browserPanel) {
      InfoviewPanel.browserPanel.panel.reveal(column);
      trace.mark('reveal-existing');
      if (initialLibrarySlug) {
        // Navigate the already-open panel to the requested library.
        InfoviewPanel.browserPanel.currentLibrarySlug = initialLibrarySlug;
        void InfoviewPanel.browserPanel.pushLibraryEntries(initialLibrarySlug);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InfoviewPanel.browserViewType,
      hostText()('browserTitle'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: infoviewLocalResourceRoots(extensionUri)
      }
    );
    bind_preferences_panel_title(panel, () => hostText()('browserTitle'));

    trace.mark('webview-created', `panelsThisSession=${countPanelOpen()}`);
    const instance = new InfoviewPanel(
      panel,
      extensionUri,
      null,
      'main',
      hostText()('browserTitle')
    );
    instance.openTrace = trace;
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
      hostText()('entryTitle', { id: entryId }),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: infoviewLocalResourceRoots(extensionUri)
      }
    );
    const instance = new InfoviewPanel(
      panel,
      extensionUri,
      entryId,
      'entryInfoview',
      hostText()('entryTitle', { id: entryId })
    );
    bind_preferences_panel_title(panel, () => hostText()('entryTitle', {
      id: instance.entryDisplayTitle ?? entryId
    }));

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
    this.openTrace?.mark('html-set');

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
      new vscode.RelativePattern(root, '.SNL_Doc/entries/*.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/relationships.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*/graph.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*/meta.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/libraries/*'),
      new vscode.RelativePattern(root, '.SNL_Doc/term_macros/*.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/packages/*.json'),
      new vscode.RelativePattern(root, '.SNL_Doc/macros/*.json'),
      new vscode.RelativePattern(root, '.SNL_Doc')
    ];

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void this.refresh();
      }, 120);
    };
    this.disposables.push({ dispose: () => { if (refreshTimer) clearTimeout(refreshTimer); } });

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
      InfoviewPanel.output = vscode.window.createOutputChannel(hostText()('outputChannel'));
    }
    return InfoviewPanel.output;
  }

  public static disposeOutput(): void {
    InfoviewPanel.output?.dispose();
    InfoviewPanel.output = undefined;
  }

  private async handleMessage(message: unknown): Promise<void> {
    // Timing marks reported by the webview itself, folded into the open
    // trace so the Infoview and the editor panels are directly comparable.
    if (handleWebviewTraceMessage(message, this.openTrace)) return;
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
          if (this.currentLibrarySlug) {
            await this.pushLibraryEntries(this.currentLibrarySlug);
          } else {
            await this.pushLibraries();
          }
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
        // Materialize the Dashboard first, then open the Entry editor. Running
        // both commands concurrently made the slower panel win focus
        // nondeterministically.
        if (typeof msg.entryId === 'string' && msg.entryId.trim()) {
          await vscode.commands.executeCommand('snlDoc.openDashboard');
          await vscode.commands.executeCommand(
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
      case 'editMacro': {
        const name = (message as { name?: unknown }).name;
        if (typeof name !== 'string' || !name) return;
        const file = await this.findActiveMacroPackage(name);
        if (file) {
          await vscode.commands.executeCommand('snlDoc.editMacro', file, name);
        }
        return;
      }
      case 'deleteMacro': {
        const name = (message as { name?: unknown }).name;
        if (typeof name !== 'string' || !name) return;
        const file = await this.findActiveMacroPackage(name);
        if (!file) return;
        const deleteAction = hostText()('delete');
        const confirmed = await vscode.window.showWarningMessage(
          hostText()('deleteMacro', { name, file }),
          { modal: true, detail: hostText()('cannotUndo') },
          deleteAction
        );
        if (confirmed !== deleteAction) return;
        const root = firstWorkspaceFolder();
        if (!root) return;
        const result = await batchDeleteMacros(root, file, [name]);
        if (result.status !== 'ok') {
          vscode.window.showErrorMessage(
            hostText()('deleteMacroFailed', { error: 'message' in result ? result.message : result.status })
          );
          return;
        }
        await this.refresh();
        return;
      }
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
      case 'exportLibraryHtml':
        this.exportLibraryHtml(msg as unknown as ExportPayload);
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
    const generation = ++this.viewGeneration;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'libraries', libraries: [] });
      return;
    }
    try {
      const libraries = await listLibraries(root);
      if (generation !== this.viewGeneration) return;
      void this.panel.webview.postMessage({ type: 'libraries', libraries });
    } catch (err) {
      if (generation !== this.viewGeneration) return;
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        hostText()('listLibrariesFailed', { error: text })
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
    const generation = ++this.viewGeneration;
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

      // Shared pool + kinds for entry / kind / counter resolution. These are
      // independent files, so read them together rather than one after the
      // other, and hand the pool to `readLibraryGraph` so it does not read
      // `entries.json` a second time for its dangling-id check.
      // Cat 2026-07-25: panels felt slow.
      const [entryPool, kinds, counters] = await Promise.all([
        readEntries(root),
        readEntryKinds(root),
        readLibraryCounters(root, slug)
      ]);

      const graphResult = await readLibraryGraph(root, slug, { entryPool });
      const warnings: string[] = [];
      let graph: LibraryGraph = { nodes: [], relationships: [] };
      if (graphResult.status === 'ok') {
        warnings.push(...graphResult.result.warnings);
        graph = graphResult.result.graph;
      } else if (graphResult.status === 'error') {
        warnings.push(graphResult.message);
      }

      const entriesById = new Map<string, EntryData>();
      for (const e of entryPool) {
        entriesById.set(e.id, e);
      }
      const kindsById = new Map<string, EntryKind>();
      for (const k of kinds) {
        kindsById.set(k.id, k);
      }

      // 2026-07-16: warn on dangling per-node counterId overrides. A counterId
      // that isn't in the tree is treated as unset by the numbering engine
      // (falls back to the kind's defaultCounterName), so surface it as a
      // graph warning rather than failing silently.
      const counterIdSet = new Set<string>();
      const collectCounterIds = (list: CounterNode[]): void => {
        for (const c of list) {
          counterIdSet.add(c.id);
          collectCounterIds(c.children);
        }
      };
      collectCounterIds(counters);
      for (const node of graph.nodes) {
        const cid = node.props?.counterId;
        if (typeof cid === 'string' && cid && !counterIdSet.has(cid)) {
          warnings.push(
            hostText()('counterMissing', { nodeId: node.id, counterId: cid })
          );
        }
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
      // 2026-07-16: the numbering engine now resolves each node's active
      // counter from the library counter tree via kind.defaultCounterName
      // (name lookup) or an explicit per-node counterId. Project each kind to
      // its defaultCounterName view.
      const kindCounterById = new Map<string, { defaultCounterName: string }>();
      for (const [id, k] of kindsById) {
        kindCounterById.set(id, {
          defaultCounterName:
            typeof k.defaultCounterName === 'string' ? k.defaultCounterName : ''
        });
      }
      const outline = buildOutline(
        graph,
        entriesById,
        kindsById,
        entryKindRefById,
        kindCounterById,
        counters,
        warnings
      );

      const [macros, macroKinds] = await Promise.all([
        this.readMacroDb(),
        readMacroKinds(root)
      ]);
      if (generation !== this.viewGeneration) return;

      void this.panel.webview.postMessage({
        type: 'libraryEntries',
        slug,
        title: displayTitle,
        description,
        entries: flatEntries,
        outline,
        macros,
        macroKinds,
        assetBaseUri: this.assetBaseUri(root),
        warnings
      });
    } catch (err) {
      if (generation !== this.viewGeneration) return;
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        hostText()('loadLibraryFailed', { slug, error: text })
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

  private assetBaseUri(root: vscode.Uri): string {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(root, '.SNL_Doc', 'assets')
    ).toString();
  }

  /**
   * Hand the harvested Library to the Export Options panel.
   *
   * The Infoview's job ends at producing markup; shape, destination, and
   * options are chosen in a dedicated panel (cat 2026-07-28) rather than a
   * chain of modal dialogs.
   */
  private exportLibraryHtml(request: ExportPayload): void {
    ExportOptionsPanel.show(this.extensionUri, request);
  }

  /** Load the flat name→macro map. Strict entity-storage errors propagate to
   *  the caller so Infoview can display its existing error state. */
  private async readMacroDb(): Promise<Record<string, MacroPackageEntry>> {
    const root = firstWorkspaceFolder();
    if (!root) return {};
    return readAllMacros(root);
  }

  /** Look up one entry by id + resolve its kind, and send back the details.
   *  Includes the full entry pool + macros so the render can link between
   *  entries via macro popovers. */
  private async pushEntryDetails(id: string): Promise<void> {
    const generation = ++this.viewGeneration;
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
      const [macros, macroKinds] = await Promise.all([
        this.readMacroDb(),
        readMacroKinds(root)
      ]);
      if (generation !== this.viewGeneration) return;
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry,
        kind,
        entries: options,
        macros,
        macroKinds,
        assetBaseUri: this.assetBaseUri(root)
      });
    } catch (err) {
      if (generation !== this.viewGeneration) return;
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        hostText()('loadEntryFailed', { error: text })
      );
    }
  }

  /**
   * Per-entry panel payload: the single entry + its kind, PLUS the full entry
   * pool (so the webview's resolveSource can link macros to other entries).
   * Also refreshes the tab title to the resolved entry title.
   */
  private async pushEntryDetailsForEntry(id: string): Promise<void> {
    const generation = ++this.viewGeneration;
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
      const [macros, macroKinds] = await Promise.all([
        this.readMacroDb(),
        readMacroKinds(root)
      ]);
      if (generation !== this.viewGeneration) return;
      const entry: EntryData | undefined = entries.find((e) => e.id === id);
      if (!entry) {
        this.entryDisplayTitle = null;
        this.panel.title = hostText()('entryTitle', { id });
        void this.panel.webview.postMessage({
          type: 'entryDetails',
          entry: null,
          kind: null,
          entries: options,
          macros,
          macroKinds,
          relatedEntries: null
        });
        return;
      }
      this.entryDisplayTitle = entry.title;
      this.panel.title = hostText()('entryTitle', { id: this.entryDisplayTitle });
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
      if (generation !== this.viewGeneration) return;
      void this.panel.webview.postMessage({
        type: 'entryDetails',
        entry,
        kind,
        entries: options,
        macros,
        macroKinds,
        assetBaseUri: this.assetBaseUri(root),
        relatedEntries
      });
    } catch (err) {
      if (generation !== this.viewGeneration) return;
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({
        type: 'entryDetailsError',
        entryId: id,
        message: text
      });
      void vscode.window.showErrorMessage(
        hostText()('loadEntryFailed', { error: text })
      );
    }
  }

  /**
   * Popover preview payload: a single entry + its kind, echoed back with the
   * entryId so the requesting webview popover can match it. Distinct from
   * `entryDetails` so it never disturbs the browser's main selection.
   */
  private async pushPopoverEntryDetails(id: string): Promise<void> {
    const generation = ++this.popoverGeneration;
    const root = firstWorkspaceFolder();
    if (!root) {
      return;
    }
    try {
      // Both files are needed for a hit and are independent, so fetch them
      // together instead of only starting `readEntryKinds` after the pool
      // has arrived. Cat 2026-07-25: panels felt slow.
      const [entries, kinds] = await Promise.all([
        readEntries(root),
        readEntryKinds(root)
      ]);
      if (generation !== this.popoverGeneration) return;
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
        hostText()('loadPopoverFailed', { error: text })
      );
    }
  }

  /** Resolve the active package that wins for a macro name using the same
   * last-writer collision rule as readAllMacros. */
  private async findActiveMacroPackage(name: string): Promise<string | null> {
    const root = firstWorkspaceFolder();
    if (!root) return null;
    // `readAllMacrosWithOrigin` already answers "which active package owns
    // this macro name" from ONE concurrent walk. The old code re-derived it
    // by parsing every package twice (once for the listing, once per file)
    // and serially at that. The origin map resolves collisions by file-name
    // order, which is exactly what this loop's last-write-wins did.
    // Cat 2026-07-25: panels felt slow.
    const { origin } = await readAllMacrosWithOrigin(root);
    return origin[name] ?? null;
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
export function buildOutline(
  graph: LibraryGraph,
  entriesById: Map<string, EntryData>,
  kindsById: Map<string, EntryKind>,
  entryKindRefById: Map<string, { kind?: string }>,
  kindCounterById: Map<string, { defaultCounterName: string }>,
  counters: CounterNode[],
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

  // Cycle guard. This tracks the nodes on the CURRENT path, not every node
  // ever seen: a node legitimately appears under more than one parent when
  // two entries both branch to it, and a build-wide `visited` set silently
  // dropped every occurrence after the first — together with its whole
  // subtree. 猫猫 2026-07-29: "有时候索引条目显示不出来". It read as intermittent
  // because it only bites on a re-reachable node, and which parent kept it
  // depended on nodes[] declaration order.
  const onPath = new Set<string>();
  // Nodes that were reached from some parent, for the orphan pass below.
  const reached = new Set<string>();

  const buildNode = (nodeId: string): OutlineNode | null => {
    if (onPath.has(nodeId)) return null; // genuine cycle
    const node = nodesById.get(nodeId);
    if (!node) return null;
    onPath.add(nodeId);
    reached.add(nodeId);

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
          hostText()('sharedEntryMissing', { entryId, nodeId })
        );
      }
    }

    const counterLabel = numberFor(
      graph,
      nodeId,
      entryKindRefById,
      kindCounterById,
      counters
    );

    const childIds = childrenOf.get(nodeId) ?? [];
    const children: OutlineNode[] = [];
    for (const cid of childIds) {
      const built = buildNode(cid);
      if (built) children.push(built);
    }
    // Leave the path: siblings and later parents must be free to reach this
    // node again. Without this pop, `onPath` degrades into the build-wide
    // `visited` set that caused the bug.
    onPath.delete(nodeId);

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
    if (reached.has(n.id)) continue;
    const built = buildNode(n.id);
    if (built) roots.push(built);
  }
  return roots;
}
