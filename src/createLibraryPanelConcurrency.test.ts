import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

const graphReads: Array<{ resolve: (value: any) => void; promise: Promise<any> }> = [];
const counterReads: Array<{ resolve: (value: any) => void; promise: Promise<any> }> = [];
let operationMode = false;
let operationGraph: { nodes: any[]; relationships: any[] } = { nodes: [], relationships: [] };
let operationCounterMode = false;
let operationCounters: any[] = [];
function deferred(queue: Array<{ resolve: (value: any) => void; promise: Promise<any> }>): Promise<any> {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  queue.push({ resolve, promise });
  return promise;
}

vi.mock('./snlDoc', () => ({
  addEntry: vi.fn(), createLibrary: vi.fn(), entityRevision: vi.fn(), updateLibrary: vi.fn(),
  writeLibraryCounters: vi.fn(async (_root: unknown, _slug: string, counters: any[]) => {
    operationCounters = structuredClone(counters);
  }),
  writeLibraryGraph: vi.fn(async (_root: unknown, _slug: string, graph: any) => {
    operationGraph = structuredClone(graph);
    return { status: 'ok' };
  }),
  readLibraryMeta: vi.fn(),
  readLibraryGraph: vi.fn(() => operationMode
    ? Promise.resolve({ status: 'ok', result: { graph: structuredClone(operationGraph), warnings: [] } })
    : deferred(graphReads)),
  readLibraryCounters: vi.fn(() => operationCounterMode
    ? Promise.resolve(structuredClone(operationCounters))
    : deferred(counterReads)),
  readEntries: async () => [], readEntryKinds: async () => [], readAllMacros: async () => ({})
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '', firstWorkspaceFolder: () => ({ path: '/workspace' }),
  handlePanelNavMessage: async () => false, installSnlDocWatcher: () => undefined
}));
vi.mock('./entryMetricSettings', () => ({ readEntryMetricThresholds: () => ({}) }));
vi.mock('./graphSiblingOrder', () => ({ moveGraphSibling: vi.fn() }));

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
    operationGraph = { nodes: [], relationships: [] };
    operationCounterMode = false;
    operationCounters = [];
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
});
