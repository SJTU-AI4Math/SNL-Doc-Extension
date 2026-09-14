import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => Promise<void>) | undefined,
  postMessage: vi.fn(async (_message: unknown) => true),
  executeCommand: vi.fn(async () => undefined),
  initSnlDoc: vi.fn(async () => ({ status: 'created' as const })),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  readOverview: vi.fn(async () => ({
    hasSnlDoc: true, totalEntryCount: 0, entries: [], libraries: [], macroPackages: [],
    allMacros: [], metricMacroSources: {}, entryKinds: [], macroKinds: [], relationships: []
  })),
  statistics: vi.fn(async (_root: unknown, _catalog: unknown, _signal: AbortSignal): Promise<unknown> => ({})),
  relationships: vi.fn(async (_root: unknown, _signal: AbortSignal) => ({ relationships: [], entries: [] })),
  inspect: vi.fn(async () => ({
    status: 'current', currentVersion: '0.0.4', targetVersion: '0.0.4',
    pending: [], message: 'current'
  }))
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ViewColumn: { Active: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  RelativePattern: class { constructor(..._args: unknown[]) {} },
  commands: { executeCommand: mocks.executeCommand },
  window: {
    activeColorTheme: { kind: 2 },
    createWebviewPanel: () => ({
      webview: {
        html: '',
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          mocks.receive = handler;
          return { dispose() {} };
        },
        postMessage: mocks.postMessage
      },
      reveal() {},
      onDidDispose: () => ({ dispose() {} }),
      dispose() {}
    }),
    showInformationMessage: mocks.showInformationMessage,
    showWarningMessage: mocks.showWarningMessage,
    showErrorMessage: mocks.showErrorMessage
  },
  workspace: {
    getConfiguration: () => ({ get: () => 'auto' }),
    createFileSystemWatcher: () => ({
      onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {}
    }),
    onDidChangeConfiguration: () => ({ dispose() {} })
  }
}));

vi.mock('./snlDoc', () => ({
  initSnlDoc: mocks.initSnlDoc,
  ENTRY_KIND_PRESETS: [{ id: 'entry-one', copyKeys: { label: 'fulcrumLabel', description: 'fulcrumDescription' }, kinds: [{ id: 'e' }] }],
  MACRO_KIND_PRESETS: [{ id: 'macro-one', copyKeys: { label: 'basicsLabel', description: 'basicsDescription' }, kinds: [{ id: 'm' }] }],
  readOverview: mocks.readOverview,
  readDashboardCatalog: async () => ({ ...await mocks.readOverview(), dataStatus: { status: 'unchecked' } }),
  resolveActiveMacroPackages: vi.fn(async () => []),
  setActiveMacroPackages: vi.fn(async () => undefined)
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/ws', scheme: 'file', toString: () => 'file:/ws' }),
  webviewLocalResourceRoots: () => []
}));
vi.mock('./dashboardStatistics', () => ({
  readDashboardStatistics: mocks.statistics,
  readDashboardRelationships: mocks.relationships
}));
vi.mock('./entryMetricSettings', () => ({ readEntryMetricThresholds: () => ({}) }));
vi.mock('./vscodeDataMigration', () => ({
  inspectWorkspaceDataVersion: mocks.inspect,
  readDashboardWorkspaceData: async () => ({
    overview: await mocks.readOverview(),
    inspection: await mocks.inspect()
  })
}));

import { DashboardPanel } from './dashboardPanel';

describe('Dashboard data migration host routing', () => {
  afterEach(() => DashboardPanel.currentPanel?.dispose());
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receive = undefined;
    DashboardPanel.currentPanel = undefined;
  });

  it('publishes the catalog without running full inspection on ready', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'ready' });
    expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'overview' }));
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('keeps navigation live and coalesces refreshes while aborting a blocked old scan', async () => {
    let release!: (value: unknown) => void;
    mocks.statistics.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'ready' });
    await vi.waitFor(() => expect(mocks.statistics).toHaveBeenCalledTimes(1));
    const signal = mocks.statistics.mock.calls[0][2];
    await mocks.receive?.({ type: 'openInfoviewGraph' });
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.openInfoviewGraph');
    await Promise.all(Array.from({ length: 12 }, () => mocks.receive?.({ type: 'nav.refresh' })));
    expect(signal.aborted).toBe(true);
    expect(mocks.statistics).toHaveBeenCalledTimes(1);
    release({ stale: true });
    await vi.waitFor(() => expect(mocks.statistics).toHaveBeenCalledTimes(2));
    const ready = mocks.postMessage.mock.calls.map(([m]) => m as { type: string; status?: string; generation?: number; statistics?: unknown })
      .filter(m => m.type === 'dashboardStatistics' && m.status === 'ready');
    expect(ready).toEqual([expect.objectContaining({ generation: 13, statistics: {} })]);
  });

  it('does not load relationship rows until requested and deduplicates expansion', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'ready' });
    await vi.waitFor(() => expect(mocks.statistics).toHaveBeenCalledTimes(1));
    expect(mocks.relationships).not.toHaveBeenCalled();
    await Promise.all(Array.from({ length: 5 }, () => mocks.receive?.({ type: 'loadDashboardRelationships' })));
    await vi.waitFor(() => expect(mocks.relationships).toHaveBeenCalledTimes(1));
    expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'dashboardRelationships', status: 'ready' }));
  });

  it('publishes only local statistics errors and suppresses post-disposal replies', async () => {
    mocks.statistics.mockRejectedValueOnce(new Error('bad entry'));
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'ready' });
    await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'dashboardStatistics', status: 'error', message: 'bad entry'
    })));
    expect(mocks.showErrorMessage).not.toHaveBeenCalled();
    let release!: (value: unknown) => void;
    mocks.statistics.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await mocks.receive?.({ type: 'nav.refresh' });
    await vi.waitFor(() => expect(mocks.statistics).toHaveBeenCalledTimes(2));
    DashboardPanel.currentPanel?.dispose();
    const count = mocks.postMessage.mock.calls.length;
    release({ disposed: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(mocks.statistics.mock.calls[1][2].aborted).toBe(true);
    expect(mocks.postMessage).toHaveBeenCalledTimes(count);
  });

  it('routes Pointer maintenance to the global registered command', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'maintainPointers' });
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.maintainPointers');
  });

  it('posts running and idle states around the repair command and refreshes overview', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    expect(mocks.receive).toBeTypeOf('function');
    await mocks.receive?.({ type: 'repairData' });

    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.repairData');
    expect(mocks.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: 'dataMigrationStatus', status: 'running', operation: 'repair' },
      expect.objectContaining({ type: 'overview' }),
      { type: 'dataMigrationStatus', status: 'idle', operation: 'repair' }
    ]);
  });

  it('projects localized preset catalogs before .SNL_Doc exists', async () => {
    mocks.readOverview.mockResolvedValueOnce({ hasSnlDoc: false } as never);
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'ready' });
    expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'overview',
      overview: expect.objectContaining({
        entryKindPresets: [expect.objectContaining({ id: 'entry-one', count: 1 })],
        macroKindPresets: [expect.objectContaining({ id: 'macro-one', count: 1 })]
      })
    }));
  });

  it('validates both init choices and forwards one atomic initialization call', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: 'init', entryKindPresetId: 'entry-one', macroKindPresetId: 'macro-one' });
    expect(mocks.initSnlDoc).toHaveBeenCalledWith(expect.anything(), {
      entryKindPresetId: 'entry-one', macroKindPresetId: 'macro-one'
    });

    mocks.initSnlDoc.mockClear();
    await mocks.receive?.({ type: 'init', entryKindPresetId: 'missing', macroKindPresetId: '' });
    await mocks.receive?.({ type: 'init', entryKindPresetId: '', macroKindPresetId: 3 });
    expect(mocks.initSnlDoc).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalled();
  });

  it.each([
    ['initEntryKinds', 'snlDoc.initEntryKinds'],
    ['initMacroKinds', 'snlDoc.initMacroKinds']
  ])('creates the SNL skeleton before routing %s from initial setup', async (messageType, command) => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    await mocks.receive?.({ type: messageType });

    expect(mocks.initSnlDoc).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).toHaveBeenCalledWith(command);
    expect(mocks.initSnlDoc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeCommand.mock.invocationCallOrder[0]
    );
  });

  it('shares one skeleton initialization across all concurrent initial setup clicks', async () => {
    let releaseInit!: () => void;
    mocks.initSnlDoc.mockImplementationOnce(() => new Promise((resolve) => {
      releaseInit = () => resolve({ status: 'created' as const });
    }));
    DashboardPanel.createOrShow({ path: '/ext' } as never);

    const entrySetup = mocks.receive?.({ type: 'initEntryKinds' });
    const plainSetup = mocks.receive?.({ type: 'init', entryKindPresetId: '', macroKindPresetId: '' });
    const macroSetup = mocks.receive?.({ type: 'initMacroKinds' });
    await Promise.resolve();

    expect(mocks.initSnlDoc).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    releaseInit();
    await Promise.all([entrySetup, plainSetup, macroSetup]);
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.initEntryKinds');
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.initMacroKinds');
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('snlDoc.init');
    expect(mocks.showInformationMessage).toHaveBeenCalled();
    expect(
      mocks.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => (message as { type?: string }).type === 'setupStatus')
    ).toEqual([
      { type: 'setupStatus', status: 'running' },
      { type: 'setupStatus', status: 'idle' }
    ]);
  });

  it('rejects a concurrent initialization with different Kind preset choices', async () => {
    let releaseInit!: () => void;
    mocks.initSnlDoc.mockImplementationOnce(() => new Promise((resolve) => {
      releaseInit = () => resolve({ status: 'created' as const });
    }));
    DashboardPanel.createOrShow({ path: '/ext' } as never);

    const first = mocks.receive?.({
      type: 'init', entryKindPresetId: 'entry-one', macroKindPresetId: ''
    });
    await vi.waitFor(() => expect(mocks.initSnlDoc).toHaveBeenCalledTimes(1));
    const conflicting = mocks.receive?.({
      type: 'init', entryKindPresetId: '', macroKindPresetId: 'macro-one'
    });
    await conflicting;

    expect(mocks.initSnlDoc).toHaveBeenCalledTimes(1);
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('different Kind preset choices')
    );
    releaseInit();
    await Promise.all([first, conflicting]);
    expect(mocks.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects blank Dashboard Kind edit ids while routing valid ids', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);

    await mocks.receive?.({ type: 'editEntryKind', id: '   ' });
    await mocks.receive?.({ type: 'editMacroKind', id: '' });
    await mocks.receive?.({ type: 'editEntryKind', id: 'entry-kind' });
    await mocks.receive?.({ type: 'editMacroKind', id: 'macro-kind' });

    expect(mocks.executeCommand.mock.calls).toEqual([
      ['snlDoc.editEntryKind', 'entry-kind'],
      ['snlDoc.editMacroKind', 'macro-kind']
    ]);
  });

  it('does not open a Kind preset panel when skeleton initialization fails', async () => {
    mocks.initSnlDoc.mockRejectedValueOnce(new Error('disk failed'));
    DashboardPanel.createOrShow({ path: '/ext' } as never);

    await mocks.receive?.({ type: 'initEntryKinds' });

    expect(mocks.executeCommand).not.toHaveBeenCalled();
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('disk failed')
    );
  });

  it('releases setup busy accounting when the running status post fails', async () => {
    mocks.postMessage.mockRejectedValueOnce(new Error('webview disposed'));
    DashboardPanel.createOrShow({ path: '/ext' } as never);

    await expect(mocks.receive?.({ type: 'initEntryKinds' })).rejects.toThrow(
      'webview disposed'
    );
    expect(mocks.initSnlDoc).not.toHaveBeenCalled();

    await mocks.receive?.({ type: 'initEntryKinds' });
    expect(mocks.initSnlDoc).toHaveBeenCalledTimes(1);
    expect(mocks.executeCommand).toHaveBeenCalledWith('snlDoc.initEntryKinds');
  });

  it('drops stale overview reads when a newer refresh finishes first', async () => {
    DashboardPanel.createOrShow({ path: '/ext' } as never);
    const fresh = {
      hasSnlDoc: true, totalEntryCount: 2, entries: [], libraries: [], macroPackages: [],
      allMacros: [], metricMacroSources: {}, entryKinds: [], macroKinds: [], relationships: []
    };
    let release!: (value: typeof fresh) => void;
    const slow = new Promise<typeof fresh>((resolve) => { release = resolve; });
    mocks.readOverview
      .mockImplementationOnce(async () => slow)
      .mockResolvedValueOnce(fresh);

    const oldRequest = mocks.receive?.({ type: 'ready' });
    const newRequest = mocks.receive?.({ type: 'ready' });
    await newRequest;
    release({ ...fresh, totalEntryCount: 1 });
    await oldRequest;

    const overviews = mocks.postMessage.mock.calls
      .map(([message]) => message as { type?: string; overview?: { totalEntryCount?: number } })
      .filter((message) => message.type === 'overview');
    expect(overviews).toHaveLength(1);
    expect(overviews[0].overview?.totalEntryCount).toBe(2);
  });
});
