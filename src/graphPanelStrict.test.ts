import { beforeEach, describe, expect, it, vi } from 'vitest';

const posted: any[] = [];
const reads = vi.hoisted(() => ({
  entryError: null as Error | null,
  relationshipError: null as Error | null,
  libraryResult: { status: 'error', message: 'malformed graph.json' } as any
}));

vi.mock('vscode', () => ({
  window: { showErrorMessage: vi.fn() },
  commands: { executeCommand: vi.fn() }
}));
vi.mock('./snlDoc', () => ({
  readEntries: vi.fn(async () => { if (reads.entryError) throw reads.entryError; return []; }),
  readEntryKinds: async () => [],
  readRelationships: async () => { if (reads.relationshipError) throw reads.relationshipError; return []; },
  listLibraries: async () => [{ slug: 'lib', title: 'Library' }],
  readLibraryGraph: async () => reads.libraryResult,
  readAllMacros: async () => ({}), readMacroKinds: async () => []
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '', firstWorkspaceFolder: () => ({ path: '/workspace' }),
  handlePanelNavMessage: async () => false
}));

async function harness(scope: any): Promise<any> {
  const { GraphPanel } = await import('./graphPanel');
  return Object.assign(Object.create(GraphPanel.prototype), {
    scope, graphGeneration: 0,
    panel: { webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } }
  });
}

describe('GraphPanel strict error publication', () => {
  beforeEach(() => {
    posted.length = 0;
    reads.entryError = null;
    reads.relationshipError = null;
    reads.libraryResult = { status: 'error', message: 'malformed graph.json' };
  });

  it('publishes graphError when core entity storage cannot be read', async () => {
    reads.entryError = new Error('malformed Entry envelope');
    const panel = await harness({ mode: 'pool' });
    await panel.pushGraph();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'graphError', message: expect.stringContaining('malformed Entry envelope') });
  });

  it('publishes graphError when relationships.json is malformed', async () => {
    reads.relationshipError = new Error('relationships.json must be an object wrapper');
    const panel = await harness({ mode: 'pool' });
    await panel.pushGraph();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'graphError', message: expect.stringContaining('relationships.json') });
  });

  it('does not turn malformed library graph.json into an empty graph', async () => {
    const panel = await harness({ mode: 'library', slug: 'lib' });
    await panel.pushGraph();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'graphError', message: expect.stringContaining('malformed graph.json') });
    expect(posted.some((message) => message.type === 'graph')).toBe(false);
  });
});
