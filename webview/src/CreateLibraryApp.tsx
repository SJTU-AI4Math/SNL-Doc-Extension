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
import type { Localized } from '@sjtu-ai4math/snl-basics/runtime';
import type { ThemedKindColoring } from '../../src/kindColoring';
import { resolveWebviewKindColoring } from './render/kindColoring';
import {
  editorDraftKey,
  loadDraft,
  saveDraft,
  usePersistedDraft,
  useSaveShortcut
} from './components/draftState';
import {
  useVsCodeApiRef,
  PANEL_STYLE
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { MissingEditorTarget } from './components/MissingEditorTarget';
import { Button } from './components/Button';
import { EmptyAction } from './components/EmptyAction';
import { EntityIdSearchBox, ENTRY_VALIDATE_RULES } from './components/EntityIdSearchBox';
import { TreeOutlineEditor, type TreeOp } from './components/TreeOutlineEditor';
import './CreateLibraryApp.css';
import {
  computeEntryMetricsForIds,
  DEFAULT_ENTRY_METRIC_THRESHOLDS,
  EntryMetricValue,
  type EntryMetricResult,
  type EntryMetricThresholds,
  type SnlMacroSourceLookup
} from './components/EntryMetrics';
import type { EntryOption } from './render/EntryRender';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import { resolve_localized_string } from '../../src/localizedContent';
import { use_content_language } from './runtime/preferencesRuntime';

const LIBRARY_MESSAGES = defineUiMessages(
  'libraryEditor',
  {
    editLibrary: 'Edit Library', createLibrary: 'Create Library', dashboard: 'Dashboard',
    backDashboard: 'Back to Dashboard', viewInfoview: 'View in Infoview',
    openInfoview: 'Open library "{slug}" in the Infoview reading surface',
    editHelp: 'Update this library’s display title and outline. The slug (directory name) is immutable — delete + recreate to rename.',
    createHelp: 'Add a new library to the existing .SNL_Doc/. The title is written to libraries/<slug>/meta.json; the slug (directory name) is derived from the title.',
    slugReadonly: 'Slug (readonly)', slugImmutable: 'The library slug is immutable; delete + recreate the library to rename it',
    libraryTitle: 'Library title', titlePlaceholder: 'e.g. Real Analysis', updating: 'Updating…',
    creating: 'Creating…', updateTitle: 'Update Title',
    expandCounters: 'Expand counters', collapseCounters: 'Collapse counters', expand: 'Expand', collapse: 'Collapse',
    counters: 'Counters ({count})', addFirstCounter: '+ Add first counter', addRootCounter: '+ Add root counter',
    counterName: 'Counter name', counterNamePlaceholder: 'name', counterDsl: 'Counter numbering DSL',
    counterDslPlaceholder: 'numbering', duplicateCounterHelp: 'Another counter in this library shares this name; name-lookup picks the first depth-first match.',
    duplicateName: '(duplicate name)', created: '✅ Created library "{title}" (slug: {slug}).',
    updated: '✅ Updated library "{title}" (slug: {slug}).', invalid: '❌ Invalid: {message}', error: '❌ Error: {message}',
    outline: 'Outline', loadingOutline: 'Loading outline…', nodeCount: { arg: 'count', one: '{count} node', other: '{count} nodes' },
    branchCount: { arg: 'count', one: '{count} branch edge', other: '{count} branch edges' },
    noEntries: 'No entries yet — click "Add root entry" below.', addRootEntry: '+ Add root entry', untitled: '(untitled)',
    openEntry: 'Open Edit Entry: {id}\nkind: {kind}', pendingHelp: 'pending entry — "{id}" not in the pool yet (finish it in the Create Entry panel)',
    noEntryId: 'no entryId assigned (node {id})', pending: '⚠ pending', counterOverride: "Counter override for this entry (default = kind's default counter name)",
    defaultCounter: '<default>', entryId: 'Entry id',
    entryPlaceholder: 'Search existing entry, or type a new id and click Create', counter: 'Counter', reference: 'Reference', create: 'Create',
    referenceStatus: 'Reference: "{title}" — kind: {kind}', noMatchStatus: 'No entry with id "{id}" — Create will add a new one',
    emptyStatus: 'Empty — Create will open the Create Entry panel', cancel: 'Cancel',
    graphWarnings: { arg: 'count', one: '⚠️ {count} graph warning', other: '⚠️ {count} graph warnings' },
    moreWarnings: '… {count} more', counterUpdateFailed: 'Counter update failed: {message}'
  },
  {
    editLibrary: '编辑文库', createLibrary: '创建文库', dashboard: '仪表板', backDashboard: '返回仪表板',
    viewInfoview: '在信息视图中查看', openInfoview: '在信息视图阅读界面中打开文库“{slug}”',
    editHelp: '更新此文库的显示标题和大纲。标识（目录名）不可更改；如需重命名，请删除后重新创建。',
    createHelp: '向现有 .SNL_Doc/ 添加新文库。标题将写入 libraries/<slug>/meta.json；标识（目录名）根据标题生成。',
    slugReadonly: '标识（只读）', slugImmutable: '文库标识不可更改；如需重命名文库，请删除后重新创建',
    libraryTitle: '文库标题', titlePlaceholder: '例如：实分析', updating: '正在更新…', creating: '正在创建…', updateTitle: '更新标题',
    expandCounters: '展开计数器', collapseCounters: '折叠计数器', expand: '展开', collapse: '折叠',
    counters: '计数器（{count}）', addFirstCounter: '+ 添加第一个计数器', addRootCounter: '+ 添加根计数器',
    counterName: '计数器名称', counterNamePlaceholder: '名称', counterDsl: '计数器编号 DSL', counterDslPlaceholder: '编号规则',
    duplicateCounterHelp: '此文库中的另一个计数器使用了相同名称；按名称查找时会选择深度优先遍历中的第一个匹配项。', duplicateName: '（名称重复）',
    created: '✅ 已创建文库“{title}”（标识：{slug}）。', updated: '✅ 已更新文库“{title}”（标识：{slug}）。',
    invalid: '❌ 无效：{message}', error: '❌ 错误：{message}', outline: '大纲', loadingOutline: '正在加载大纲…',
    nodeCount: '{count} 个节点', branchCount: '{count} 条分支边', noEntries: '还没有条目 — 请点击下方的“添加根条目”。',
    addRootEntry: '+ 添加根条目', untitled: '（无标题）', openEntry: '打开“编辑条目”：{id}\n类型：{kind}',
    pendingHelp: '待创建条目 — “{id}”尚未加入条目池（请在“创建条目”面板中完成创建）', noEntryId: '未指定条目 ID（节点 {id}）',
    pending: '⚠ 待创建', counterOverride: '覆盖此条目的计数器（默认值为条目类型的默认计数器名称）', defaultCounter: '<默认>',
    entryId: '条目 ID',
    entryPlaceholder: '搜索现有条目，或输入新 ID 后点击“创建”',
    counter: '计数器', reference: '引用', create: '创建', referenceStatus: '引用：“{title}” — 类型：{kind}',
    noMatchStatus: '没有 ID 为“{id}”的条目 — “创建”将添加新条目', emptyStatus: '留空 — “创建”将打开“创建条目”面板', cancel: '取消',
    graphWarnings: '⚠️ {count} 条图警告', moreWarnings: '… 另有 {count} 条', counterUpdateFailed: '计数器更新失败：{message}'
  }
);

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
  title: Localized<string, string>;
  content?: { snl?: string };
}

interface KindItem {
  id: string;
  name: Localized<string, string>;
  description?: Localized<string, string>;
  defaultCounterName: string;
  coloring?: ThemedKindColoring;
}

interface GraphState {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  entries: EntryPoolItem[];
  kinds: KindItem[];
  metricMacroSources: SnlMacroSourceLookup;
  metricThresholds: EntryMetricThresholds;
  warnings: string[];
}

/**
 * A library-scoped counter tree node (mirrors `CounterNode` in src/snlDoc.ts).
 * `name` is what `EntryKind.defaultCounterName` matches on; name-lookup picks
 * the first depth-first match, so duplicate names are ambiguous — the UI warns
 * on collisions (case-insensitive).
 */
interface CounterNode {
  id: string;
  name: string;
  numbering: string;
  children: CounterNode[];
}

/** Depth-first flatten of a counter tree into a single ordered list. */
function flattenCounters(roots: CounterNode[]): CounterNode[] {
  const out: CounterNode[] = [];
  const walk = (nodes: CounterNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export function CreateLibraryApp(): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const [mode, setMode] = useState<Mode>('create');
  const [targetState, setTargetState] = useState<'found' | 'notFound'>('found');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [graph, setGraph] = useState<GraphState | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [counters, setCounters] = useState<CounterNode[]>([]);
  const [counterError, setCounterError] = useState<string | null>(null);
  const [contextReady, setContextReady] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const apiRef = useVsCodeApiRef();
  const titleDirtyRef = useRef(false);
  const libraryRevisionRef = useRef<string | undefined>(undefined);

  const draftKey = editorDraftKey('library', mode, mode === 'edit' ? slug : '');
  useEffect(() => {
    if (!contextReady) return;
    const restored = loadDraft<{ title: string; expectedRevision?: string }>(
      apiRef.current,
      draftKey
    );
    if (!restored) return;
    titleDirtyRef.current = true;
    setFormDirty(true);
    libraryRevisionRef.current = restored.expectedRevision;
    setTitle(restored.title);
  }, [contextReady, draftKey]);

  usePersistedDraft(
    apiRef.current,
    draftKey,
    {
      title,
      expectedRevision: mode === 'edit' ? libraryRevisionRef.current : undefined
    },
    contextReady && formDirty && status.kind !== 'created' && status.kind !== 'updated'
  );

  useEffect(() => {
    if (status.kind !== 'created' && status.kind !== 'updated') return;
    saveDraft(apiRef.current, draftKey, undefined);
  }, [draftKey, status.kind]);

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'context';
            mode: Mode;
            targetState?: 'found' | 'notFound';
            slug?: string;
            libraryRevision?: string;
            existing?: ExistingLibrary | null;
          }
        | { type: 'created'; slug: string; title: string }
        | { type: 'updated'; slug: string; title: string }
        | { type: 'duplicate'; slug: string; message: string }
        | { type: 'notFound' | 'conflict'; slug: string; message: string }
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
            metricMacroSources: SnlMacroSourceLookup;
            metricThresholds: EntryMetricThresholds;
            warnings: string[];
          }
        | { type: 'graphError'; message: string }
        | { type: 'countersLoaded'; counters: CounterNode[] }
        | { type: 'countersPushed'; counters: CounterNode[] }
        | { type: 'countersError'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setMode(msg.mode);
          setTargetState(msg.mode === 'edit' && msg.targetState === 'notFound' ? 'notFound' : 'found');
          setContextReady(true);
          if (msg.mode === 'edit') {
            setSlug(msg.slug ?? '');
            if (msg.existing && !titleDirtyRef.current) {
              libraryRevisionRef.current = msg.libraryRevision;
              setTitle(msg.existing.title);
            }
          }
          break;
        case 'created':
          titleDirtyRef.current = false;
          setFormDirty(false);
          saveDraft(apiRef.current, editorDraftKey('library', 'create', ''), undefined);
          saveDraft(apiRef.current, editorDraftKey('library', 'edit', msg.slug), undefined);
          setMode('edit');
          setSlug(msg.slug);
          setTargetState('found');
          setStatus({ kind: 'created', slug: msg.slug, title: msg.title });
          setTitle(msg.title);
          break;
        case 'updated':
          titleDirtyRef.current = false;
          setFormDirty(false);
          setStatus({ kind: 'updated', slug: msg.slug, title: msg.title });
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            slug: msg.slug,
            message: msg.message
          });
          break;
        case 'conflict':
          setStatus({ kind: 'error', message: msg.message });
          break;
        case 'notFound':
          setTargetState('notFound');
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
            metricMacroSources: msg.metricMacroSources ?? {},
            metricThresholds:
              msg.metricThresholds ?? DEFAULT_ENTRY_METRIC_THRESHOLDS,
            warnings: msg.warnings
          });
          setGraphError(null);
          break;
        case 'graphError':
          setGraphError(msg.message);
          break;
        case 'countersLoaded':
        case 'countersPushed':
          setCounters(Array.isArray(msg.counters) ? msg.counters : []);
          setCounterError(null);
          break;
        case 'countersError':
          setCounterError(msg.message);
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
  const canSubmit = targetState !== 'notFound' && trimmed.length > 0 && status.kind !== 'creating';

  // Ctrl/Cmd+S is the same action as the Create/Update button.
  useSaveShortcut(() => handleSubmit(), canSubmit);

  function handleSubmit(): void {
    if (!canSubmit) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      title: trimmed,
      expectedRevision: mode === 'edit' ? libraryRevisionRef.current : undefined
    });
  }

  const postGraphOp = (op: Record<string, unknown>): void => {
    apiRef.current?.postMessage({ type: 'graphOp', op });
  };

  const postCounterOp = (op: Record<string, unknown>): void => {
    apiRef.current?.postMessage({ type: 'counterOp', op });
  };

  if (mode === 'edit' && targetState === 'notFound') {
    return <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t('editLibrary')}
        back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }}
      />
      <MissingEditorTarget target="library" id={slug} />
    </main>;
  }

  return (
    <main style={PANEL_STYLE}>
      {/* cat 2026-07-09: top nav — back to Dashboard; in edit mode also
          jump to this library in the Infoview. */}
      <PanelHeader
        vsApi={apiRef.current}
        title={mode === 'edit' ? t('editLibrary') : t('createLibrary')}
        back={{
          label: t('dashboard'),
          title: t('backDashboard'),
          message: { type: 'nav.openDashboard' }
        }}
        viewInInfoview={
          mode === 'edit' && slug
            ? {
                label: t('viewInfoview'),
                title: t('openInfoview', { slug }),
                message: { type: 'nav.openInfoview', slug }
              }
            : undefined
        }
      />
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        {mode === 'edit'
          ? t('editHelp')
          : t('createHelp')}
      </p>

      {mode === 'edit' ? (
        // Edit mode: slug (readonly) + title on the same row so they read as
        // "directory / display name" instead of a stacked pair of near-duplicate
        // fields (per cat 2026-07-06).
        <div
          className="snl-responsive-row"
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
              {t('slugReadonly')}
            </label>
            <input
              id="snl-library-slug"
              type="text"
              value={slug}
              readOnly
              title={t('slugImmutable')}
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
              {t('libraryTitle')}
            </label>
            <input
              id="snl-library-title"
              type="text"
              value={title}
              placeholder={t('titlePlaceholder')}
              onChange={(e) => { titleDirtyRef.current = true; setFormDirty(true); setTitle(e.target.value); }}
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
            {t('libraryTitle')}
          </label>
          <input
            id="snl-library-title"
            type="text"
            value={title}
            placeholder={t('titlePlaceholder')}
            onChange={(e) => { titleDirtyRef.current = true; setFormDirty(true); setTitle(e.target.value); }}
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

      <Button
        variant="primary"
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        {status.kind === 'creating'
          ? mode === 'edit' ? t('updating') : t('creating')
          : mode === 'edit' ? t('updateTitle') : t('createLibrary')}
      </Button>

      <StatusLine status={status} />

      {mode === 'edit' ? (
        <CountersSection
          counters={counters}
          error={counterError}
          onCounterOp={postCounterOp}
        />
      ) : null}

      {mode === 'edit' ? (
        <OutlineEditor
          graph={graph}
          error={graphError}
          onGraphOp={postGraphOp}
          onOpenEntry={(entryId) =>
            apiRef.current?.postMessage({ type: 'openEditEntry', entryId })
          }
          onOpenCreateEntry={(entryId) =>
            apiRef.current?.postMessage({ type: 'openCreateEntry', entryId })
          }
          counters={counters}
        />
      ) : null}
    </main>
  );
}

// ===========================================================================
// Counters section (edit mode only) — library-scoped counter tree
// ===========================================================================

/** Total node count across the whole counter tree. */
function countCounterTree(nodes: CounterNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countCounterTree(node.children);
  return n;
}

/**
 * Collapsible "Counters (N)" section rendered between the meta header and the
 * Outline section. Uses the shared {@link TreeOutlineEditor} — the SAME tree
 * dashboard the entry outline uses — so counters get add-parent / add-child / add-sibling /
 * indent / outdent / move / delete for free. Row content is two inline inputs
 * (name + numbering) with a duplicate-name warning tag.
 */
function CountersSection({
  counters,
  error,
  onCounterOp
}: {
  counters: CounterNode[];
  error: string | null;
  onCounterOp: (op: Record<string, unknown>) => void;
}): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const [collapsed, setCollapsed] = useState(true);
  const total = useMemo(() => countCounterTree(counters), [counters]);

  // Parent lookup so "add sibling" can resolve the containing list, and the
  // case-insensitive duplicate-name set for the warning tag.
  const { parentOf, duplicateNames } = useMemo(() => {
    const parentOf = new Map<string, string | null>();
    const nameCounts = new Map<string, number>();
    const walk = (nodes: CounterNode[], parent: string | null): void => {
      for (const n of nodes) {
        parentOf.set(n.id, parent);
        const key = n.name.trim().toLowerCase();
        if (key) nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
        walk(n.children, n.id);
      }
    };
    walk(counters, null);
    const duplicateNames = new Set<string>();
    for (const [key, count] of nameCounts) {
      if (count > 1) duplicateNames.add(key);
    }
    return { parentOf, duplicateNames };
  }, [counters]);

  const DEFAULT_SEED = { name: 'counter', numbering: '1' };

  const handleTreeOp = (op: TreeOp): void => {
    switch (op.kind) {
      case 'addParent':
        onCounterOp({ op: 'wrapParent', id: op.id, seed: DEFAULT_SEED });
        break;
      case 'addChild':
        onCounterOp({
          op: 'addChild',
          parentId: op.id,
          insertAfter: null,
          seed: DEFAULT_SEED
        });
        break;
      case 'addSibling': {
        const parent = parentOf.get(op.id) ?? null;
        if (parent) {
          onCounterOp({
            op: 'addChild',
            parentId: parent,
            insertAfter: op.id,
            seed: DEFAULT_SEED
          });
        } else {
          onCounterOp({ op: 'addRoot', insertAfter: op.id, seed: DEFAULT_SEED });
        }
        break;
      }
      case 'move':
        onCounterOp({ op: 'move', id: op.id, direction: op.direction });
        break;
      case 'indent':
        onCounterOp({ op: 'indent', id: op.id });
        break;
      case 'outdent':
        onCounterOp({ op: 'outdent', id: op.id });
        break;
      case 'delete':
        onCounterOp({ op: 'delete', id: op.id });
        break;
      default:
        break;
    }
  };

  const renderRow = (node: CounterNode): React.ReactNode => (
    <CounterRowContent
      node={node}
      isDuplicate={duplicateNames.has(node.name.trim().toLowerCase())}
      onUpdateFields={(patch) =>
        onCounterOp({ op: 'updateFields', id: node.id, patch })
      }
    />
  );

  return (
    <section style={{ marginTop: '2rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.5rem'
        }}
      >
        <Button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? t('expandCounters') : t('collapseCounters')}
          title={collapsed ? t('expand') : t('collapse')}
          style={{
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
          }}
        >
          {collapsed ? '▶' : '▼'}
        </Button>
        <h2 style={{ ...SECTION_HEADING_STYLE, margin: 0 }}>
          {t('counters', { count: total })}
        </h2>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>
          {t('counterUpdateFailed', { message: error })}
        </p>
      ) : null}

      {collapsed ? null : (
        <>
          <TreeOutlineEditor<CounterNode>
            roots={counters}
            getId={(n) => n.id}
            getChildren={(n) => n.children}
            renderRow={renderRow}
            onOp={handleTreeOp}
            emptyState={
              <AddBar
                label={t('addFirstCounter')}
                onActivate={() =>
                  onCounterOp({
                    op: 'addRoot',
                    insertAfter: null,
                    seed: DEFAULT_SEED
                  })
                }
              />
            }
          />
          {counters.length > 0 ? (
            <Button
              type="button"
              onClick={() =>
                onCounterOp({
                  op: 'addRoot',
                  insertAfter: null,
                  seed: DEFAULT_SEED
                })
              }
              style={{ ...toolbarButtonStyle(false), marginTop: '0.75rem' }}
            >
              {t('addRootCounter')}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Non-toolbar row content for a counter: inline `name` + `numbering` inputs
 * (committed on blur / Enter) plus a duplicate-name warning tag. Rendered
 * between the disclosure toggle and the shared toolbar owned by
 * {@link TreeOutlineEditor}.
 */
function CounterRowContent({
  node,
  isDuplicate,
  onUpdateFields
}: {
  node: CounterNode;
  isDuplicate: boolean;
  onUpdateFields: (patch: { name?: string; numbering?: string }) => void;
}): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const [name, setName] = useState(node.name);
  const [numbering, setNumbering] = useState(node.numbering);

  // Re-sync local input state when the host pushes a fresh tree (e.g. after a
  // move/indent) so we don't show stale edits.
  useEffect(() => setName(node.name), [node.name]);
  useEffect(() => setNumbering(node.numbering), [node.numbering]);

  const commitName = (): void => {
    if (name !== node.name) onUpdateFields({ name });
  };
  const commitNumbering = (): void => {
    if (numbering !== node.numbering) onUpdateFields({ numbering });
  };

  const fieldStyle: React.CSSProperties = {
    boxSizing: 'border-box',
    padding: '0.2rem 0.4rem',
    color: 'var(--vscode-input-foreground, #ddd)',
    background: 'var(--vscode-input-background, #2a2a2a)',
    border:
      '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
    borderRadius: '2px',
    fontSize: '0.85rem'
  };

  return (
    <span
      style={{
        flex: '1 1 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '0.4rem',
        minWidth: 0
      }}
    >
      <input
        type="text"
        value={name}
        aria-label={t('counterName')}
        placeholder={t('counterNamePlaceholder')}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        style={{ ...fieldStyle, flex: '1 1 10rem', minWidth: '5rem' }}
      />
      <span style={{ opacity: 0.5 }}>—</span>
      <input
        type="text"
        value={numbering}
        aria-label={t('counterDsl')}
        placeholder={t('counterDslPlaceholder')}
        onChange={(e) => setNumbering(e.target.value)}
        onBlur={commitNumbering}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        style={{
          ...fieldStyle,
          flex: '0 1 8rem',
          minWidth: '4rem',
          fontFamily: 'var(--vscode-editor-font-family, monospace)'
        }}
      />
      {isDuplicate ? (
        <span
          title={t('duplicateCounterHelp')}
          style={{
            flexShrink: 0,
            fontSize: '0.72rem',
            padding: '0.1rem 0.4rem',
            borderRadius: '3px',
            border:
              '1px solid var(--vscode-inputValidation-warningBorder, #b89500)',
            color: 'var(--vscode-editorWarning-foreground, #cca700)',
            fontWeight: 600
          }}
        >
          {t('duplicateName')}
        </span>
      ) : null}
    </span>
  );
}

/** Shared dashed add action for empty counter/outline states. */
function AddBar({ label, onActivate }: { label: string; onActivate: () => void }): React.ReactElement {
  return <EmptyAction label={label} onClick={onActivate} />;
}

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  const t = useUiMessages(LIBRARY_MESSAGES);
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = t('created', { title: status.title, slug: status.slug });
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = t('updated', { title: status.title, slug: status.slug });
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
    text = t('invalid', { message: status.message });
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = t('error', { message: status.message });
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
  /**
   * Open the Create Entry panel. Used by the outline's Add form when
   * the user commits an empty or unresolved entry id — the row hasn't
   * been created yet, they can come back and paste the new entry's id.
   * Fixes a long-standing bug where `commitAdd` referenced an `apiRef`
   * that only exists in `CreateLibraryApp`'s scope, so the button
   * silently threw. Cat 2026-07-12.
   */
  onOpenCreateEntry: (entryId: string) => void;
  /** The library's counter tree — feeds the numbering engine (2026-07-16). */
  counters: CounterNode[];
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
  onOpenEntry,
  onOpenCreateEntry,
  counters
}: OutlineEditorProps): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  // Optional "adding" mode: which parent is currently being extended, and
  // just the entryId the user is typing (cat 2026-07-06: reference-only,
  // create-mode is routed to the CreateEntry panel instead).
  const [addingUnder, setAddingUnder] = useState<{
    parentId: string | null;
    insertAfter: string | null;
    wrapTargetId?: string;
    entryId: string;
    counterId?: string;
  } | null>(null);

  // Precompute indices for the current graph.
  const { childrenOf, roots, nodeById, entriesById, kindsById } = useMemo(() => {
    if (!graph) {
      return {
        childrenOf: new Map<string, string[]>(),
        roots: [] as string[],
        nodeById: new Map<string, GraphNode>(),
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
    const nodeById = new Map<string, GraphNode>();
    for (const n of graph.nodes) {
      nodeById.set(n.id, n);
      if (!hasParent.has(n.id)) roots.push(n.id);
    }
    const entriesById = new Map<string, EntryPoolItem>();
    for (const e of graph.entries) entriesById.set(e.id, e);
    const kindsById = new Map<string, KindItem>();
    for (const k of graph.kinds) kindsById.set(k.id, k);
    return { childrenOf, roots, nodeById, entriesById, kindsById };
  }, [graph]);

  // Recompute every distinct Entry referenced by this library once per fresh
  // graph payload (including the initial Edit Library open). Metrics are derived
  // in memory and never persisted into entries.json or graph.json.
  const entryMetricsById = useMemo(() => {
    if (!graph) return new Map<string, EntryMetricResult>();
    const libraryEntryIds = graph.nodes.flatMap((node) =>
      typeof node.props.entryId === 'string' ? [node.props.entryId] : []
    );
    return computeEntryMetricsForIds(
      graph.entries,
      libraryEntryIds,
      graph.metricMacroSources
    );
  }, [graph]);

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
          kindsById as unknown as Map<string, { defaultCounterName: string }>,
          counters
        )
      );
    }
    return out;
  }, [graph, entriesById, kindsById, counters]);

  const startAdd = (
    parentId: string | null,
    insertAfter: string | null,
    wrapTargetId?: string
  ): void => {
    setAddingUnder({ parentId, insertAfter, wrapTargetId, entryId: '', counterId: '' });
  };

  const cancelAdd = (): void => setAddingUnder(null);

  const commitAdd = (): void => {
    if (!addingUnder) return;
    const entryIdTrimmed = addingUnder.entryId.trim();
    // Three cases, distinguished by whether the typed id resolves in the pool:
    //   - empty            → open the Create Entry panel (no node inserted;
    //                        there's no id to stub yet).
    //   - typed-unresolved → dual action: insert a STUB node referencing the
    //                        typed id AND open the Create Entry panel seeded
    //                        with the same id. The stub resolves automatically
    //                        once the entry lands in the pool (the .SNL_Doc/**
    //                        watcher re-pushes the graph and the ⚠ tag clears).
    //                        Fulcrum 2026-07-16.
    //   - typed-resolved   → REFERENCE mode: insert a node pointing at the
    //                        existing pooled entry.
    const exists =
      entryIdTrimmed.length > 0 &&
      graph?.entries.some((e) => e.id === entryIdTrimmed);
    if (entryIdTrimmed.length === 0) {
      // No id to stub — keep the popover open so the user can paste the id
      // returned by the Create Entry panel when they come back.
      onOpenCreateEntry(entryIdTrimmed);
      return;
    }
    if (!exists) {
      // Insert the stub AND jump to Create Entry seeded with the same id. We
      // CAN close the popover now because the outline already carries the
      // stub node and the id is preserved as the Create Entry panel's seed.
      onGraphOp({
        op: addingUnder.wrapTargetId ? 'wrapNode' : 'addNode',
        wrapTargetId: addingUnder.wrapTargetId,
        parentId: addingUnder.parentId,
        insertAfter: addingUnder.insertAfter,
        entryId: entryIdTrimmed,
        counterId: addingUnder.counterId ?? '',
        isStub: true
      });
      onOpenCreateEntry(entryIdTrimmed);
      setAddingUnder(null);
      return;
    }
    onGraphOp({
      op: addingUnder.wrapTargetId ? 'wrapNode' : 'addNode',
      wrapTargetId: addingUnder.wrapTargetId,
      parentId: addingUnder.parentId,
      insertAfter: addingUnder.insertAfter,
      entryId: entryIdTrimmed,
      counterId: addingUnder.counterId ?? ''
    });
    setAddingUnder(null);
  };

  if (!graph) {
    return (
      <section style={{ marginTop: '2rem' }}>
        <h2 style={SECTION_HEADING_STYLE}>{t('outline')}</h2>
        <p style={{ opacity: 0.7 }}>{error ?? t('loadingOutline')}</p>
      </section>
    );
  }

  const rootNodes = roots
    .map((id) => nodeById.get(id))
    .filter((n): n is GraphNode => !!n);

  const getChildren = (n: GraphNode): GraphNode[] =>
    (childrenOf.get(n.id) ?? [])
      .map((id) => nodeById.get(id))
      .filter((c): c is GraphNode => !!c);

  // Map the generic TreeOutlineEditor toolbar ops onto the entry outline's
  // graphOp / add-form behavior. Parent insertion opens the same Entry picker
  // and commits one atomic wrapNode host mutation.
  const handleTreeOp = (op: TreeOp): void => {
    switch (op.kind) {
      case 'addParent':
        startAdd(null, null, op.id);
        break;
      case 'addChild':
        startAdd(op.id, null);
        break;
      case 'addSibling': {
        // Add a sibling after this node. If it has a parent, insert under the
        // parent right after this node; otherwise it's a root — add another
        // root at the tail (insertAfter isn't meaningful for roots yet).
        const parentRel = graph.relationships.find(
          (r) => r.label === 'branch' && r.to === op.id
        );
        if (parentRel) startAdd(parentRel.from, op.id);
        else startAdd(null, null);
        break;
      }
      case 'move':
        onGraphOp({
          op: 'moveSibling',
          nodeId: op.id,
          direction: op.direction,
          toEdge: op.toEdge === true
        });
        break;
      case 'indent':
        onGraphOp({ op: 'indent', nodeId: op.id });
        break;
      case 'outdent':
        onGraphOp({ op: 'outdent', nodeId: op.id });
        break;
      case 'delete':
        // Cat 2026-07-09: window.confirm() is blocked in VS Code webviews, so
        // we cannot gate here. The host-side deleteNode handler owns the modal
        // confirmation + the child-count guard; we just post the op.
        onGraphOp({ op: 'deleteNode', nodeId: op.id });
        break;
      default:
        break;
    }
  };

  const updateNodeCounter = (nodeId: string, counterId: string): void => {
    onGraphOp({ op: 'updateNodeProps', nodeId, counterId });
  };

  const renderMetric = (node: GraphNode): React.ReactNode => {
    const result = typeof node.props.entryId === 'string'
      ? entryMetricsById.get(node.props.entryId)
      : undefined;
    return result ? (
      <span className="snl-library-outline-metric">
        <EntryMetricValue
          result={result}
          metric="structuralIndex"
          thresholds={graph.metricThresholds}
          compact
        />
      </span>
    ) : null;
  };

  const renderRow = (node: GraphNode, depth: number): React.ReactNode => (
    <OutlineRowContent
      node={node}
      depth={depth}
      entriesById={entriesById}
      entryOptions={entryOptions}
      kindsById={kindsById}
      numbersById={numbersById}
      counters={counters}
      onOpenEntry={onOpenEntry}
      onUpdateNodeCounter={updateNodeCounter}
      onUpdateNodeEntry={(nodeId, expectedEntryId, entryId) =>
        onGraphOp({
          op: 'setNodeEntryId',
          nodeId,
          expectedEntryId,
          entryId
        })
      }
    />
  );

  const renderAfterRow = (node: GraphNode, depth: number): React.ReactNode => {
    // "add child" or "add sibling" popover attached below this row.
    //   + child   : parentId=here,  insertAfter=null   → attach under HERE
    //   + sibling : parentId=parent, insertAfter=here  → attach under HERE
    // so a child popover MUST also require insertAfter===null to avoid
    // poaching the parent row on a sibling insert (cat 2026-07-08 bug).
    // Root-sibling (both null) is handled by the top-level <AddNodeForm/>.
    const show =
      !!addingUnder &&
      (addingUnder.wrapTargetId === node.id ||
        (addingUnder.parentId === node.id && addingUnder.insertAfter === null) ||
        addingUnder.insertAfter === node.id);
    if (!show || !addingUnder) return null;
    return (
      <div style={{ paddingLeft: `${(depth + 1) * 1.5}rem` }}>
        <AddNodeForm
          kinds={graph.kinds}
          entriesById={entriesById}
          entryOptions={entryOptions}
          counters={counters}
          state={addingUnder}
          onCancel={cancelAdd}
          onCommit={commitAdd}
          onUpdate={setAddingUnder}
        />
      </div>
    );
  };

  return (
    <section style={{ marginTop: '2rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '0.5rem'
        }}
      >
        <h2 style={{ ...SECTION_HEADING_STYLE, margin: 0 }}>{t('outline')}</h2>
        <span style={{ opacity: 0.65, fontSize: '0.85rem' }}>
          {t('nodeCount', { count: graph.nodes.length })} ·{' '}
          {t('branchCount', { count: graph.relationships.filter((r) => r.label === 'branch').length })}
        </span>
      </div>

      {error ? <ErrorBanner message={error} /> : null}
      {graph.warnings.length > 0 ? <WarningBanner warnings={graph.warnings} /> : null}

      <TreeOutlineEditor<GraphNode>
        roots={rootNodes}
        moveToEdge
        rowClassName="snl-library-outline-row"
        rowStyle={{ alignItems: 'flex-start' }}
        getId={(n) => n.id}
        getChildren={getChildren}
        renderRow={renderRow}
        renderAfterRow={renderAfterRow}
        renderDashboardLeadingActions={renderMetric}
        onOp={handleTreeOp}
        emptyState={
          <div style={{ opacity: 0.75, fontStyle: 'italic', marginBottom: '0.75rem' }}>
            {t('noEntries')}
          </div>
        }
      />

      {/* Root-level add: no parent. */}
      {addingUnder && !addingUnder.wrapTargetId && addingUnder.parentId === null && addingUnder.insertAfter === null ? (
        <AddNodeForm
          kinds={graph.kinds}
          entriesById={entriesById}
          entryOptions={entryOptions}
          counters={counters}
          state={addingUnder}
          onCancel={cancelAdd}
          onCommit={commitAdd}
          onUpdate={setAddingUnder}
        />
      ) : (
        <Button
          type="button"
          onClick={() => startAdd(null, null)}
          style={{ ...toolbarButtonStyle(false), marginTop: '0.75rem', width: '100%', display: 'block', textAlign: 'left' }}
        >
          {t('addRootEntry')}
        </Button>
      )}
    </section>
  );
}

interface OutlineRowContentProps {
  node: GraphNode;
  depth: number;
  entriesById: Map<string, EntryPoolItem>;
  entryOptions: EntryOption[];
  kindsById: Map<string, KindItem>;
  numbersById: Map<string, string | null>;
  counters: CounterNode[];
  onOpenEntry: (entryId: string) => void;
  onUpdateNodeCounter: (nodeId: string, counterId: string) => void;
  onUpdateNodeEntry: (
    nodeId: string,
    expectedEntryId: string | null,
    entryId: string
  ) => void;
}

/**
 * Non-toolbar row content for a library entry outline row: computed number,
 * kind badge, clickable title, and the copy-id badge. Rendered between the
 * disclosure toggle and the shared toolbar owned by {@link TreeOutlineEditor}.
 */
function OutlineRowContent({
  node,
  depth,
  entriesById,
  entryOptions,
  kindsById,
  numbersById,
  counters,
  onOpenEntry,
  onUpdateNodeCounter,
  onUpdateNodeEntry
}: OutlineRowContentProps): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const contentLanguage = use_content_language();
  const entry = node.props.entryId
    ? entriesById.get(node.props.entryId)
    : undefined;
  // A stub is a node that references an entryId which isn't in the pool yet
  // (typically minted by the Add form's dual-action path — the entry is being
  // created in the Create Entry panel and will resolve on the next graph read).
  const isStub =
    typeof node.props.entryId === 'string' &&
    node.props.entryId.length > 0 &&
    !entry;
  const kind = entry?.kind ? kindsById.get(entry.kind) : undefined;
  const num = numbersById.get(node.id);
  const flatCounters = flattenCounters(counters);
  const currentCounterId =
    typeof node.props.counterId === 'string' ? node.props.counterId : '';

  const title = entry ? resolve_localized_string(entry.title, contentLanguage) : '';
  const displayTitle =
    title.trim().length > 0 ? title : <em style={{ opacity: 0.65 }}>{t('untitled')}</em>;

  return (
    <div
      className="snl-library-outline-row-main"
      data-snl-library-row-main
      style={{
        '--snl-library-outline-depth-offset': `${depth * 1.5}rem`
      } as React.CSSProperties}
    >
      <OutlineCounterControl
        number={num}
        currentCounterId={currentCounterId}
        counters={flatCounters}
        onChange={(counterId) => onUpdateNodeCounter(node.id, counterId)}
      />

      {kind ? <KindBadge kind={kind} /> : null}

      <div className="snl-library-outline-entry-id" data-testid="outline-entry-id-slot">
        <OutlineEntryTargetEditor
          nodeId={node.id}
          entryId={typeof node.props.entryId === 'string' ? node.props.entryId : ''}
          entries={entryOptions}
          onCommit={(entryId) => onUpdateNodeEntry(
            node.id,
            typeof node.props.entryId === 'string' ? node.props.entryId : null,
            entryId
          )}
        />
      </div>

      {/* Title = click target that opens Edit Entry for this row's entry.
          Cat 2026-07-12. Only clickable when the row resolves to an entry. */}
      {entry ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenEntry(entry.id);
          }}
          style={{
            minWidth: 0,
            width: '100%',
            padding: 0,
            border: 0,
            background: 'transparent',
            color: 'inherit',
            textAlign: 'left',
            fontFamily: 'inherit',
            flex: '1 1 auto',
            fontSize: '0.95rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            textDecoration: 'none'
          }}
          className="snl-outline-row-title"
          title={t('openEntry', { id: entry.id, kind: entry.kind })}
        >
          {displayTitle}
        </button>
      ) : (
        <span
          className="snl-outline-row-title"
          style={{
            flex: '1 1 auto',
            fontSize: '0.95rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.7,
            fontStyle: isStub ? 'italic' : 'normal'
          }}
          title={
            isStub
              ? t('pendingHelp', { id: node.props.entryId ?? '' })
              : t('noEntryId', { id: node.id })
          }
        >
          {isStub ? (
            <>
              <span
                style={{
                  marginRight: '0.4rem',
                  padding: '0.05rem 0.35rem',
                  borderRadius: '3px',
                  fontSize: '0.7rem',
                  fontStyle: 'normal',
                  color: 'var(--vscode-editorWarning-foreground, #cca700)',
                  border:
                    '1px solid var(--vscode-inputValidation-warningBorder, #b89500)'
                }}
              >
                {t('pending')}
              </span>
              <code style={{ fontSize: '0.8rem' }}>{node.props.entryId}</code>
            </>
          ) : (
            displayTitle
          )}
        </span>
      )}

    </div>
  );
}

function OutlineCounterControl({
  number,
  currentCounterId,
  counters,
  onChange
}: {
  number: string | null | undefined;
  currentCounterId: string;
  counters: CounterNode[];
  onChange: (counterId: string) => void;
}): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activated, setActivated] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const editing = hovered || focused || activated;
  useEffect(() => {
    if (editing && (activated || document.activeElement === wrapperRef.current)) {
      selectRef.current?.focus();
    }
  }, [activated, editing]);
  const activateEditor = (): void => {
    setActivated(true);
  };
  return (
    <div
      ref={wrapperRef}
      className="snl-library-outline-counter"
      data-testid="outline-counter-control"
      role={editing ? undefined : 'button'}
      aria-label={editing ? undefined : t('counterOverride')}
      tabIndex={editing ? -1 : 0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== 'mouse') {
          event.stopPropagation();
          activateEditor();
        }
      }}
      onClick={(event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget || event.target instanceof HTMLElement && event.target.tagName === 'SPAN') {
          event.stopPropagation();
          activateEditor();
        }
      }}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          event.stopPropagation();
          activateEditor();
        }
      }}
      onFocusCapture={(event: React.FocusEvent<HTMLDivElement>) => {
        setFocused(true);
        if (event.target === event.currentTarget) activateEditor();
      }}
      onBlurCapture={(event: React.FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
          setActivated(false);
        }
      }}
    >
      {editing ? (
        <select
          ref={selectRef}
          aria-label={t('counter')}
          value={currentCounterId}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            event.stopPropagation();
            onChange(event.target.value);
            event.currentTarget.blur();
            setFocused(false);
            setActivated(false);
            setHovered(false);
          }}
          title={t('counterOverride')}
        >
          <option value="">{t('defaultCounter')}</option>
          {counters.map((counter) => (
            <option key={counter.id} value={counter.id}>{counter.name}</option>
          ))}
        </select>
      ) : (
        <span>{`【${number ?? '—'}】`}</span>
      )}
    </div>
  );
}

function OutlineEntryTargetEditor({
  nodeId,
  entryId,
  entries,
  onCommit
}: {
  nodeId: string;
  entryId: string;
  entries: EntryOption[];
  onCommit: (entryId: string) => void;
}): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const [draft, setDraft] = useState(entryId);
  useEffect(() => {
    setDraft(entryId);
  }, [entryId]);
  return (
    <EntityIdSearchBox
      entries={entries}
      value={draft}
      onChange={setDraft}
      onCommit={(nextEntryId) => {
        if (nextEntryId !== entryId) onCommit(nextEntryId);
      }}
      onCancel={() => setDraft(entryId)}
      validate={ENTRY_VALIDATE_RULES.requireMatch}
      ariaLabel={t('entryId')}
      idPrefix={`snl-library-node-entry-${nodeId}`}
      hideResolvedChip
      hideValidationMessage
      style={{ width: '11rem', flex: '0 1 11rem', minWidth: '6rem' }}
      inputStyle={{
        padding: '0.1rem 0.3rem',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: '0.72rem'
      }}
    />
  );
}

function KindBadge({ kind }: { kind: KindItem }): React.ReactElement {
  const contentLanguage = use_content_language();
  const color = kind.coloring ? resolveWebviewKindColoring(kind.coloring) : null;
  const name = resolve_localized_string(kind.name, contentLanguage);
  const description = kind.description
    ? resolve_localized_string(kind.description, contentLanguage)
    : '';
  return (
    <span
      className="snl-library-outline-kind"
      title={description || name}
      style={{
        display: 'inline-block',
        padding: '0.1rem 0.45rem',
        fontSize: '0.75rem',
        borderRadius: '3px',
        border: color ? `1px solid ${color.stroke}` : '1px solid #666',
        background: color ? color.background : 'transparent',
        color: color ? color.stroke : 'inherit',
        fontWeight: 600,
        flexShrink: 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {name}
    </span>
  );
}

function AddNodeForm({
  entriesById,
  entryOptions,
  counters,
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
  counters: CounterNode[];
  state: {
    parentId: string | null;
    insertAfter: string | null;
    wrapTargetId?: string;
    entryId: string;
    counterId?: string;
  };
  onCancel: () => void;
  onCommit: () => void;
  onUpdate: (
    s: {
      parentId: string | null;
      insertAfter: string | null;
      wrapTargetId?: string;
      entryId: string;
      counterId?: string;
    } | null
  ) => void;
}): React.ReactElement {
  const t = useUiMessages(LIBRARY_MESSAGES);
  const contentLanguage = use_content_language();
  const entryIdTrimmed = state.entryId.trim();
  const isEmpty = entryIdTrimmed.length === 0;
  const referencedEntry = !isEmpty ? entriesById.get(entryIdTrimmed) : undefined;
  const flatCounters = flattenCounters(counters);

  // Three states drive the visual language (cat 2026-07-06):
  //   1. empty        → "Create" button opens the CreateEntry panel
  //   2. matched      → green border + ✓ badge + Reference button
  //   3. no-match     → yellow border + ⚠ badge + Create button (will
  //                     mint a fresh entry via CreateEntry panel too;
  //                     what the user typed becomes irrelevant because
  //                     they haven't paste-copied an existing id yet)
  type Mode = 'empty' | 'matched' | 'nomatch';
  const mode: Mode = isEmpty ? 'empty' : referencedEntry ? 'matched' : 'nomatch';

  const buttonLabel = mode === 'matched' ? t('reference') : t('create');

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
          {t('entryId')}
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
            suggestionsInFlow
            idPrefix="snl-outline-entryid"
            placeholder={t('entryPlaceholder')}
            onChange={(next) =>
              onUpdate({
                parentId: state.parentId,
                insertAfter: state.insertAfter,
                entryId: next,
                counterId: state.counterId
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

      {/* Optional counter override — only offered once the id resolves to a
          real entry (a stub/create path has no counter to pin yet). */}
      {mode === 'matched' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label
            htmlFor="snl-outline-counter"
            style={{ fontSize: '0.8rem', opacity: 0.75 }}
          >
            {t('counter')}
          </label>
          <select
            id="snl-outline-counter"
            value={state.counterId ?? ''}
            onChange={(e) =>
              onUpdate({
                parentId: state.parentId,
                insertAfter: state.insertAfter,
                entryId: state.entryId,
                counterId: e.target.value
              })
            }
            style={{
              fontSize: '0.8rem',
              background: 'var(--vscode-input-background, transparent)',
              color: 'var(--vscode-input-foreground, inherit)',
              border:
                '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
              borderRadius: '2px'
            }}
          >
            <option value="">{t('defaultCounter')}</option>
            {flatCounters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

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
            ? t('referenceStatus', {
                title: referencedEntry
                  ? resolve_localized_string(referencedEntry.title, contentLanguage) || t('untitled')
                  : t('untitled'),
                kind: referencedEntry?.kind ?? ''
              })
            : mode === 'nomatch'
              ? t('noMatchStatus', { id: entryIdTrimmed })
              : t('emptyStatus')}
        </span>
        <Button onClick={onCommit} style={toolbarButtonStyle(true)}>
          {buttonLabel}
        </Button>
        <Button onClick={onCancel} style={toolbarButtonStyle(false)}>
          {t('cancel')}
        </Button>
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
  const t = useUiMessages(LIBRARY_MESSAGES);
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
        {t('graphWarnings', { count: warnings.length })}
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {warnings.slice(0, 5).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        {warnings.length > 5 ? (
          <li style={{ opacity: 0.7 }}>{t('moreWarnings', { count: warnings.length - 5 })}</li>
        ) : null}
      </ul>
    </div>
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

const SECTION_HEADING_STYLE: React.CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 600,
  marginTop: 0,
  marginBottom: '0.5rem'
};
