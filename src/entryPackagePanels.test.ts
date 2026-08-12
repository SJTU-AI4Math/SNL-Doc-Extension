import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  receivers: [] as Array<(message: unknown) => Promise<void>>,
  posts: [] as unknown[],
  commands: [] as unknown[][],
  panels: [] as Array<{ reveal: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  belongs: vi.fn(async () => true),
  snapshot: vi.fn(async () => ({
    selected: { status: 'ok', package: { id: 'logic', name: 'Logic', description: '' }, entries: [] },
    entryKinds: [], metricMacroSources: {}
  })),
  createPackage: vi.fn(async () => ({ status: 'ok', file: 'logic.json' }))
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1 },
  RelativePattern: class { constructor(public root: unknown, public pattern: string) {} },
  commands: { executeCommand: async (...args: unknown[]) => { mocks.commands.push(args); } },
  window: {
    showInformationMessage: vi.fn(), showWarningMessage: vi.fn(),
    createWebviewPanel: () => {
      const panel = {
        webview: {
          html: '', postMessage: async (message: unknown) => { mocks.posts.push(message); return true; },
          onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
            mocks.receivers.push(handler); return { dispose: vi.fn() };
          }
        },
        reveal: vi.fn(), dispose: vi.fn(), onDidDispose: vi.fn(() => ({ dispose: vi.fn() }))
      };
      mocks.panels.push(panel);
      return panel;
    }
  },
  workspace: {
    createFileSystemWatcher: vi.fn(() => ({
      onDidCreate: vi.fn(), onDidChange: vi.fn(), onDidDelete: vi.fn(), dispose: vi.fn()
    })),
    onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

vi.mock('./snlDoc', () => ({
  readEntryPackagePanelSnapshot: mocks.snapshot,
  entryBelongsToPackage: mocks.belongs,
  createEntryPackage: mocks.createPackage
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>', firstWorkspaceFolder: () => ({ path: '/ws' }),
  handlePanelNavMessage: async () => false, webviewLocalResourceRoots: () => []
}));
vi.mock('./preferencesHost', () => ({ bind_preferences_panel_title: vi.fn() }));
vi.mock('./preferences', () => ({
  extension_preferences_runtime: { query_environment: () => ({ language: 'en' }) }
}));
vi.mock('./entryMetricSettings', () => ({ readEntryMetricThresholds: () => ({}) }));

const extensionUri = { path: '/ext' } as never;

describe('Entry Package host panels', () => {
  beforeEach(() => {
    mocks.receivers.length = 0; mocks.posts.length = 0; mocks.commands.length = 0;
    mocks.panels.length = 0; mocks.belongs.mockReset().mockResolvedValue(true);
    mocks.snapshot.mockClear(); mocks.createPackage.mockReset().mockResolvedValue({ status: 'ok', file: 'logic.json' });
    vi.resetModules();
  });

  it('keeps one management panel per Package and binds crafted Entry actions to that Package', async () => {
    const { EntryPackagePanel } = await import('./entryPackagePanel');
    EntryPackagePanel.createOrShow(extensionUri, 'logic');
    EntryPackagePanel.createOrShow(extensionUri, 'logic');
    expect(mocks.panels).toHaveLength(1);
    expect(mocks.panels[0].reveal).toHaveBeenCalled();

    const receive = mocks.receivers[0];
    await receive({ type: 'ready' });
    await receive({ type: 'createEntry' });
    await receive({ type: 'editEntry', id: 'def-and' });
    await receive({ type: 'deleteEntry', id: 'def-and' });
    expect(mocks.commands).toContainEqual(['snlDoc.createEntry', undefined, 'logic']);
    expect(mocks.commands).toContainEqual(['snlDoc.editEntry', 'def-and', 'logic']);
    expect(mocks.commands).toContainEqual(['snlDoc.deleteEntry', 'def-and', 'logic']);

    mocks.belongs.mockResolvedValue(false);
    await receive({ type: 'deleteEntry', id: 'other-package-entry' });
    expect(mocks.commands).not.toContainEqual(['snlDoc.deleteEntry', 'other-package-entry', 'logic']);
  });

  it('opens the dedicated creator, rejects crafted fields, and opens the created Entry Package', async () => {
    const { CreateEntryPackagePanel } = await import('./createEntryPackagePanel');
    CreateEntryPackagePanel.createOrShow(extensionUri);
    const receive = mocks.receivers[0];
    await receive({ type: 'create', id: '../macro', name: 'Wrong', description: '' });
    expect(mocks.createPackage).not.toHaveBeenCalled();
    expect(mocks.posts.at(-1)).toMatchObject({ type: 'invalid' });

    await receive({ type: 'create', id: 'logic', name: 'Logic', description: 'Entries' });
    expect(mocks.createPackage).toHaveBeenCalledWith({ path: '/ws' }, 'logic', 'Logic', 'Entries');
    expect(mocks.commands).toContainEqual(['snlDoc.openEntryPackage', 'logic']);
  });
});
