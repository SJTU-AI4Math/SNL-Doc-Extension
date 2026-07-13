// SNL Create/Edit Library webview.
//
// Create mode: single-field form (title). Forwards to createLibrary; the host
// slugifies + creates the directory + writes meta.json.
//
// Edit mode: two panels stacked in the same webview.
//   1. Meta editor (top row): slug (readonly) + title, submits to
//      updateLibrary. Widens meta.json.
//   2. Outline editor (below): the branch-tree editor for graph.json.
//      Shows each Entry node with computed number / title / kind badge /
//      per-row Add-child / Add-sibling / Delete / Move up / Move down.
//      All graph mutations post `{ type: 'graphOp', op }` to the host.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { EntityIdSearchBox, ENTRY_VALIDATE_RULES } from './components/EntityIdSearchBox';
import type { EntryOption } from './render/EntryRender';

type Mode = 'create' | 'edit';

interface ExistingLibrary {
  slug: string;
  title: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; slug: string; title: string }
  | { kind: 'updated'; slug: string; title: string }
  | { kind: 'duplicate'; slug: string; message: string }
  | { kind: 'notFound'; slug: string; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Outline editor types (mirror host-side snlDoc DTOs)
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  label: string;
  props: { entryId?: string; [k: string]: unknown };
}

interface GraphRelationship {
  from: string;
  to: string;
  label: string;
}

interface EntryPoolItem {
  id: string;
  kind: string;
  title: string;
  content?: { snl?: string };
}

interface KindItem {
  id: string;
  name: string;
  numbering: string;
  coloring?: { stroke: string; background: string };
}

interface GraphState {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  entries: EntryPoolItem[];
  kinds: KindItem[];
  warnings: string[];
}

export function CreateLibraryApp(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('create');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [graph, setGraph] = useState<GraphState | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'context';
            mode: Mode;
            slug?: string;
            existing?: ExistingLibrary | null;
          }
        | { type: 'created'; slug: string; title: string }
        | { type: 'updated'; slug: string; title: string }
        | { type: 'duplicate'; slug: string; message: string }
        | { type: 'notFound'; slug: string; message: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'invalid'; message: string }
        | { type: 'error'; message: string }
        | {
            type: 'graph';
            nodes: GraphNode[];
            relationships: GraphRelationship[];
            entries: EntryPoolItem[];
            kinds: KindItem[];
            warnings: string[];
          }
        | { type: 'graphError'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setMode(msg.mode);
          if (msg.mode === 'edit') {
            setSlug(msg.slug ?? '');
            if (msg.existing) {
              setTitle(msg.existing.title);
            }
          }
          break;
        case 'created':
          setStatus({ kind: 'created', slug: msg.slug, title: msg.title });
          setTitle('');
          break;
        case 'updated':
          setStatus({ kind: 'updated', slug: msg.slug, title: msg.title });
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            slug: msg.slug,
            message: msg.message
          });
          break;
        case 'notFound':
          setStatus({
            kind: 'notFound',
            slug: msg.slug,
            message: msg.message
          });
          break;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          break;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          break;
        case 'invalid':
          setStatus({ kind: 'invalid', message: msg.message });
          break;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          break;
        case 'graph':
          setGraph({
            nodes: msg.nodes,
            relationships: msg.relationships,
            entries: msg.entries,
            kinds: msg.kinds,
            warnings: msg.warnings
          });
          setGraphError(null);
          break;
        case 'graphError':
          setGraphError(msg.message);
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const trimmed = title.trim();
  // Edit mode allows empty title changes? No — updateLibrary requires a
  // non-empty title, so keep the same gate.
  const canSubmit = trimmed.length > 0 && status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canSubmit) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      title: trimmed
    });
  }

  const postGraphOp = (op: Record<string, unknown>): void => {
    apiRef.current?.postMessage({ type: 'graphOp', op });
  };

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: mode === 'edit' ? '54rem' : '34rem' }}>
      {/* cat 2026-07-09: top nav — back to Dashboard; in edit mode also
          jump to this library in the Infoview. */}
      <PanelNav
        vsApi={apiRef.current}
        back={{
          label: 'Dashboard',
          title: 'Back to Dashboard',
          message: { type: 'nav.openDashboard' }
        }}
        viewInInfoview={
          mode === 'edit' && slug
            ? {
                label: 'View in Infoview',
                title: `Open library "${slug}" in the Infoview reading surface`,
                message: { type: 'nav.openInfoview', slug }
              }
            : undefined
        }
      />
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        {mode === 'edit' ? 'Edit Library' : 'Create Library'}
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        {mode === 'edit'
          ? 'Update this library\u2019s display title and outline. The slug (directory name) is immutable — delete + recreate to rename.'
          : 'Add a new library to the existing .SNL_Doc/. The title is written to libraries/<slug>/meta.json; the slug (directory name) is derived from the title.'}
      </p>

      {mode === 'edit' ? (
        // Edit mode: slug (readonly) + title on the same row so they read as
        // "directory / display name" instead of a stacked pair of near-duplicate
        // fields (per cat 2026-07-06).
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-end',
            marginBottom: '0.9rem'
          }}
        >
          <div style={{ flex: '0 1 12rem', minWidth: 0 }}>
            <label
              htmlFor="snl-library-slug"
              style={{
                display: 'block',
                marginBottom: '0.35rem',
                fontWeight: 600
              }}
            >
              Slug (readonly)
            </label>
            <input
              id="snl-library-slug"
              type="text"
              value={slug}
              readOnly
              title="IDs / slugs are immutable; delete + recreate to rename"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.4rem 0.55rem',
                color: 'var(--vscode-descriptionForeground, #999)',
                background: 'var(--vscode-input-background, #2a2a2a)',
                border:
                  '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #444))',
                borderRadius: '2px',
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                fontSize: '0.95rem',
                opacity: 0.7,
                cursor: 'not-allowed'
              }}
            />
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <label
              htmlFor="snl-library-title"
              style={{
                display: 'block',
                marginBottom: '0.35rem',
                fontWeight: 600
              }}
            >
              Library title
            </label>
            <input
              id="snl-library-title"
              type="text"
              value={title}
              placeholder="e.g. Real Analysis"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSubmit();
                }
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.4rem 0.55rem',
                color: 'var(--vscode-input-foreground, #ddd)',
                background: 'var(--vscode-input-background, #2a2a2a)',
                border:
                  '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
                borderRadius: '2px',
                fontFamily: 'inherit',
                fontSize: '0.95rem'
              }}
            />
          </div>
        </div>
      ) : (
        // Create mode: single title field (no slug to preview until the user
        // types something and the host slugifies on submit).
        <>
          <label
            htmlFor="snl-library-title"
            style={{
              display: 'block',
              marginBottom: '0.35rem',
              fontWeight: 600
            }}
          >
            Library title
          </label>
          <input
            id="snl-library-title"
            type="text"
            value={title}
            placeholder="e.g. Real Analysis"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSubmit();
              }
            }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '0.4rem 0.55rem',
              marginBottom: '0.9rem',
              color: 'var(--vscode-input-foreground, #ddd)',
              background: 'var(--vscode-input-background, #2a2a2a)',
              border:
                '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
              borderRadius: '2px',
              fontFamily: 'inherit',
              fontSize: '0.95rem'
            }}
          />
        </>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={primaryButton(canSubmit)}
      >
        {status.kind === 'creating'
          ? mode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
          : mode === 'edit' ? 'Update Title' : 'Create Library'}
      </button>

      <StatusLine status={status} />

      {mode === 'edit' ? (
        <OutlineEditor
          graph={graph}
          error={graphError}
          onGraphOp={postGraphOp}
          onOpenEntry={(entryId) =>
            apiRef.current?.postMessage({ type: 'openEditEntry', entryId })
          }
        />
      ) : null}
    </main>
  );
}

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `\u2705 Created library "${status.title}" (slug: ${status.slug}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = `\u2705 Updated library "${status.title}" (slug: ${status.slug}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'notFound') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'noSnlDoc') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'noWorkspace') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'invalid') {
    text = `\u274c Invalid: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = `\u274c Error: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}

// ===========================================================================
// Outline editor (edit mode only)
// ===========================================================================

// Import the pure numbering engine from the shared src/ module. It has no
// vscode dependency so vite bundles it into the webview cleanly.
import { numberFor, readingOrder as computeReadingOrder } from '../../src/libraryGraph';

interface OutlineEditorProps {
  graph: GraphState | null;
  error: string | null;
  onGraphOp: (op: Record<string, unknown>) => void;
  /** Open the Edit Entry panel for a row's entry id (cat 2026-07-12). */
  onOpenEntry: (entryId: string) => void;
}

/**
 * Branch-tree editor for `libraries/<slug>/graph.json`. Shows the outline as
 * a nested indented list with per-row action buttons. All mutations post
 * `{ type: 'graphOp', op }` to the host, which mutates the file and re-pushes
 * the fresh graph — one-way data flow, no local optimistic state.
 */
function OutlineEditor({
  graph,
  error,
  onGraphOp,
  onOpenEntry
}: OutlineEditorProps): React.ReactElement {
  // Local UI state: which node is expanded (default: all root children
  // expanded; drill deeper on click). Persists across host pushes.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Optional "adding" mode: which parent is currently being extended, and
  // just the entryId the user is typing (cat 2026-07-06: reference-only,
  // create-mode is routed to the CreateEntry panel instead).
  const [addingUnder, setAddingUnder] = useState<{
    parentId: string | null;
    insertAfter: string | null;
    entryId: string;
  } | null>(null);

  // Precompute indices for the current graph.
  const { childrenOf, roots, entriesById, kindsById } = useMemo(() => {
    if (!graph) {
      return {
        childrenOf: new Map<string, string[]>(),
        roots: [] as string[],
        entriesById: new Map<string, EntryPoolItem>(),
        kindsById: new Map<string, KindItem>()
      };
    }
    const childrenOf = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const r of graph.relationships) {
      if (r.label !== 'branch') continue;
      const list = childrenOf.get(r.from);
      if (list) list.push(r.to);
      else childrenOf.set(r.from, [r.to]);
      hasParent.add(r.to);
    }
    const roots: string[] = [];
    for (const n of graph.nodes) {
      if (!hasParent.has(n.id)) roots.push(n.id);
    }
    const entriesById = new Map<string, EntryPoolItem>();
    for (const e of graph.entries) entriesById.set(e.id, e);
    const kindsById = new Map<string, KindItem>();
    for (const k of graph.kinds) kindsById.set(k.id, k);
    return { childrenOf, roots, entriesById, kindsById };
  }, [graph]);

  // Projection for the EntityIdSearchBox in AddNodeForm. Kept separate from
  // entriesById so keystroke-driven filter re-renders don't re-project the
  // whole pool. `hasContent` is derived from `content.snl` presence — same
  // rule the render layer uses to decide "stub or real". Cat 2026-07-09.
  const entryOptions = useMemo<EntryOption[]>(() => {
    if (!graph) return [];
    return graph.entries.map((e) => ({
      id: e.id,
      title: e.title ?? '',
      hasContent:
        typeof e.content?.snl === 'string' && e.content.snl.trim().length > 0
    }));
  }, [graph]);

  // Compute reading order and number-for-each-node in one pass.
  const numbersById = useMemo(() => {
    const out = new Map<string, string | null>();
    if (!graph) return out;
    const order = computeReadingOrder({
      nodes: graph.nodes,
      relationships: graph.relationships
    });
    for (const id of order) {
      out.set(
        id,
        numberFor(
          { nodes: graph.nodes, relationships: graph.relationships },
          id,
          entriesById as unknown as Map<string, { kind?: string }>,
          kindsById as unknown as Map<string, { numbering: string }>
        )
      );
    }
    return out;
  }, [graph, entriesById, kindsById]);

  const toggleCollapsed = (nodeId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const startAdd = (
    parentId: string | null,
    insertAfter: string | null
  ): void => {
    setAddingUnder({ parentId, insertAfter, entryId: '' });
  };

  const cancelAdd = (): void => setAddingUnder(null);

  const commitAdd = (): void => {
    if (!addingUnder) return;
    const entryIdTrimmed = addingUnder.entryId.trim();
    if (!entryIdTrimmed) {
      // Empty id → route to Create Entry panel; DON'T close the popover
      // so the user can paste the fresh id when they come back.
      apiRef.current?.postMessage({ type: 'openCreateEntry' });
      return;
    }
    onGraphOp({
      op: 'addNode',
      parentId: addingUnder.parentId,
      insertAfter: addingUnder.insertAfter,
      entryId: entryIdTrimmed
    });
    setAddingUnder(null);
  };

  if (!graph) {
    return (
      <section style={{ marginTop: '2rem' }}>
        <h2 style={SECTION_HEADING_STYLE}>Outline</h2>
        <p style={{ opacity: 0.7 }}>{error ?? 'Loading outline…'}</p>
      </section>
    );
  }

  return (
    <section style={{ marginTop: '2rem' }}>
      {/* Cat 2026-07-09: pure-CSS hover reveal for the per-row toolbar.
          See OutlineRow's block comment for why this replaced the earlier
          useState + pointerEvents approach. `opacity` (not visibility) lets
          the button remain tab-focusable and hit-testable — the surrounding
          row can still be hovered while a button is under the cursor. */}
      <style>{`
        .snl-outline-row-toolbar {
          opacity: 0;
          transition: opacity 90ms ease-in;
        }
        .snl-outline-row:hover .snl-outline-row-toolbar,
        .snl-outline-row:focus-within .snl-outline-row-toolbar {
          opacity: 1;
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '0.5rem'
        }}
      >
        <h2 style={{ ...SECTION_HEADING_STYLE, margin: 0 }}>Outline</h2>
        <span style={{ opacity: 0.65, fontSize: '0.85rem' }}>
          {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'} ·{' '}
          {graph.relationships.filter((r) => r.label === 'branch').length} branch edge
          {graph.relationships.filter((r) => r.label === 'branch').length === 1 ? '' : 's'}
        </span>
      </div>

      {error ? <ErrorBanner message={error} /> : null}
      {graph.warnings.length > 0 ? <WarningBanner warnings={graph.warnings} /> : null}

      {roots.length === 0 ? (
        <div style={{ opacity: 0.75, fontStyle: 'italic', marginBottom: '0.75rem' }}>
          No entries yet — click "Add root entry" below.
        </div>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {roots.map((rootId) => (
            <OutlineRow
              key={rootId}
              nodeId={rootId}
              depth={0}
              graph={graph}
              childrenOf={childrenOf}
              entriesById={entriesById}
              entryOptions={entryOptions}
              kindsById={kindsById}
              numbersById={numbersById}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              addingUnder={addingUnder}
              onStartAdd={startAdd}
              onCancelAdd={cancelAdd}
              onCommitAdd={commitAdd}
              onUpdateAdd={setAddingUnder}
              onGraphOp={onGraphOp}
              onOpenEntry={onOpenEntry}
            />
          ))}
        </ol>
      )}

      {/* Root-level add: no parent. */}
      {addingUnder && addingUnder.parentId === null && addingUnder.insertAfter === null ? (
        <AddNodeForm
          kinds={graph.kinds}
          entriesById={entriesById}
          entryOptions={entryOptions}
          state={addingUnder}
          onCancel={cancelAdd}
          onCommit={commitAdd}
          onUpdate={setAddingUnder}
        />
      ) : (
        <button
          type="button"
          onClick={() => startAdd(null, null)}
          style={{ ...toolbarButtonStyle(false), marginTop: '0.75rem' }}
        >
          + Add root entry
        </button>
      )}
    </section>
  );
}

interface OutlineRowProps {
  nodeId: string;
  depth: number;
  graph: GraphState;
  childrenOf: Map<string, string[]>;
  entriesById: Map<string, EntryPoolItem>;
  entryOptions: EntryOption[];
  kindsById: Map<string, KindItem>;
  numbersById: Map<string, string | null>;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
  addingUnder: {
    parentId: string | null;
    insertAfter: string | null;
    entryId: string;
  } | null;
  onStartAdd: (parentId: string | null, insertAfter: string | null) => void;
  onCancelAdd: () => void;
  onCommitAdd: () => void;
  onUpdateAdd: (
    s: {
      parentId: string | null;
      insertAfter: string | null;
      entryId: string;
    } | null
  ) => void;
  onGraphOp: (op: Record<string, unknown>) => void;
  onOpenEntry: (entryId: string) => void;
}

function OutlineRow(props: OutlineRowProps): React.ReactElement {
  const {
    nodeId,
    depth,
    graph,
    childrenOf,
    entriesById,
    entryOptions,
    kindsById,
    numbersById,
    collapsed,
    onToggleCollapsed,
    addingUnder,
    onStartAdd,
    onCancelAdd,
    onCommitAdd,
    onUpdateAdd,
    onGraphOp,
    onOpenEntry
  } = props;

  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return <li>{null}</li>;

  const entry = node.props.entryId
    ? entriesById.get(node.props.entryId)
    : undefined;
  const kind = entry?.kind ? kindsById.get(entry.kind) : undefined;
  const kids = childrenOf.get(nodeId) ?? [];
  const isCollapsed = collapsed.has(nodeId);
  const hasKids = kids.length > 0;
  const num = numbersById.get(nodeId);

  // Cat 2026-07-09: indent/outdent enablement. Mirrors the host-side
  // guards so the button reflects reality and the user isn't left
  // wondering why a click did nothing.
  const parentRel = graph.relationships.find(
    (r) => r.label === 'branch' && r.to === nodeId
  );
  const canOutdent = !!parentRel; // roots have no parent to escape
  let canIndent: boolean;
  if (parentRel) {
    // Non-root: enabled iff a previous sibling under the same parent exists.
    const siblings = graph.relationships.filter(
      (r) => r.label === 'branch' && r.from === parentRel.from
    );
    const myPos = siblings.findIndex((r) => r.to === nodeId);
    canIndent = myPos > 0;
  } else {
    // Root: enabled iff a previous root exists in nodes[] order.
    const isRoot = (nid: string): boolean =>
      !graph.relationships.some(
        (r) => r.label === 'branch' && r.to === nid
      );
    const myIdx = graph.nodes.findIndex((n) => n.id === nodeId);
    canIndent = false;
    for (let j = myIdx - 1; j >= 0; j--) {
      if (isRoot(graph.nodes[j].id)) {
        canIndent = true;
        break;
      }
    }
  }

  const title = entry?.title ?? '';
  const displayTitle =
    title.trim().length > 0 ? title : <em style={{ opacity: 0.65 }}>(untitled)</em>;

  // Cat 2026-07-09: "现在右边一排按钮太繁冗，改成鼠标悬浮在哪一条上显示哪
  // 一条的按钮". Second pass 2026-07-09 (bug report: "多个条目同时显示按钮"
  // + "删条目还是删不掉"). Root cause of both:
  //   The first implementation used `useState + onPointerEnter/Leave` and
  //   `pointerEvents: none` when not hovered. React's pointer events can
  //   drop a `leave` firing when the mouse moves fast between rows, which
  //   left multiple rows stuck in the `hovered=true` state. Worse, if the
  //   hover state ever flipped for a frame while the user was mid-click
  //   on Delete, `pointerEvents: none` swallowed the click, giving the
  //   "delete doesn't work" symptom.
  //
  //   Fix: use pure CSS `:hover` + `:focus-within` — browser-native pointer
  //   tracking never loses a leave event, and there's no `pointerEvents`
  //   toggle to intercept clicks. We keep the toolbar in the DOM (opacity
  //   0 by default) so layout stays stable when it becomes visible. No
  //   useState needed. Global CSS injected once at the App root; see
  //   `<style>` below.
  return (
    <li style={{ marginBottom: '0.15rem' }}>
      <div
        className="snl-outline-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          paddingLeft: `${depth * 1.5}rem`,
          padding: '0.3rem 0',
          borderBottom:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
          // Cat 2026-07-09: depth-tinted background matching the macro-
          // style pattern in PackagePanel (extra style rows get a subtle
          // white wash to visually anchor them as members of a collapsible
          // group). Library outlines nest deeper than the 2-level macro
          // rows, so we scale the alpha per depth with a small cap so
          // deeply-nested rows don't blow out. depth=0 stays transparent.
          background:
            depth === 0
              ? 'transparent'
              : `rgba(255,255,255,${Math.min(0.02 * depth, 0.12)})`
        }}
      >
        {/* Expand / collapse toggle (or spacer when leaf). */}
        {hasKids ? (
          <button
            type="button"
            onClick={() => onToggleCollapsed(nodeId)}
            style={disclosureButtonStyle()}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            {isCollapsed ? '▶' : '▼'}
          </button>
        ) : (
          <span style={{ width: '1.2rem', display: 'inline-block' }} />
        )}

        <span
          style={{
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.8rem',
            color: 'var(--vscode-descriptionForeground, #999)',
            minWidth: '3rem'
          }}
        >
          {num ?? '—'}
        </span>

        {kind ? <KindBadge kind={kind} /> : null}

        {/* Title = click target that opens Edit Entry for this row's entry.
            Cat 2026-07-12: 'Edit Library Tree view 每一 entry 的行都应该
            可以点击, 进入 entry 的编辑页面.' Only clickable when the row
            actually resolves to an entry (nodes without entryId show a
            greyed non-clickable label). The chevron / copy-id / toolbar
            buttons live in siblings and their own onClick handlers still
            win (React events bubble up from the button, but each of them
            already stops propagation via not being nested inside this
            span). */}
        {entry ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenEntry(entry.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenEntry(entry.id);
              }
            }}
            style={{
              flex: '1 1 auto',
              fontSize: '0.95rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              textDecoration: 'none'
            }}
            className="snl-outline-row-title"
            title={`Open Edit Entry: ${entry.id}\nkind: ${entry.kind}`}
          >
            {displayTitle}
          </span>
        ) : (
          <span
            style={{
              flex: '1 1 auto',
              fontSize: '0.95rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              opacity: 0.7
            }}
            title={`no entryId assigned (node ${nodeId})`}
          >
            {displayTitle}
          </span>
        )}

        {/* Compact entryId badge — click to copy, so you can paste it into
            another library's Add form to reference this same entry. */}
        {entry ? (
          <button
            type="button"
            title={`Click to copy entry id\n${entry.id}`}
            onClick={() => {
              const id = entry.id;
              void (async () => {
                try {
                  await navigator.clipboard.writeText(id);
                } catch {
                  // Some webview contexts disable clipboard API. Fall back
                  // to a text-selection trick.
                  const ta = document.createElement('textarea');
                  ta.value = id;
                  document.body.appendChild(ta);
                  ta.select();
                  try {
                    document.execCommand('copy');
                  } catch {
                    // give up silently
                  }
                  document.body.removeChild(ta);
                }
              })();
            }}
            style={{
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: '0.7rem',
              padding: '0.15rem 0.35rem',
              border:
                '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
              borderRadius: '2px',
              background: 'transparent',
              color: 'var(--vscode-descriptionForeground, #999)',
              cursor: 'pointer',
              flexShrink: 0,
              maxWidth: '9rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {entry.id.slice(0, 8)}…
          </button>
        ) : null}

        <div
          className="snl-outline-row-toolbar"
          style={{
            display: 'flex',
            gap: '0.25rem',
            flexShrink: 0
            // Visibility handled entirely by CSS `:hover` / `:focus-within`
            // on `.snl-outline-row` — see the <style> block in the App
            // component. NO inline conditional on visibility/pointerEvents
            // here; React state was losing `pointerleave` events which
            // stuck multiple rows in the "shown" state and (worse) ate
            // Delete clicks via `pointerEvents: none`. Cat 2026-07-09.
          }}
        >
          <IconButton
            label="+ child"
            title="Add a child entry"
            onClick={() => onStartAdd(nodeId, null)}
          />
          <IconButton
            label="+ sibling"
            title="Add a sibling after this entry"
            onClick={() => {
              // If this node is a root, "add sibling" = add another root
              // right after it. We pass parentId=null + insertAfter=nodeId;
              // the host handles the root case by appending to nodes[].
              // TODO: root-sibling insertion post-position is not perfect
              // (host currently only re-orders roots via moveSibling), but
              // for v1 the "add sibling" just tacks onto the end of the
              // parent's chain if we're not at root.
              const parentRel = graph.relationships.find(
                (r) => r.label === 'branch' && r.to === nodeId
              );
              if (parentRel) {
                onStartAdd(parentRel.from, nodeId);
              } else {
                // Root: add another root at the tail. insertAfter isn't
                // meaningful for roots yet.
                onStartAdd(null, null);
              }
            }}
          />
          {/* Cat 2026-07-09: indent / outdent pair. Disabled when it
              would be a no-op (indent needs a previous sibling, outdent
              needs a parent) so users can see reachability at a glance. */}
          <IconButton
            label="←|"
            title={
              canOutdent
                ? 'Outdent — promote to sibling of parent'
                : 'Outdent unavailable — already at the top level'
            }
            disabled={!canOutdent}
            onClick={() => onGraphOp({ op: 'outdent', nodeId })}
          />
          <IconButton
            label="→|"
            title={
              canIndent
                ? 'Indent — make this entry a child of its previous sibling'
                : 'Indent unavailable — no previous sibling to nest under'
            }
            disabled={!canIndent}
            onClick={() => onGraphOp({ op: 'indent', nodeId })}
          />
          <IconButton
            label="↑"
            title="Move up (swap with previous sibling)"
            onClick={() => onGraphOp({ op: 'moveSibling', nodeId, direction: 'up' })}
          />
          <IconButton
            label="↓"
            title="Move down (swap with next sibling)"
            onClick={() => onGraphOp({ op: 'moveSibling', nodeId, direction: 'down' })}
          />
          <IconButton
            label="✕"
            title="Delete this entry from the outline (does not delete the shared-pool entry)"
            destructive
            onClick={() => {
              // Cat 2026-07-09: window.confirm() is blocked in VS Code
              // webviews (returns undefined), so we cannot gate here.
              // The host-side deleteNode handler now owns the modal
              // confirmation; we just post the op and let it prompt.
              // The child-count guard also lives host-side.
              onGraphOp({ op: 'deleteNode', nodeId });
            }}
          />
        </div>
      </div>

      {/* "add child" or "add sibling" popover attached below this row.
       *
       * Bug (cat 2026-07-08): earlier this used a plain OR
       * `parentId === nodeId || insertAfter === nodeId`. In the
       * "+ sibling on non-root Y (parent P)" case both branches
       * fired — Row P matched on `parentId===P` AND Row Y matched
       * on `insertAfter===Y` — producing two AddNodeForm inputs.
       *
       * The two operations are distinguishable by `insertAfter`:
       *   + child   : parentId=here,  insertAfter=null   → attach under HERE
       *   + sibling : parentId=parent, insertAfter=here  → attach under HERE
       * so a child popover MUST also require `insertAfter===null`
       * to avoid poaching the parent row on a sibling insert.
       * Root-sibling (both null) is handled by the top-level
       * <AddNodeForm/> in the outer render, not here. */}
      {addingUnder &&
      ((addingUnder.parentId === nodeId && addingUnder.insertAfter === null) ||
        addingUnder.insertAfter === nodeId) ? (
        <div style={{ paddingLeft: `${(depth + 1) * 1.5}rem` }}>
          <AddNodeForm
            kinds={graph.kinds}
            entriesById={entriesById}
            entryOptions={entryOptions}
            state={addingUnder}
            onCancel={onCancelAdd}
            onCommit={onCommitAdd}
            onUpdate={onUpdateAdd}
          />
        </div>
      ) : null}

      {!isCollapsed && hasKids ? (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {kids.map((kid) => (
            <OutlineRow
              key={kid}
              {...props}
              nodeId={kid}
              depth={depth + 1}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function KindBadge({ kind }: { kind: KindItem }): React.ReactElement {
  const color = kind.coloring;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.1rem 0.45rem',
        fontSize: '0.75rem',
        borderRadius: '3px',
        border: color ? `1px solid ${color.stroke}` : '1px solid #666',
        background: color ? color.background : 'transparent',
        color: color ? '#222' : 'inherit',
        fontWeight: 600,
        flexShrink: 0
      }}
    >
      {kind.name}
    </span>
  );
}

function AddNodeForm({
  entriesById,
  entryOptions,
  state,
  onCancel,
  onCommit,
  onUpdate
}: {
  // kinds is unused now (Create routes to CreateEntry panel), but kept in
  // the prop shape to avoid churn at the callsites.
  kinds: KindItem[];
  entriesById: Map<string, EntryPoolItem>;
  /**
   * Shared pool projected as EntryOption[] for the {@link EntityIdSearchBox}.
   * Kept alongside `entriesById` (rather than derived inside the form) so
   * the projection cost is paid once per graph fetch, not per keystroke.
   * Cat 2026-07-09.
   */
  entryOptions: EntryOption[];
  state: {
    parentId: string | null;
    insertAfter: string | null;
    entryId: string;
  };
  onCancel: () => void;
  onCommit: () => void;
  onUpdate: (
    s: {
      parentId: string | null;
      insertAfter: string | null;
      entryId: string;
    } | null
  ) => void;
}): React.ReactElement {
  const entryIdTrimmed = state.entryId.trim();
  const isEmpty = entryIdTrimmed.length === 0;
  const referencedEntry = !isEmpty ? entriesById.get(entryIdTrimmed) : undefined;

  // Three states drive the visual language (cat 2026-07-06):
  //   1. empty        → "Create" button opens the CreateEntry panel
  //   2. matched      → green border + ✓ badge + Reference button
  //   3. no-match     → yellow border + ⚠ badge + Create button (will
  //                     mint a fresh entry via CreateEntry panel too;
  //                     what the user typed becomes irrelevant because
  //                     they haven't paste-copied an existing id yet)
  type Mode = 'empty' | 'matched' | 'nomatch';
  const mode: Mode = isEmpty ? 'empty' : referencedEntry ? 'matched' : 'nomatch';

  const buttonLabel = mode === 'matched' ? 'Reference' : 'Create';

  const borderColor =
    mode === 'matched'
      ? 'var(--vscode-testing-iconPassed, #4ec9b0)'
      : mode === 'nomatch'
        ? 'var(--vscode-inputValidation-warningBorder, #b89500)'
        : 'var(--vscode-focusBorder, var(--vscode-contrastActiveBorder, #007fd4))';

  const statusColor =
    mode === 'matched'
      ? 'var(--vscode-testing-iconPassed, #4ec9b0)'
      : mode === 'nomatch'
        ? 'var(--vscode-editorWarning-foreground, #cca700)'
        : 'var(--vscode-descriptionForeground, #999)';

  const statusIcon = mode === 'matched' ? '✓' : mode === 'nomatch' ? '⚠' : '';

  return (
    <div
      style={{
        margin: '0.35rem 0',
        padding: '0.6rem 0.75rem',
        borderRadius: '5px',
        border: `1px solid ${borderColor}`,
        background:
          'var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e))',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem'
      }}
    >
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <label
          htmlFor="snl-outline-entryid"
          style={{
            flex: '0 0 auto',
            fontSize: '0.8rem',
            opacity: 0.75,
            paddingTop: '0.4rem'
          }}
        >
          Entry id
        </label>
        <div style={{ flex: '1 1 auto' }}>
          {/* Cat 2026-07-09: replace the bare paste-uuid input with an
              autocomplete-backed picker. `allowNew=true` keeps the
              "type a new id, click Create" path working — a value not in
              the pool commits verbatim and drives the 'nomatch' mode below.
              The picker's own resolved-title chip is redundant with our
              existing status line (`Reference: "…" — kind: …`), so we hide
              it visually by placing the picker alone; the status row below
              carries the same info in this component's design language. */}
          <EntityIdSearchBox
            entries={entryOptions}
            value={state.entryId}
            validate={ENTRY_VALIDATE_RULES.permitNew}
            hideResolvedChip
            autoFocus
            idPrefix="snl-outline-entryid"
            placeholder="Search existing entry, or type a new id and click Create"
            onChange={(next) =>
              onUpdate({
                parentId: state.parentId,
                insertAfter: state.insertAfter,
                entryId: next
              })
            }
            inputStyle={{
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: '0.8rem',
              border: `1px solid ${borderColor}`
            }}
          />
        </div>
        {statusIcon ? (
          <span
            style={{
              flex: '0 0 auto',
              fontSize: '1.1rem',
              lineHeight: 1,
              color: statusColor,
              fontWeight: 700,
              width: '1.25rem',
              textAlign: 'center',
              paddingTop: '0.4rem'
            }}
            aria-hidden
          >
            {statusIcon}
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem'
        }}
      >
        <span
          style={{
            flex: '1 1 auto',
            fontSize: '0.78rem',
            color: statusColor
          }}
        >
          {mode === 'matched'
            ? `Reference: "${referencedEntry?.title || '(untitled)'}" — kind: ${referencedEntry?.kind}`
            : mode === 'nomatch'
              ? `No entry with id "${entryIdTrimmed}" — Create will add a new one`
              : 'Empty — Create will open the Create Entry panel'}
        </span>
        <button type="button" onClick={onCommit} style={toolbarButtonStyle(true)}>
          {buttonLabel}
        </button>
        <button type="button" onClick={onCancel} style={toolbarButtonStyle(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }): React.ReactElement {
  return (
    <div
      role="alert"
      style={{
        margin: '0 0 0.75rem',
        padding: '0.5rem 0.75rem',
        borderRadius: '4px',
        border:
          '1px solid var(--vscode-inputValidation-errorBorder, #be1100)',
        background:
          'var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.15))',
        color: 'var(--vscode-errorForeground, #f48771)',
        fontSize: '0.85rem'
      }}
    >
      ❌ {message}
    </div>
  );
}

function WarningBanner({
  warnings
}: {
  warnings: string[];
}): React.ReactElement {
  return (
    <div
      role="status"
      style={{
        margin: '0 0 0.75rem',
        padding: '0.5rem 0.75rem',
        borderRadius: '4px',
        border:
          '1px solid var(--vscode-inputValidation-warningBorder, #b89500)',
        background:
          'var(--vscode-inputValidation-warningBackground, rgba(184,149,0,0.15))',
        fontSize: '0.8rem'
      }}
    >
      <div style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
        ⚠️ {warnings.length} graph warning{warnings.length === 1 ? '' : 's'}
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {warnings.slice(0, 5).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        {warnings.length > 5 ? (
          <li style={{ opacity: 0.7 }}>… {warnings.length - 5} more</li>
        ) : null}
      </ul>
    </div>
  );
}

function IconButton({
  label,
  title,
  onClick,
  destructive,
  disabled
}: {
  label: string;
  title: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  // Cat 2026-07-09: all buttons now go through the shared Button
  // component so hover / active / focus feedback is consistent. IconButton
  // becomes a thin size='sm' wrapper.
  return (
    <Button
      variant={destructive ? 'destructive' : 'secondary'}
      size="sm"
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

function toolbarButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0.35rem 0.75rem',
    fontFamily: 'inherit',
    fontSize: '0.85rem',
    border:
      '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
    borderRadius: '4px',
    background: active
      ? 'var(--vscode-button-background, var(--vscode-button-secondaryBackground, #0e639c))'
      : 'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
    color: active
      ? 'var(--vscode-button-foreground, #fff)'
      : 'inherit',
    cursor: 'pointer'
  };
}

function disclosureButtonStyle(): React.CSSProperties {
  return {
    width: '1.2rem',
    height: '1.2rem',
    padding: 0,
    fontSize: '0.7rem',
    lineHeight: 1,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    flexShrink: 0
  };
}

const SECTION_HEADING_STYLE: React.CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 600,
  marginTop: 0,
  marginBottom: '0.5rem'
};
