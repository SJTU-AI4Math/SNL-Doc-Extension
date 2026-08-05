import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  readOverview: mocks.readOverview,
  resolveActiveMacroPackages: vi.fn(async () => []),
  setActiveMacroPackages: vi.fn(async () => undefined)
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/ws', scheme: 'file', toString: () => 'file:/ws' })
}));
vi.mock('./entryMetricSettings', () => ({ readEntryMetricThresholds: () => ({}) }));
vi.mock('./vscodeDataMigration', () => ({ inspectWorkspaceDataVersion: mocks.inspect }));

import { DashboardPanel } from './dashboardPanel';

describe('Dashboard data migration host routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receive = undefined;
    DashboardPanel.currentPanel = undefined;
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
    const plainSetup = mocks.receive?.({ type: 'init' });
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
