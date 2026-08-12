import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  receivers: [] as Array<(message: unknown) => Promise<void>>,
  posts: [] as unknown[],
  commands: [] as unknown[][],
  panels: [] as Array<{ reveal: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
  watchers: [] as Array<{ pattern: string; create?: () => void; change?: () => void; remove?: () => void }>,
  panelDisposals: [] as Array<() => void>,
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
        reveal: vi.fn(), dispose: vi.fn(), onDidDispose: vi.fn((handler: () => void) => {
          mocks.panelDisposals.push(handler); return { dispose: vi.fn() };
        })
      };
      mocks.panels.push(panel);
      return panel;
    }
  },
  workspace: {
    createFileSystemWatcher: vi.fn((pattern: { pattern: string }) => {
      const watched: { pattern: string; create?: () => void; change?: () => void; remove?: () => void } = {
        pattern: pattern.pattern
      };
      mocks.watchers.push(watched);
      return {
        onDidCreate: (handler: () => void) => { watched.create = handler; },
        onDidChange: (handler: () => void) => { watched.change = handler; },
        onDidDelete: (handler: () => void) => { watched.remove = handler; },
        dispose: vi.fn()
      };
    }),
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
    mocks.panels.length = 0; mocks.watchers.length = 0; mocks.panelDisposals.length = 0;
    mocks.belongs.mockReset().mockResolvedValue(true);
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

  it('watches only selected-Package metadata and entries, never unrelated entities or Macros', async () => {
    vi.useFakeTimers();
    try {
      const { EntryPackagePanel } = await import('./entryPackagePanel');
      EntryPackagePanel.createOrShow(extensionUri, 'logic');
      expect(mocks.watchers.map(({ pattern }) => pattern)).toEqual([
        expect.stringMatching(/^\.SNL_Doc\/packages\/logic-[0-9a-f]{20}\.json$/),
        `.SNL_Doc/entries/logic-${'?'.repeat(20)}.json`,
        '.SNL_Doc/config.json'
      ]);
      const receive = mocks.receivers[0];
      await receive({ type: 'ready' });
      expect(mocks.snapshot).toHaveBeenCalledTimes(1);

      // An unrelated Package/Entry has no registered callback and therefore cannot refresh.
      expect(mocks.watchers.some(({ pattern }) => pattern.includes('other'))).toBe(false);
      expect(mocks.watchers.some(({ pattern }) => pattern.includes('macros'))).toBe(false);
      mocks.watchers[1].change?.();
      await vi.advanceTimersByTimeAsync(120);
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates an in-flight refresh on dispose and never posts after disposal', async () => {
    let resolveSnapshot!: (value: Awaited<ReturnType<typeof mocks.snapshot>>) => void;
    mocks.snapshot.mockImplementationOnce(() => new Promise((resolve) => { resolveSnapshot = resolve; }));
    const { EntryPackagePanel } = await import('./entryPackagePanel');
    EntryPackagePanel.createOrShow(extensionUri, 'logic');
    const pending = mocks.receivers[0]({ type: 'ready' });
    await Promise.resolve();
    mocks.panelDisposals[0]();
    resolveSnapshot({
      selected: { status: 'ok', package: { id: 'logic', name: 'Logic', description: '' }, entries: [] },
      entryKinds: [], metricMacroSources: {}
    });
    await pending;
    expect(mocks.posts).toEqual([]);
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
