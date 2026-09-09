import { describe, expect, it, vi } from 'vitest';
const posted: any[] = [];
const entries = vi.hoisted(() => [
  { id: 'a', package: 'logic', title: 'A', kind: 'theorem', tags: ['中文', '__proto__', '', 'a,b', '中文'] },
  { id: 'b', package: 'logic', title: 'B', kind: 'theorem' },
  { id: 'outside', package: 'other', title: 'Outside', kind: 'theorem', tags: ['outside'] }
]);
vi.mock('vscode', () => ({ window: { showErrorMessage: vi.fn() }, commands: { executeCommand: vi.fn() } }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
vi.mock('./snlDoc', () => ({
  readEntries: async () => entries,
  readEntryKinds: async () => [],
  readRelationships: async () => [{ id: 'ab', from: 'a', to: 'b', label: 'uses' }, { id: 'out', from: 'b', to: 'outside', label: 'uses' }],
  listLibraries: async () => [{ slug: 'lib', title: 'Library' }],
  readLibraryGraph: async () => ({ status: 'ok', result: { graph: { nodes: ['a', 'b'].map(entryId => ({ label: 'Entry', props: { entryId } })) } } }),
  readAllMacros: async () => ({ macro: { tags: ['macro-only'] } }), readMacroKinds: async () => []
}));
vi.mock('./panelUtil', () => ({ buildPanelHtml: () => '', firstWorkspaceFolder: () => ({ path: '/workspace' }), handlePanelNavMessage: async () => false }));
describe('GraphPanel canonical Entry tags projection', () => {
  it.each([{ mode: 'pool' }, { mode: 'library', slug: 'lib' }])('copies actual Entry tags, never Macro tags, within %j', async scope => {
    const { GraphPanel } = await import('./graphPanel');
    const before = JSON.stringify(entries);
    const panel = Object.assign(Object.create(GraphPanel.prototype), { scope, graphGeneration: 0,
      panel: { webview: { postMessage: async (message: unknown) => { posted.push(message); return true; } } } });
    await panel.pushGraph();
    const message = posted.at(-1);
    expect(message.type).toBe('graph');
    expect(message.nodes.find((n: any) => n.id === 'a').tags).toEqual(entries[0].tags);
    expect(message.nodes.find((n: any) => n.id === 'b').tags ?? []).toEqual([]);
    expect(message.nodes.some((n: any) => n.tags?.includes('macro-only'))).toBe(false);
    expect(message.nodes.some((n: any) => n.id === 'outside')).toBe(scope.mode === 'pool');
    expect(JSON.stringify(entries)).toBe(before);
  });
});
