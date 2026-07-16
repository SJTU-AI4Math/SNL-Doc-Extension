import * as vscode from 'vscode';
import {
  addEntry,
  createLibrary,
  readEntries,
  readEntryKinds,
  readLibraryCounters,
  readLibraryGraph,
  readLibraryMeta,
  updateLibrary,
  writeLibraryCounters,
  writeLibraryGraph,
  type CounterNode,
  type EntryData,
  type EntryKind,
  type GraphNodeDto,
  type GraphRelationshipDto
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage,
  installSnlDocWatcher
} from './panelUtil';

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

    installSnlDocWatcher(this.disposables, () => this.pushContext());

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    if (this.mode === 'create') {
      void this.panel.webview.postMessage({ type: 'context', mode: 'create' });
      return;
    }
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        slug: this.slug,
        existing: null
      });
      return;
    }
    try {
      // meta.json is the source of truth for title (per Task 1 refactor).
      const metaResult = await readLibraryMeta(root, this.slug);
      const title =
        metaResult.status === 'ok' && typeof metaResult.meta.title === 'string'
          ? metaResult.meta.title
          : this.slug;
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        slug: this.slug,
        existing: { slug: this.slug, title }
      });
      // Push the outline immediately after context so the webview has
      // everything it needs to render in one paint.
      await this.pushGraph();
      // Counters live in a separate file (libraries/<slug>/counters.json);
      // push them alongside the graph so the Counters section renders in the
      // same paint. The .SNL_Doc/** watcher re-invokes pushContext on any
      // external counters.json edit, keeping the tree fresh.
      await this.pushCounters('countersLoaded');
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  /** Push the current graph + entry pool + kinds to the webview so the
   *  outline editor can re-render. */
  private async pushGraph(): Promise<void> {
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
      const entries: EntryData[] = await readEntries(root);
      const kinds: EntryKind[] = await readEntryKinds(root);
      void this.panel.webview.postMessage({
        type: 'graph',
        nodes,
        relationships,
        entries,
        kinds,
        warnings
      });
    } catch (err) {
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
      | { type?: string; title?: string; op?: unknown }
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
        const result = await updateLibrary(workspaceRoot, this.slug, { title });
                switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Library "${result.slug}" title updated to "${result.title}".`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              slug: result.slug,
              title: result.title
            });
            return;
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
   *   - addNode: { op: 'addNode', parentId | null, entryId?, kind?, title?, insertAfter? }
   *       Two modes decided by `entryId`:
   *       (a) entryId non-empty  → REFERENCE mode. Validates that this
   *           entryId exists in the shared pool, then creates a graph node
   *           pointing at it. `kind` and `title` are ignored — the entry
   *           already carries them. Enables one entry being outlined in
   *           multiple libraries (cat 2026-07-06: "一个 entry 能属多个
   *           library").
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
   *   - moveSibling: { op: 'moveSibling', nodeId, direction: 'up' | 'down' }
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
      if (gRead.status === 'ok') {
        nodes = gRead.result.graph.nodes.slice();
        relationships = gRead.result.graph.relationships.slice();
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
            // REFERENCE mode: entryId must exist in the shared pool.
            const pool = await readEntries(root);
            if (!pool.some((e) => e && e.id === rawEntryId)) {
              void this.panel.webview.postMessage({
                type: 'graphError',
                message: `addNode: entry "${rawEntryId}" not found in shared pool. Leave the id field empty to create a new entry.`
              });
              return;
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
          nodes.push({
            id: nodeLocalId,
            label: 'Entry',
            props: { entryId: entryUuid }
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
          // Find this node's parent branch edge, and its sibling under the
          // same parent to swap with. For a root node the "parent" is
          // conceptually the roots list — swap the two nodes' declaration
          // order in nodes[].
          const parentRel = relationships.find(
            (r) => r.label === 'branch' && r.to === nodeId
          );
          if (!parentRel) {
            // Root case: swap in nodes[] declaration order.
            const idx = nodes.findIndex((n) => n.id === nodeId);
            if (idx < 0) return;
            // Find nearest sibling ROOT (also has no parent).
            const isRoot = (nid: string): boolean =>
              !relationships.some(
                (r) => r.label === 'branch' && r.to === nid
              );
            const step = direction === 'up' ? -1 : 1;
            for (let j = idx + step; j >= 0 && j < nodes.length; j += step) {
              if (isRoot(nodes[j].id)) {
                const tmp = nodes[idx];
                nodes[idx] = nodes[j];
                nodes[j] = tmp;
                break;
              }
            }
            break;
          }
          const parentId = parentRel.from;
          // Enumerate this parent's branch edges in relationships[] order.
          const siblingRelIndices: number[] = [];
          for (let i = 0; i < relationships.length; i++) {
            const r = relationships[i];
            if (r.label === 'branch' && r.from === parentId) {
              siblingRelIndices.push(i);
            }
          }
          const myRelPos = siblingRelIndices.findIndex(
            (i) => relationships[i].to === nodeId
          );
          if (myRelPos < 0) return;
          const swapRelPos =
            direction === 'up' ? myRelPos - 1 : myRelPos + 1;
          if (swapRelPos < 0 || swapRelPos >= siblingRelIndices.length) {
            // Already at edge; no-op.
            return;
          }
          const a = siblingRelIndices[myRelPos];
          const b = siblingRelIndices[swapRelPos];
          const tmp = relationships[a];
          relationships[a] = relationships[b];
          relationships[b] = tmp;
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
      });
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
    type: 'countersLoaded' | 'countersPushed'
  ): Promise<void> {
    if (this.mode !== 'edit') return;
    const root = firstWorkspaceFolder();
    if (!root) return;
    try {
      const counters = await readLibraryCounters(root, this.slug);
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
      const roots = await readLibraryCounters(root, this.slug);
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

      await writeLibraryCounters(root, this.slug, roots);
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
