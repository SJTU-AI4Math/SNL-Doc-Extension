import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  FileType: { Directory: 2 },
  Uri: { joinPath: (...parts: any[]) => parts.join('/') },
  workspace: {
    fs: { stat: vi.fn(async () => ({ type: 2 })) },
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => undefined }))
  },
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn() }
}));

const graphReads: Array<{ resolve: (value: any) => void; promise: Promise<any> }> = [];
const counterReads: Array<{ resolve: (value: any) => void; promise: Promise<any> }> = [];
let operationMode = false;
let graphWriteFailure: string | null = null;
let operationGraph: { nodes: any[]; relationships: any[] } = { nodes: [], relationships: [] };
let operationCounterMode = false;
let operationCounters: any[] = [];
let operationEntries: any[] = [];
let createResult: any = { status: 'created', slug: 'new-library', title: 'New Library' };
let workspaceRefresh: ((uris?: readonly { path: string }[]) => void | Promise<void>) | undefined;
function deferred(queue: Array<{ resolve: (value: any) => void; promise: Promise<any> }>): Promise<any> {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  queue.push({ resolve, promise });
  return promise;
}

vi.mock('./snlDoc', () => ({
  addEntry: vi.fn(async (_root: unknown, entry: any) => {
    operationEntries.push(structuredClone(entry));
    return { status: 'ok', id: entry.id, revision: 'revision' };
  }),
  rollbackCreatedEntry: vi.fn(async (_root: unknown, id: string, revision: string) => {
    if (revision !== 'revision') return { status: 'conflict', id, message: 'changed' };
    operationEntries = operationEntries.filter((entry) => entry.id !== id);
    return { status: 'ok', id };
  }),
  createLibrary: vi.fn(async () => createResult), entityRevision: vi.fn(() => 'revision'), updateLibrary: vi.fn(),
  writeLibraryCounters: vi.fn(async (_root: unknown, _slug: string, counters: any[]) => {
    operationCounters = structuredClone(counters);
  }),
  mutateLibraryGraph: vi.fn(async (_root: unknown, _slug: string, mutate: (graph: any, transaction: any) => any) => {
    const graph = structuredClone(operationGraph);
    const rollbacks: Array<() => unknown> = [];
    const decision = await mutate(graph, { onRollback: (action: () => unknown) => rollbacks.push(action) });
    if (graphWriteFailure) {
      for (const rollback of [...rollbacks].reverse()) await rollback();
      return { status: 'error', message: graphWriteFailure };
    }
    if (decision) operationGraph = typeof decision === 'object' ? decision : graph;
    return { status: 'ok', changed: Boolean(decision) };
  }),
  updateLibraryGraphNodeEntryId: vi.fn(async (_root: unknown, _slug: string, nodeId: string, expectedEntryId: string | null, entryId: string) => {
    const target = operationGraph.nodes.find((node) => node.id === nodeId);
    if (!target) return { status: 'notFound' };
    if ((target.props?.entryId ?? null) !== expectedEntryId) return { status: 'conflict' };
    operationGraph = {
      nodes: operationGraph.nodes.map((node) => node.id === nodeId
        ? { ...node, props: { ...node.props, entryId } }
        : node),
      relationships: operationGraph.relationships
    };
    return { status: 'ok' };
  }),
  wrapLibraryGraphNodeWithParent: vi.fn(async (
    _root: unknown,
    _slug: string,
    targetId: string,
    parent: any
  ) => {
    const targetIndex = operationGraph.nodes.findIndex((node) => node.id === targetId);
    if (targetIndex < 0) return { status: 'notFound' };
    const incoming = operationGraph.relationships
      .map((relationship, index) => ({ relationship, index }))
      .filter(({ relationship }) => relationship.label === 'branch' && relationship.to === targetId);
    if (incoming.length > 1) return { status: 'malformed' };
    operationGraph.nodes.splice(targetIndex, 0, structuredClone(parent));
    if (incoming.length === 0) {
      operationGraph.relationships.push({ from: parent.id, to: targetId, label: 'branch' });
    } else {
      const index = incoming[0].index;
      operationGraph.relationships.splice(
        index,
        1,
        { ...operationGraph.relationships[index], to: parent.id },
        { from: parent.id, to: targetId, label: 'branch' }
      );
    }
    return { status: 'ok' };
  }),
  readLibraryMeta: vi.fn(async () => ({ status: 'ok', meta: { title: createResult.title } })),
  readLibraryGraph: vi.fn(() => operationMode
    ? Promise.resolve({ status: 'ok', result: { graph: structuredClone(operationGraph), warnings: [] } })
    : deferred(graphReads)),
  readLibraryCounters: vi.fn(() => operationCounterMode
    ? Promise.resolve(structuredClone(operationCounters))
    : deferred(counterReads)),
  mutateLibraryCounters: vi.fn(async (
    _root: unknown,
    _slug: string,
    mutate: (roots: any[]) => boolean
  ) => {
    const roots = structuredClone(operationCounters);
    const changed = mutate(roots);
    if (changed) operationCounters = roots;
    return { status: 'ok', changed };
  }),
  listLibraries: async () => [],
  readEntries: async () => structuredClone(operationEntries),
  readEntryKinds: async () => [], readAllMacros: async () => ({})
}));
vi.mock('./panelUtil', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./panelUtil')>();
  return {
    ...actual,
    buildPanelHtml: () => '', firstWorkspaceFolder: () => ({ path: '/workspace' }),
    handlePanelNavMessage: async () => false,
    installSnlDocWatcher: (
      _disposables: unknown[],
      refresh: (uris?: readonly { path: string }[]) => void | Promise<void>
    ) => { workspaceRefresh = refresh; }
  };
});
vi.mock('./preferencesHost', () => ({ bind_preferences_panel_title: () => undefined }));
vi.mock('./entryMetricSettings', () => ({ readEntryMetricThresholds: () => ({}) }));
vi.mock('./preferences', () => ({
  extension_preferences_runtime: { query_environment: () => ({ language: 'en' }) }
}));

function panelHarness(prototype: object, posted: any[]): any {
  return Object.assign(Object.create(prototype), {
    mode: 'edit', slug: 'lib', contextGeneration: 0, graphGeneration: 0, counterGeneration: 0,
    mutationTail: Promise.resolve(),
    panel: { webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } }
  });
}

describe('CreateLibraryPanel refresh ordering', () => {
  beforeEach(() => {
    graphReads.length = 0;
    counterReads.length = 0;
    operationMode = false;
    graphWriteFailure = null;
    operationGraph = { nodes: [], relationships: [] };
    operationCounterMode = false;
    operationCounters = [];
    operationEntries = [];
    createResult = { status: 'created', slug: 'new-library', title: 'New Library' };
    workspaceRefresh = undefined;
  });

  it('targets own Counter watcher events without reloading the full Library context', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    const panel = {
      title: '', active: true,
      webview: {
        html: '',
        postMessage: vi.fn(async () => true),
        onDidReceiveMessage: vi.fn(() => ({ dispose: () => undefined }))
      },
      onDidChangeViewState: vi.fn(() => ({ dispose: () => undefined })),
      onDidDispose: vi.fn(() => ({ dispose: () => undefined })),
      dispose: vi.fn()
    };
    const instance = new (CreateLibraryPanel as any)(panel, { path: '/extension' }, 'edit', 'lib');
    instance.pushContext = vi.fn(async () => undefined);
    instance.pushCounters = vi.fn(async () => undefined);

    await workspaceRefresh!([{ path: '/workspace/.SNL_Doc/libraries/lib/counters.json' }]);
    expect(instance.pushCounters).toHaveBeenCalledWith('countersPushed');
    expect(instance.pushContext).not.toHaveBeenCalled();

    await workspaceRefresh!([{ path: '/workspace/.SNL_Doc/libraries/other/counters.json' }]);
    expect(instance.pushCounters).toHaveBeenCalledTimes(1);
    expect(instance.pushContext).not.toHaveBeenCalled();

    await workspaceRefresh!([{ path: '/workspace/.SNL_Doc/libraries/lib/graph.json' }]);
    expect(instance.pushContext).toHaveBeenCalledTimes(1);

    await workspaceRefresh!([
      { path: '/workspace/.SNL_Doc/config.json' },
      { path: '/workspace/.SNL_Doc/libraries/lib/counters.json' }
    ]);
    expect(instance.pushContext).toHaveBeenCalledTimes(2);
    expect(instance.pushCounters).toHaveBeenCalledTimes(1);
  });

  it('lets only the latest graph refresh publish', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    const older = panel.pushGraph();
    const newer = panel.pushGraph();
    await vi.waitFor(() => expect(graphReads).toHaveLength(2));
    graphReads[1].resolve({ status: 'ok', result: { graph: { nodes: [], relationships: [] }, warnings: [] } });
    await newer;
    graphReads[0].resolve({ status: 'error', message: 'stale error' });
    await older;
    expect(posted.map((message) => message.type)).toEqual(['graph']);
  });

  it('lets only the latest counter refresh publish', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    const older = panel.pushCounters('countersLoaded');
    const newer = panel.pushCounters('countersPushed');
    await vi.waitFor(() => expect(counterReads).toHaveLength(2));
    counterReads[1].resolve([{ id: 'new' }]);
    await newer;
    counterReads[0].resolve([{ id: 'old' }]);
    await older;
    expect(posted).toEqual([{ type: 'countersPushed', counters: [{ id: 'new' }] }]);
  });

  it('does not let a stale context cancel an independent counter refresh', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    const independent = panel.pushCounters('countersPushed');
    await vi.waitFor(() => expect(counterReads).toHaveLength(1));

    panel.contextGeneration = 2;
    await panel.pushCounters('countersLoaded', 1);
    expect(counterReads).toHaveLength(1);

    counterReads[0].resolve([{ id: 'independent' }]);
    await independent;
    expect(posted).toEqual([{ type: 'countersPushed', counters: [{ id: 'independent' }] }]);
  });

  it('serializes rapid graph operations so both mutations survive', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    await Promise.all([
      panel.handleMessage({ type: 'graphOp', op: { op: 'addNode', parentId: null, entryId: 'entry-a', isStub: true } }),
      panel.handleMessage({ type: 'graphOp', op: { op: 'addNode', parentId: null, entryId: 'entry-b', isStub: true } })
    ]);
    expect(operationGraph.nodes.map((node) => node.props.entryId).sort()).toEqual(['entry-a', 'entry-b']);
  });

  it('commits replacement arrays from delete and sibling-move operations', async () => {
    const vscode = await import('vscode');
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Remove' as never);
    operationMode = true;
    operationGraph = {
      nodes: ['a', 'b', 'c'].map((id) => ({ id, label: 'Entry', props: { entryId: id } })),
      relationships: []
    };
    const panel = panelHarness(CreateLibraryPanel.prototype, []);

    await panel.handleMessage({ type: 'graphOp', op: { op: 'deleteNode', nodeId: 'b' } });
    await panel.handleMessage({
      type: 'graphOp',
      op: { op: 'moveSibling', nodeId: 'c', direction: 'up', toEdge: false }
    });

    expect(operationGraph.nodes.map((node) => node.id)).toEqual(['c', 'a']);
  });

  it('wraps an outline node with one atomic graph operation without reordering roots', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationGraph = {
      nodes: [
        { id: 'before', label: 'Entry', props: { entryId: 'entry-before' } },
        { id: 'target', label: 'Entry', props: { entryId: 'entry-target' } },
        { id: 'after', label: 'Entry', props: { entryId: 'entry-after' } }
      ],
      relationships: []
    };
    const panel = panelHarness(CreateLibraryPanel.prototype, []);

    await panel.handleMessage({
      type: 'graphOp',
      op: {
        op: 'wrapNode',
        wrapTargetId: 'target',
        parentId: null,
        entryId: 'entry-parent',
        isStub: true
      }
    });

    const parent = operationGraph.nodes.find(
      (node) => node.props.entryId === 'entry-parent'
    );
    expect(parent).toBeTruthy();
    expect(operationGraph.nodes.map((node) => node.id)).toEqual([
      'before', parent.id, 'target', 'after'
    ]);
    expect(operationGraph.relationships).toEqual([
      { from: parent.id, to: 'target', label: 'branch' }
    ]);
  });

  it('fails closed when wrapNode omits its target', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationGraph = {
      nodes: [{ id: 'target', label: 'Entry', props: { entryId: 'entry-target' } }],
      relationships: []
    };
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);

    await panel.handleMessage({
      type: 'graphOp',
      op: { op: 'wrapNode', entryId: 'entry-parent', isStub: true }
    });

    expect(operationGraph.nodes).toHaveLength(1);
    expect(posted).toContainEqual({
      type: 'graphError',
      message: 'wrapNode: wrapTargetId is required'
    });
  });

  it('does not create an orphan Entry when wrapNode lacks a pre-created reference', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationGraph = {
      nodes: [{ id: 'target', label: 'Entry', props: { entryId: 'entry-target' } }],
      relationships: []
    };
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    vi.mocked(snlDoc.addEntry).mockClear();

    await panel.handleMessage({
      type: 'graphOp',
      op: { op: 'wrapNode', wrapTargetId: 'target', kind: 'theorem' }
    });

    expect(snlDoc.addEntry).not.toHaveBeenCalled();
    expect(operationGraph.nodes).toHaveLength(1);
    expect(posted).toContainEqual({
      type: 'graphError',
      message: 'wrapNode: create the Entry stub before wrapping the target'
    });
  });

  it('rolls back a newly created Entry when the graph commit fails', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    graphWriteFailure = 'injected graph CAS failure';
    vi.mocked(snlDoc.addEntry).mockClear();
    vi.mocked(snlDoc.rollbackCreatedEntry).mockClear();
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);

    await panel.handleMessage({
      type: 'graphOp',
      op: { op: 'addNode', parentId: null, isStub: false, kind: 'theorem', title: 'Created' }
    });

    expect(snlDoc.addEntry).toHaveBeenCalledOnce();
    const createdId = vi.mocked(snlDoc.addEntry).mock.calls[0][1].id;
    expect(snlDoc.rollbackCreatedEntry).toHaveBeenCalledWith(
      expect.anything(), createdId, 'revision'
    );
    expect(operationGraph.nodes).toEqual([]);
    expect(operationEntries).toEqual([]);
    expect(posted).toContainEqual({ type: 'graphError', message: 'injected graph CAS failure' });
  });

  it('updates only the Entry indexed by a stable graph node', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationGraph = {
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-a' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-b' } }
      ],
      relationships: [
        { from: 'root', to: 'child', label: 'branch' },
        { from: 'child', to: 'root', label: 'reference' }
      ]
    };
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    vi.mocked(snlDoc.updateLibraryGraphNodeEntryId).mockClear();
    vi.mocked(snlDoc.mutateLibraryGraph).mockClear();

    await panel.handleMessage({
      type: 'graphOp',
      op: {
        op: 'setNodeEntryId',
        nodeId: 'root',
        expectedEntryId: 'entry-a',
        entryId: 'entry-c'
      }
    });

    expect(operationGraph.nodes.map((node) => node.id)).toEqual(['root', 'child']);
    expect(operationGraph.nodes[0].props.entryId).toBe('entry-c');
    expect(operationGraph.relationships).toEqual([
      { from: 'root', to: 'child', label: 'branch' },
      { from: 'child', to: 'root', label: 'reference' }
    ]);
    expect(snlDoc.updateLibraryGraphNodeEntryId).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace' }),
      'lib',
      'root',
      'entry-a',
      'entry-c'
    );
    expect(snlDoc.mutateLibraryGraph).not.toHaveBeenCalled();
  });

  it('rejects an empty indexed Entry id without writing the graph', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationGraph = {
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-a' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-b' } }
      ],
      relationships: [{ from: 'root', to: 'child', label: 'branch' }]
    };
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    vi.mocked(snlDoc.updateLibraryGraphNodeEntryId).mockClear();

    await panel.handleMessage({
      type: 'graphOp',
      op: { op: 'setNodeEntryId', nodeId: 'root', expectedEntryId: 'entry-a', entryId: '' }
    });

    expect(snlDoc.updateLibraryGraphNodeEntryId).not.toHaveBeenCalled();
    expect(posted).toContainEqual({
      type: 'graphError',
      message: 'setNodeEntryId: nodeId, expectedEntryId, and entryId are required'
    });
  });

  it('rejects a stale indexed Entry expectation instead of overwriting another panel', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationGraph = {
      nodes: [{ id: 'root', label: 'Entry', props: { entryId: 'entry-current' } }],
      relationships: []
    };
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);

    await panel.handleMessage({
      type: 'graphOp',
      op: {
        op: 'setNodeEntryId',
        nodeId: 'root',
        expectedEntryId: 'entry-stale',
        entryId: 'entry-new'
      }
    });

    expect(operationGraph.nodes[0].props.entryId).toBe('entry-current');
    expect(posted).toContainEqual({
      type: 'graphError',
      message: 'Outline node "root" changed on disk. Refresh and retry.'
    });
  });

  it('serializes rapid counter operations so both mutations survive', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationCounterMode = true;
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    await Promise.all([
      panel.handleMessage({ type: 'counterOp', op: { op: 'addRoot', insertAfter: null, seed: { name: 'A', numbering: '' } } }),
      panel.handleMessage({ type: 'counterOp', op: { op: 'addRoot', insertAfter: null, seed: { name: 'B', numbering: '' } } })
    ]);
    expect(operationCounters.map((node) => node.name).sort()).toEqual(['A', 'B']);
  });

  it('wraps a counter node while preserving its subtree and sibling position', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationCounterMode = true;
    operationCounters = [
      { id: 'before', name: 'before', numbering: '1', children: [] },
      {
        id: 'target', name: 'target', numbering: '2',
        children: [{ id: 'child', name: 'child', numbering: '2.1', children: [] }]
      },
      { id: 'after', name: 'after', numbering: '3', children: [] }
    ];
    const panel = panelHarness(CreateLibraryPanel.prototype, []);

    await panel.handleMessage({
      type: 'counterOp',
      op: { op: 'wrapParent', id: 'target', seed: { name: 'parent', numbering: '2' } }
    });

    expect(operationCounters.map((node) => node.name)).toEqual(['before', 'parent', 'after']);
    expect(operationCounters[1].children[0].name).toBe('target');
    expect(operationCounters[1].children[0].children[0].name).toBe('child');
  });

  it('rekeys the create singleton and turns the same host panel into the created library editor', async () => {
    const { CreateLibraryPanel } = await import('./createLibraryPanel');
    operationMode = true;
    operationCounterMode = true;
    const posted: any[] = [];
    const panel = panelHarness(CreateLibraryPanel.prototype, posted);
    panel.mode = 'create';
    panel.slug = '';
    panel.panel.title = 'SNL Create Library';
    const instances = (CreateLibraryPanel as any).instances as Map<string, any>;
    instances.clear();
    instances.set('create:', panel);

    await panel.handleMessage({ type: 'create', title: 'New Library' });

    expect(panel.mode).toBe('edit');
    expect(panel.slug).toBe('new-library');
    expect(panel.panel.title).toBe('SNL Edit Library — new-library');
    expect(instances.get('edit:new-library')).toBe(panel);
    expect(instances.has('create:')).toBe(false);
    expect(posted.some((message) => message.type === 'context' && message.mode === 'edit')).toBe(true);
  });
});
