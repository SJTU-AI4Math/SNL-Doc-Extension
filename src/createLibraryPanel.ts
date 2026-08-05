import * as vscode from 'vscode';
import {
  addEntry,
  createLibrary,
  entityRevision,
  readEntriesByIds,
  readEntryDependencyClosure,
  readEntryKinds,
  readLibraryCounters,
  readLibraryCountersWithSnapshot,
  readLibraryGraph,
  readLibraryMeta,
  updateLibrary,
  writeLibraryCounters,
  writeLibraryGraph,
  type CounterNode,
  type EntryKind,
  type GraphNodeDto,
  type GraphRelationshipDto
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage,
  installSnlDocWatcher, shouldRefreshEntityDependency
} from './panelUtil';
import { entryEntityPath, macroEntityPath, packageManifestPath } from './entityStorage';
import { readEntryMetricThresholds } from './entryMetricSettings';
import { moveGraphSibling } from './graphSiblingOrder';

/**
 * Per-mode-and-identity singleton manager for the SNL Library editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createLibrary` → create-mode panel (no identity).
 *  - `snlDoc.editLibrary`   → edit-mode panel keyed by library slug.
 *
 * Scope:
 *  - Requires `.SNL_Doc/` to already exist. Create adds a new library dir;
 *    edit updates meta.json's `title` in place (slug is immutable) AND
 *    hosts the outline editor for graph.json (per cat 2026-07-06).
 *
 * Message protocol with the webview (`createLibrary.js`):
 *  - in  :
 *      Meta side:
 *        `{ type: 'ready' }`
 *        `{ type: 'create', title }`
 *        `{ type: 'update', title }`
 *      Outline side (edit mode only):
 *        `{ type: 'requestGraph' }`  — refresh graph + entries + kinds
 *        `{ type: 'graphOp', op }`   — mutate the graph (see GraphOp below)
 *  - out :
 *        `{ type: 'context', mode, existing? }`
 *        `{ type: 'created' | 'updated' | 'duplicate' | 'noSnlDoc'
 *              | 'notFound' | 'invalid' | 'error' | 'noWorkspace', ... }`
 *        `{ type: 'graph', nodes, relationships, entries, kinds, warnings }`
 *        `{ type: 'graphError', message }`
 *
 * GraphOp is a discriminated union — see `handleGraphOp` for the full list.
 */
export class CreateLibraryPanel {
  private static readonly instances = new Map<string, CreateLibraryPanel>();

  private static readonly viewType = 'snlCreateLibrary';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  /** Only set when mode === 'edit'; the library slug being edited. */
  private readonly slug: string;
  private disposables: vscode.Disposable[] = [];
  private contextGeneration = 0;
  private metadataGeneration = 0;
  private graphGeneration = 0;
  /** Exact entity files used by the last successfully published graph context. */
  private graphDependencySuffixes = new Set<string>();
  private graphDependenciesReady = false;

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateLibraryPanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, slug: string): void {
    if (!slug) {
      return;
    }
    CreateLibraryPanel.open(extensionUri, 'edit', slug);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    slug: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${slug}`;

    const existing = CreateLibraryPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit' ? `SNL Edit Library — ${slug}` : 'SNL Create Library';
    const panel = vscode.window.createWebviewPanel(
      CreateLibraryPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateLibraryPanel.instances.set(
      key,
      new CreateLibraryPanel(panel, extensionUri, mode, slug)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    slug: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.slug = slug;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createLibrary',
      mode === 'edit' ? `SNL Edit Library — ${slug}` : 'SNL Create Library'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Refresh the outline whenever this panel regains focus — the user
    // might have popped over to Create Entry and just added a new entry
    // in the shared pool that we now want to pick up.
    this.panel.onDidChangeViewState(
      () => {
        if (this.mode === 'edit' && this.panel.active) {
          void this.pushGraph();
        }
      },
      null,
      this.disposables
    );

    installSnlDocWatcher(this.disposables, (uris) => this.handleStorageChanges(uris));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (this.mode === 'edit' && event.affectsConfiguration('snlDoc.metrics')) {
          void this.pushGraph();
        }
      })
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const generation = ++this.contextGeneration;
    await this.pushMetadataContext();
    if (this.mode !== 'edit') return;
    // Outline and counters are independent surfaces. Initial load asks for all
    // three; watcher refreshes below target only the surface whose file changed.
    await this.pushGraph(generation);
    await this.pushCounters('countersLoaded', generation);
  }

  private async pushMetadataContext(): Promise<void> {
    const generation = ++this.metadataGeneration;
    if (this.mode === 'create') {
      void this.panel.webview.postMessage({ type: 'context', mode: 'create' });
      return;
    }
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context', mode: 'edit', slug: this.slug, existing: null
      });
      return;
    }
    try {
      const metaResult = await readLibraryMeta(root, this.slug);
      if (generation !== this.metadataGeneration) return;
      if (metaResult.status === 'error') throw new Error(metaResult.message);
      const title =
        metaResult.status === 'ok' && typeof metaResult.meta.title === 'string'
          ? metaResult.meta.title
          : this.slug;
      const libraryRevision = entityRevision(
        metaResult.status === 'ok' ? metaResult.meta : null
      );
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        slug: this.slug,
        libraryRevision,
        existing: { slug: this.slug, title }
      });
    } catch (err) {
      if (generation !== this.metadataGeneration) return;
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private async handleStorageChanges(uris: readonly vscode.Uri[]): Promise<void> {
    if (this.mode !== 'edit') return;
    const libraryPrefix = `/.SNL_Doc/libraries/${this.slug}/`;
    let refreshMeta = false;
    let refreshGraph = false;
    let refreshCounters = false;
    for (const uri of uris) {
      if (uri.path.endsWith(`${libraryPrefix}meta.json`)) refreshMeta = true;
      else if (uri.path.endsWith(`${libraryPrefix}graph.json`)) refreshGraph = true;
      else if (uri.path.endsWith(`${libraryPrefix}counters.json`)) refreshCounters = true;
      else if (uri.path.includes('/.SNL_Doc/libraries/')) continue;
      else if (
        uri.path.endsWith('/.SNL_Doc/config.json') ||
        uri.path.endsWith('/.SNL_Doc/entries.json') ||
        uri.path.includes('/.SNL_Doc/term_macros/')
      ) {
        refreshGraph = true;
      } else if (
        uri.path.includes('/.SNL_Doc/entries/') ||
        uri.path.includes('/.SNL_Doc/macros/') ||
        uri.path.includes('/.SNL_Doc/packages/')
      ) {
        // Before the first graph publication there is no safe dependency set,
        // so fail broad. Afterwards, unrelated hash files are ignored.
        if (shouldRefreshEntityDependency(
          uri.path,
          this.graphDependencySuffixes,
          this.graphDependenciesReady
        )) {
          refreshGraph = true;
        }
      }
    }
    await Promise.all([
      refreshMeta ? this.pushMetadataContext() : Promise.resolve(),
      refreshGraph ? this.pushGraph() : Promise.resolve(),
      refreshCounters ? this.pushCounters('countersLoaded') : Promise.resolve()
    ]);
  }

  /** Push the current graph + entry pool + kinds to the webview so the
   *  outline editor can re-render. */
  private async pushGraph(contextGeneration?: number): Promise<void> {
    const graphGeneration = ++this.graphGeneration;
    // While reads are in flight, fail broad rather than filtering against the
    // previous publication's dependency set. A matching create/delete event
    // then starts a newer generation; this one becomes stale and cannot publish.
    this.graphDependenciesReady = false;
    const isStale = (): boolean =>
      graphGeneration !== this.graphGeneration ||
      (contextGeneration !== undefined && contextGeneration !== this.contextGeneration);
    if (this.mode !== 'edit') return;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'graphError',
        message: 'No workspace folder open.'
      });
      return;
    }
    try {
      const gResult = await readLibraryGraph(root, this.slug);
      if (isStale()) return;
      let nodes: GraphNodeDto[] = [];
      let relationships: GraphRelationshipDto[] = [];
      let warnings: string[] = [];
      if (gResult.status === 'ok') {
        nodes = gResult.result.graph.nodes;
        relationships = gResult.result.graph.relationships;
        warnings = gResult.result.warnings;
      } else if (gResult.status === 'noFile') {
        // No graph.json → treat as empty graph so the outline editor can
        // start populating one.
        warnings = ['graph.json does not exist; will be created on first edit'];
      } else {
        void this.panel.webview.postMessage({
          type: 'graphError',
          message: gResult.message
        });
        return;
      }
      // Resolve a cycle-safe transitive closure from graph-visible Entries.
      // Every hop is an identity point read; missing identities remain in the
      // dependency sets so later file creation invalidates this panel.
      const graphEntries = gResult.status === 'ok' ? gResult.result.entries : [];
      const [closure, kinds] = await Promise.all([
        readEntryDependencyClosure(root, graphEntries),
        readEntryKinds(root)
      ]);
      const entries = closure.entries;
      const metricMacroSources = Object.fromEntries(
        Object.entries(closure.macros).map(([name, macro]) => [name, { source: macro.source }])
      );
      const dependencySuffixes = new Set<string>();
      const requestedEntryIds = new Set<string>([
        ...nodes.flatMap((node) => {
          const entryId = node.label === 'Entry' ? node.props.entryId : undefined;
          return typeof entryId === 'string' && entryId.length > 0 ? [entryId] : [];
        }),
        ...closure.requestedEntryIds
      ]);
      for (const entryId of requestedEntryIds) {
        dependencySuffixes.add(`/.SNL_Doc/${entryEntityPath(entryId)}`);
      }
      for (const packageId of closure.candidatePackages) {
        dependencySuffixes.add(`/.SNL_Doc/${packageManifestPath(packageId)}`);
        for (const name of closure.requestedMacroNames) {
          dependencySuffixes.add(`/.SNL_Doc/${macroEntityPath(packageId, name)}`);
        }
      }
      if (isStale()) return;
      this.graphDependencySuffixes = dependencySuffixes;
      this.graphDependenciesReady = true;
      void this.panel.webview.postMessage({
        type: 'graph',
        nodes,
        relationships,
        entries,
        kinds,
        metricMacroSources,
        metricThresholds: readEntryMetricThresholds(),
        warnings
      });
    } catch (err) {
      if (isStale()) return;
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({
        type: 'graphError',
        message: text
      });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    // Nav messages (back to Dashboard etc.) MUST be handled first — they
    // don't carry a `title`/`op` and would otherwise fall through the
    // switch below without dispatching. Cat 2026-07-10: 'SNL Edit Library
    // 左上角返回 Dashboard 按钮不 work'.
    if (await handlePanelNavMessage(message, () => this.pushContext())) {
      return;
    }
    const msg = message as
      | { type?: string; title?: string; op?: unknown; expectedRevision?: string }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type === 'requestGraph') {
      await this.pushGraph();
      return;
    }
    if (msg.type === 'lookupEntry') {
      const lookup = msg as { entryId?: unknown; requestId?: unknown };
      const entryId = typeof lookup.entryId === 'string' ? lookup.entryId.trim() : '';
      const requestId = typeof lookup.requestId === 'number' &&
        Number.isSafeInteger(lookup.requestId) ? lookup.requestId : -1;
      const root = firstWorkspaceFolder();
      const entry = root && entryId && requestId >= 0
        ? (await readEntriesByIds(root, [entryId]))[0] ?? null
        : null;
      void this.panel.webview.postMessage({ type: 'entryLookup', requestId, entryId, entry });
      return;
    }
    if (msg.type === 'graphOp') {
      await this.handleGraphOp(msg.op);
      return;
    }
    if (msg.type === 'counterOp') {
      await this.handleCounterOp(msg.op);
      return;
    }
    if (msg.type === 'openCreateEntry') {
      // Cat 2026-07-06: outline Add row's "Create" button routes to the
      // full CreateEntry panel — user fills out kind/title/content there
      // and comes back to paste the returned id.
      // Cat 2026-07-15: forward the typed-but-unresolved id from the
      // outline picker so the CreateEntry panel seeds its id field with
      // exactly what the user just typed — otherwise they had to retype
      // (or the panel would mint a fresh UUID and the outline id they
      // typed disappeared silently).
      const rawEntryId = (msg as { entryId?: unknown }).entryId;
      const seedId =
        typeof rawEntryId === 'string' && rawEntryId.trim()
          ? rawEntryId.trim()
          : undefined;
      await vscode.commands.executeCommand('snlDoc.createEntry', seedId);
      return;
    }
    if (msg.type === 'openEditEntry') {
      // Cat 2026-07-12: outline row title is now a click target that
      // opens the Edit Entry panel for the row's entry.
      const id = (msg as { entryId?: unknown }).entryId;
      if (typeof id === 'string' && id.trim()) {
        await vscode.commands.executeCommand('snlDoc.editEntry', id.trim());
      }
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') {
      return;
    }

    const workspaceRoot = firstWorkspaceFolder();
    if (!workspaceRoot) {
      const text = 'SNL Library editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const title = typeof msg.title === 'string' ? msg.title : '';

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateLibrary(
          workspaceRoot,
          this.slug,
          { title },
          msg.expectedRevision
        );
        switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Library "${result.slug}" title updated to "${result.title}".`
            );
            await this.panel.webview.postMessage({
              type: 'updated',
              slug: result.slug,
              title: result.title,
              revision: result.revision
            });
            // The exact meta watcher event performs the sole disk refresh. The
            // new revision is already in the acknowledgement, so save can
            // complete immediately without a second explicit meta read.
            return;
          case 'conflict': {
            const text = `Library "${result.id}" changed after this editor opened. Reload before saving.`;
            vscode.window.showWarningMessage(text);
            void this.panel.webview.postMessage({ type: 'conflict', slug: result.id, message: text });
            return;
          }
          case 'notFound': {
            const text = `Library "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              slug: result.id,
              message: text
            });
            return;
          }
          case 'noSnlDoc': {
            const text = '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'noSnlDoc',
              message: text
            });
            return;
          }
          case 'invalid':
            void this.panel.webview.postMessage({
              type: 'invalid',
              message: result.message
            });
            return;
          case 'error':
            void this.panel.webview.postMessage({
              type: 'error',
              message: result.message
            });
            return;
        }
      }
      // Create path.
      const result = await createLibrary(workspaceRoot, title);
      switch (result.status) {
        case 'noSnlDoc': {
          const text =
            '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noSnlDoc',
            message: text
          });
          return;
        }
        case 'duplicate': {
          const text = `Library "${result.slug}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            slug: result.slug,
            message: text
          });
          return;
        }
        case 'created':
          vscode.window.showInformationMessage(
            `Library "${result.title}" created (slug: ${result.slug}).`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            slug: result.slug,
            title: result.title
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Library editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  /**
   * Apply a graph-editor operation, then push the fresh graph back. All
   * mutations go through readLibraryGraph → mutate → writeLibraryGraph so
   * concurrent watchers see one atomic write. Ops are shape-validated here;
   * the webview should never send malformed ones, but be defensive.
   *
   * Supported ops (all in edit mode only):
   *   - addNode: { op: 'addNode', parentId | null, entryId?, kind?, title?, insertAfter?, counterId?, isStub? }
   *       Two modes decided by `entryId`:
   *       (a) entryId non-empty  → REFERENCE mode. Validates that this
   *           entryId exists in the shared pool, then creates a graph node
   *           pointing at it. `kind` and `title` are ignored — the entry
   *           already carries them. Enables one entry being outlined in
   *           multiple libraries (cat 2026-07-06: "一个 entry 能属多个
   *           library"). When `isStub` (or `allowUnresolved`) is set, the
   *           pool-existence check is skipped so a dangling ref can be
   *           inserted and resolve later once the entry lands (2026-07-16).
   *       (b) entryId empty/omitted → CREATE mode. Creates a fresh
   *           EntryData in the shared pool with a new uuid using the
   *           supplied `kind` (required) + `title`, then links a graph
   *           node to it.
   *       In both modes, when `insertAfter` is given, the new branch edge
   *       is placed right after the sibling with that node id; otherwise
   *       appended. `parentId=null` places the node as a new root (no
   *       branch edge is written).
   *   - deleteNode: { op: 'deleteNode', nodeId }
   *       Removes the graph node + all its branch edges. Does NOT delete
   *       the underlying shared-pool entry — undo-friendly.
   *   - moveSibling: { op: 'moveSibling', nodeId, direction: 'up' | 'down', toEdge? }
   *   - indent: { op: 'indent', nodeId }
   *       Demote the node under its previous sibling (make it that
   *       sibling's last child). No-op when there is no previous sibling
   *       (first child of parent, or first root). Cat 2026-07-09.
   *   - outdent: { op: 'outdent', nodeId }
   *       Promote the node to sibling-of-parent (grandparent becomes new
   *       parent; if none, node becomes a root). No-op on roots.
   *       Cat 2026-07-09.
   *       Swaps this node's branch-edge with its previous/next sibling's.
   */
  private async handleGraphOp(rawOp: unknown): Promise<void> {
    if (this.mode !== 'edit') {
      void this.panel.webview.postMessage({
        type: 'graphError',
        message: 'graphOp only valid in edit mode'
      });
      return;
    }
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'graphError',
        message: 'No workspace folder open.'
      });
      return;
    }
    const op = rawOp as { op?: string; [k: string]: unknown } | undefined;
    if (!op || typeof op.op !== 'string') {
      void this.panel.webview.postMessage({
        type: 'graphError',
        message: 'graphOp: missing op field'
      });
      return;
    }

    try {
      // Read → mutate → write in one shot. readLibraryGraph tolerates
      // no-file by returning noFile; treat it as empty and write fresh.
      const gRead = await readLibraryGraph(root, this.slug);
      let nodes: GraphNodeDto[] = [];
      let relationships: GraphRelationshipDto[] = [];
      let expectedGraphSnapshot: unknown = null;
      if (gRead.status === 'ok') {
        nodes = gRead.result.graph.nodes.slice();
        relationships = gRead.result.graph.relationships.slice();
        expectedGraphSnapshot = gRead.result.snapshot;
      } else if (gRead.status === 'error') {
        void this.panel.webview.postMessage({
          type: 'graphError',
          message: gRead.message
        });
        return;
      }

      switch (op.op) {
        case 'addNode': {
          const parentId =
            typeof op.parentId === 'string' ? op.parentId : null;
          const rawEntryId =
            typeof op.entryId === 'string' ? op.entryId.trim() : '';
          const kind = typeof op.kind === 'string' ? op.kind.trim() : '';
          const title = typeof op.title === 'string' ? op.title : '';
          const insertAfter =
            typeof op.insertAfter === 'string' ? op.insertAfter : null;
          const counterId =
            typeof op.counterId === 'string' ? op.counterId.trim() : '';
          // Stub mode (2026-07-16): the outline Add form dispatches a stub
          // node when the typed id doesn't resolve to a pooled entry yet, so
          // the node lands in the outline immediately and resolves organically
          // once the Create Entry panel saves that id into the pool.
          const isStub = op.isStub === true || op.allowUnresolved === true;
          // Validate parent exists in the graph (or is null for a root).
          if (parentId !== null && !nodes.some((n) => n.id === parentId)) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: `addNode: parent "${parentId}" not found`
            });
            return;
          }

          let entryUuid: string;
          if (rawEntryId) {
            // REFERENCE mode: entryId must exist in the shared pool — UNLESS
            // this is a stub, in which case we skip the pool-existence check
            // and let the dangling ref resolve when the entry lands later.
            if (!isStub) {
              const [entry] = await readEntriesByIds(root, [rawEntryId]);
              if (!entry) {
                void this.panel.webview.postMessage({
                  type: 'graphError',
                  message: `addNode: entry "${rawEntryId}" not found in shared pool. Leave the id field empty to create a new entry.`
                });
                return;
              }
            }
            entryUuid = rawEntryId;
          } else {
            // CREATE mode: need a kind; make a fresh shared-pool row.
            if (!kind) {
              void this.panel.webview.postMessage({
                type: 'graphError',
                message: 'addNode: kind is required when creating a new entry'
              });
              return;
            }
            entryUuid = generateUuid();
            const addRes = await addEntry(root, {
              id: entryUuid,
              kind,
              title,
              content: {},
              contribution_info: null,
              pointer: null
            });
            if (addRes.status !== 'ok') {
              const message =
                addRes.status === 'invalid'
                  ? addRes.reason
                  : addRes.status === 'unknownKind'
                    ? `kind "${addRes.kind}" is not registered`
                    : addRes.status === 'duplicate'
                      ? `entry id collision (${addRes.id}) — retry`
                      : addRes.status === 'noSnlDoc'
                        ? '.SNL_Doc/ not found'
                        : 'error' in addRes ? addRes.message : 'unknown';
              void this.panel.webview.postMessage({
                type: 'graphError',
                message: `addNode: shared-pool addEntry failed: ${message}`
              });
              return;
            }
          }
          // Insert the graph node + branch edge.
          const nodeLocalId = generateLocalId(nodes);
          const nodeProps: Record<string, unknown> = { entryId: entryUuid };
          // Optional per-node counter override (2026-07-16). Empty = unset,
          // falling back to the kind's defaultCounterName at numbering time.
          if (counterId) nodeProps.counterId = counterId;
          nodes.push({
            id: nodeLocalId,
            label: 'Entry',
            props: nodeProps
          });
          if (parentId !== null) {
            const newRel: GraphRelationshipDto = {
              from: parentId,
              to: nodeLocalId,
              label: 'branch'
            };
            if (insertAfter) {
              const idx = relationships.findIndex(
                (r) =>
                  r.label === 'branch' &&
                  r.from === parentId &&
                  r.to === insertAfter
              );
              if (idx >= 0) {
                relationships.splice(idx + 1, 0, newRel);
              } else {
                relationships.push(newRel);
              }
            } else {
              relationships.push(newRel);
            }
          }
          // parentId === null → root node; no branch edge needed.
          break;
        }
        case 'deleteNode': {
          const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
          if (!nodeId) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: 'deleteNode: nodeId is required'
            });
            return;
          }
          // Refuse if the node still has children (cat 2026-07-06 default:
          // no cascade — the user has to move children out first). Prevents
          // accidental subtree loss.
          if (
            relationships.some(
              (r) => r.label === 'branch' && r.from === nodeId
            )
          ) {
            // Modal (not just a webview banner) — cat 2026-07-09 wants
            // clear "why can't I delete this" feedback.
            void vscode.window.showWarningMessage(
              'Cannot delete: this node has children.',
              {
                modal: true,
                detail:
                  'Move or delete each child first, then delete the parent. This prevents accidental subtree loss.'
              }
            );
            return;
          }
          // Host-side modal confirm (cat 2026-07-09). window.confirm() is
          // blocked in VS Code webviews and silently returns undefined,
          // which is exactly why the previous "确认再删" webview-side flow
          // never fired the deleteNode op. Modal lives here now.
          const nodeLabel =
            nodes.find((n) => n.id === nodeId)?.props?.entryId ?? nodeId;
          const confirmed = await vscode.window.showWarningMessage(
            `Remove "${nodeLabel}" from this library's outline?`,
            {
              modal: true,
              detail:
                'The underlying shared-pool entry is NOT deleted — only this outline node and its branch edges. Use the Dashboard\u2019s Entries table if you want to delete the entry itself.'
            },
            'Remove'
          );
          if (confirmed !== 'Remove') {
            return;
          }
          nodes = nodes.filter((n) => n.id !== nodeId);
          relationships = relationships.filter(
            (r) => r.from !== nodeId && r.to !== nodeId
          );
          break;
        }
        case 'moveSibling': {
          const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
          const direction = op.direction === 'up' ? 'up' : op.direction === 'down' ? 'down' : null;
          if (!nodeId || !direction) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: 'moveSibling: nodeId + direction required'
            });
            return;
          }
          const moved = moveGraphSibling(
            nodes,
            relationships,
            nodeId,
            direction,
            op.toEdge === true
          );
          nodes = moved.nodes;
          relationships = moved.relationships;
          break;
        }
        case 'indent': {
          // Cat 2026-07-09: "把当前条目变成上一个条目的子条目" — turn the
          // current node into a child of its previous sibling. If there
          // is no previous sibling (nodeId is already the first child of
          // its parent, OR is the first root) this is a no-op.
          //
          // Implementation: locate the previous sibling under the same
          // parent, then rewrite the branch edge that points to nodeId so
          // its `from` becomes the previous sibling. For a root that we
          // demote under a previous root, we CREATE a new branch edge
          // (no existing one to rewrite because roots have no parent
          // edge). The demoted node's own subtree comes along for free
          // because we don't touch edges rooted at nodeId.
          const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
          if (!nodeId) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: 'indent: nodeId required'
            });
            return;
          }
          const myParentRelIdx = relationships.findIndex(
            (r) => r.label === 'branch' && r.to === nodeId
          );
          if (myParentRelIdx >= 0) {
            // Non-root: has a parent edge; find previous sibling under
            // that same parent.
            const parentId = relationships[myParentRelIdx].from;
            const siblingRelIndices: number[] = [];
            for (let i = 0; i < relationships.length; i++) {
              const r = relationships[i];
              if (r.label === 'branch' && r.from === parentId) {
                siblingRelIndices.push(i);
              }
            }
            const myPos = siblingRelIndices.findIndex(
              (i) => relationships[i].to === nodeId
            );
            if (myPos <= 0) {
              // Already the first child; no previous sibling. No-op.
              return;
            }
            const prevSiblingRelIdx = siblingRelIndices[myPos - 1];
            const prevSiblingId = relationships[prevSiblingRelIdx].to;
            // Rewrite my parent edge in-place. Preserves declaration order
            // relative to other edges (matters for reading order — the
            // new-child insertion point is where my old edge already sat).
            relationships[myParentRelIdx] = {
              ...relationships[myParentRelIdx],
              from: prevSiblingId
            };
            break;
          }
          // Root case: find the previous root in nodes[] order and demote
          // the current node under it by ADDING a branch edge.
          const nodesIdx = nodes.findIndex((n) => n.id === nodeId);
          if (nodesIdx <= 0) {
            // Already first root; nothing to demote under. No-op.
            return;
          }
          const isRoot = (nid: string): boolean =>
            !relationships.some(
              (r) => r.label === 'branch' && r.to === nid
            );
          let prevRootId: string | null = null;
          for (let j = nodesIdx - 1; j >= 0; j--) {
            if (isRoot(nodes[j].id)) {
              prevRootId = nodes[j].id;
              break;
            }
          }
          if (!prevRootId) return;
          relationships.push({
            from: prevRootId,
            to: nodeId,
            label: 'branch'
          });
          break;
        }
        case 'outdent': {
          // Cat 2026-07-09: inverse of indent — promote this node to be
          // a sibling of its parent. No-op when nodeId is already a root
          // (no parent to escape). Non-root implementation: change the
          // parent-branch edge so `from` becomes the grandparent
          // (or, if grandparent is null, drop the edge entirely so this
          // node becomes a root). Node order stays where it was in
          // `nodes[]` — good enough; user can reorder afterwards.
          const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
          if (!nodeId) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: 'outdent: nodeId required'
            });
            return;
          }
          const myParentRelIdx = relationships.findIndex(
            (r) => r.label === 'branch' && r.to === nodeId
          );
          if (myParentRelIdx < 0) {
            // Already a root; nothing to outdent from. No-op.
            return;
          }
          const parentId = relationships[myParentRelIdx].from;
          const grandRelIdx = relationships.findIndex(
            (r) => r.label === 'branch' && r.to === parentId
          );
          if (grandRelIdx < 0) {
            // Parent is a root → outdenting makes THIS a root: drop the
            // parent-branch edge, keep the node in nodes[].
            relationships.splice(myParentRelIdx, 1);
          } else {
            const grandparentId = relationships[grandRelIdx].from;
            relationships[myParentRelIdx] = {
              ...relationships[myParentRelIdx],
              from: grandparentId
            };
          }
          break;
        }
        case 'updateNodeProps': {
          // Per-node property patch (2026-07-16). Currently only `counterId`
          // is patchable — an explicit counter override for this outline node.
          // An empty/absent counterId clears the override (falls back to the
          // kind's defaultCounterName at numbering time).
          const nodeId = typeof op.nodeId === 'string' ? op.nodeId : '';
          if (!nodeId) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: 'updateNodeProps: nodeId is required'
            });
            return;
          }
          const nodeIdx = nodes.findIndex((n) => n.id === nodeId);
          if (nodeIdx < 0) {
            void this.panel.webview.postMessage({
              type: 'graphError',
              message: `updateNodeProps: node "${nodeId}" not found`
            });
            return;
          }
          const counterId =
            typeof op.counterId === 'string' ? op.counterId.trim() : '';
          const nextProps: Record<string, unknown> = { ...nodes[nodeIdx].props };
          if (counterId) nextProps.counterId = counterId;
          else delete nextProps.counterId;
          nodes[nodeIdx] = { ...nodes[nodeIdx], props: nextProps };
          break;
        }
        default:
          void this.panel.webview.postMessage({
            type: 'graphError',
            message: `unknown graphOp: ${op.op}`
          });
          return;
      }

      const writeRes = await writeLibraryGraph(root, this.slug, {
        nodes,
        relationships
      }, expectedGraphSnapshot);
      if (writeRes.status !== 'ok') {
        void this.panel.webview.postMessage({
          type: 'graphError',
          message: writeRes.message
        });
        return;
      }
      // Refresh the webview with the new state.
      await this.pushGraph();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({
        type: 'graphError',
        message: text
      });
    }
  }

  /**
   * Read the library's counter tree and push it to the webview. `type`
   * distinguishes the initial load (`countersLoaded`) from a post-mutation
   * refresh (`countersPushed`); the webview treats both the same (replace its
   * local tree), but the split keeps the protocol self-documenting.
   */
  private async pushCounters(
    type: 'countersLoaded' | 'countersPushed',
    generation?: number
  ): Promise<void> {
    if (this.mode !== 'edit') return;
    const root = firstWorkspaceFolder();
    if (!root) return;
    try {
      const counters = await readLibraryCounters(root, this.slug);
      if (generation !== undefined && generation !== this.contextGeneration) return;
      void this.panel.webview.postMessage({ type, counters });
    } catch {
      // readLibraryCounters already tolerates missing/malformed files by
      // returning []; a throw here would be an unexpected fs error — swallow
      // so a transient read failure doesn't wedge the panel.
    }
  }

  /**
   * Apply a counter-tree operation, then push the fresh tree back. Mirrors
   * {@link handleGraphOp}'s read → mutate → write → push flow but over the
   * nested `CounterNode[]` in libraries/<slug>/counters.json.
   *
   * Ops mirror the entry outline's op vocabulary:
   *   - addRoot     { insertAfter: string | null, seed: { name, numbering } }
   *   - addChild    { parentId, insertAfter: string | null, seed }
   *   - updateFields{ id, patch: Partial<{ name, numbering }> }
   *   - move        { id, direction: 'up' | 'down' }
   *   - indent      { id }   become last child of previous sibling
   *   - outdent     { id }   promote to sibling-of-parent (root when the
   *                          parent is a root); no-op on a root node
   *   - delete      { id }   removes the subtree
   */
  private async handleCounterOp(rawOp: unknown): Promise<void> {
    if (this.mode !== 'edit') return;
    const root = firstWorkspaceFolder();
    if (!root) return;
    const op = rawOp as { op?: string; [k: string]: unknown } | undefined;
    if (!op || typeof op.op !== 'string') return;

    try {
      const counterRead = await readLibraryCountersWithSnapshot(root, this.slug);
      const roots = counterRead.counters;
      switch (op.op) {
        case 'addRoot': {
          const node = makeCounterNode(readCounterSeed(op.seed));
          insertIntoList(
            roots,
            node,
            typeof op.insertAfter === 'string' ? op.insertAfter : null
          );
          break;
        }
        case 'addChild': {
          const parentId = typeof op.parentId === 'string' ? op.parentId : '';
          const loc = locateCounter(roots, parentId);
          if (!loc) return;
          const parentNode = loc.list[loc.index];
          const node = makeCounterNode(readCounterSeed(op.seed));
          insertIntoList(
            parentNode.children,
            node,
            typeof op.insertAfter === 'string' ? op.insertAfter : null
          );
          break;
        }
        case 'updateFields': {
          const id = typeof op.id === 'string' ? op.id : '';
          const loc = locateCounter(roots, id);
          if (!loc) return;
          const node = loc.list[loc.index];
          const patch = op.patch as
            | { name?: unknown; numbering?: unknown }
            | undefined;
          if (patch && typeof patch.name === 'string') node.name = patch.name;
          if (patch && typeof patch.numbering === 'string') {
            node.numbering = patch.numbering;
          }
          break;
        }
        case 'move': {
          const id = typeof op.id === 'string' ? op.id : '';
          const direction =
            op.direction === 'up' ? 'up' : op.direction === 'down' ? 'down' : null;
          if (!direction) return;
          const loc = locateCounter(roots, id);
          if (!loc) return;
          const j = direction === 'up' ? loc.index - 1 : loc.index + 1;
          if (j < 0 || j >= loc.list.length) return;
          const tmp = loc.list[loc.index];
          loc.list[loc.index] = loc.list[j];
          loc.list[j] = tmp;
          break;
        }
        case 'indent': {
          const id = typeof op.id === 'string' ? op.id : '';
          const loc = locateCounter(roots, id);
          if (!loc || loc.index <= 0) return; // no previous sibling → no-op
          const prev = loc.list[loc.index - 1];
          const [node] = loc.list.splice(loc.index, 1);
          prev.children.push(node);
          break;
        }
        case 'outdent': {
          const id = typeof op.id === 'string' ? op.id : '';
          const loc = locateCounter(roots, id);
          if (!loc || !loc.parent) return; // root node → no parent to escape
          const parentLoc = locateCounter(roots, loc.parent.id);
          const [node] = loc.list.splice(loc.index, 1);
          if (!parentLoc) {
            roots.push(node);
          } else {
            parentLoc.list.splice(parentLoc.index + 1, 0, node);
          }
          break;
        }
        case 'delete': {
          const id = typeof op.id === 'string' ? op.id : '';
          const loc = locateCounter(roots, id);
          if (!loc) return;
          loc.list.splice(loc.index, 1);
          break;
        }
        default:
          return;
      }

      await writeLibraryCounters(root, this.slug, roots, counterRead.snapshot);
      await this.pushCounters('countersPushed');
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({
        type: 'countersError',
        message: text
      });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.slug}`;
    CreateLibraryPanel.instances.delete(key);

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
// Local id generators
// ---------------------------------------------------------------------------

/** RFC-4122 v4 UUID. */
function generateUuid(): string {
  // Node 20+ / VS Code 1.90+ ship crypto.randomUUID globally.
  const c: { randomUUID?: () => string } = (globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
  }).crypto ?? {};
  if (typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Defensive fallback shouldn't be reachable in VS Code, but keeps the
  // smoke shim buildable.
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${rand()}-${rand().slice(0, 4)}-4${rand().slice(0, 3)}-8${rand().slice(0, 3)}-${rand()}${rand().slice(0, 4)}`;
}

/** Generate a fresh graph-local node id (`n_1`, `n_2`, ...) that doesn't
 *  collide with any existing node in the given list. */
function generateLocalId(nodes: GraphNodeDto[]): string {
  const taken = new Set(nodes.map((n) => n.id));
  let i = 1;
  while (taken.has(`n_${i}`)) i += 1;
  return `n_${i}`;
}

// ---------------------------------------------------------------------------
// Counter-tree helpers (libraries/<slug>/counters.json)
// ---------------------------------------------------------------------------

interface CounterLoc {
  /** The array that directly contains the located node. */
  list: CounterNode[];
  /** Index of the node within `list`. */
  index: number;
  /** The node's parent, or null when the node is at the root level. */
  parent: CounterNode | null;
}

/** Depth-first locate a counter node by id, returning its containing array +
 *  index + parent so callers can splice/swap in place. */
function locateCounter(
  roots: CounterNode[],
  id: string,
  parent: CounterNode | null = null
): CounterLoc | null {
  for (let i = 0; i < roots.length; i++) {
    if (roots[i].id === id) return { list: roots, index: i, parent };
    const found = locateCounter(roots[i].children, id, roots[i]);
    if (found) return found;
  }
  return null;
}

/** Insert `node` into `list` right after the node with id `insertAfter`; when
 *  `insertAfter` is null or not found, append to the end. */
function insertIntoList(
  list: CounterNode[],
  node: CounterNode,
  insertAfter: string | null
): void {
  if (insertAfter) {
    const idx = list.findIndex((n) => n.id === insertAfter);
    if (idx >= 0) {
      list.splice(idx + 1, 0, node);
      return;
    }
  }
  list.push(node);
}

/** Coerce an untrusted seed payload into a `{ name, numbering }` pair with
 *  sensible defaults (matches the empty-state "+ Add first counter" seed). */
function readCounterSeed(raw: unknown): { name: string; numbering: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    name: typeof o.name === 'string' ? o.name : 'counter',
    numbering: typeof o.numbering === 'string' ? o.numbering : '1'
  };
}

/** Mint a fresh counter node with a stable uuid and no children. */
function makeCounterNode(seed: { name: string; numbering: string }): CounterNode {
  return {
    id: generateUuid(),
    name: seed.name,
    numbering: seed.numbering,
    children: []
  };
}
