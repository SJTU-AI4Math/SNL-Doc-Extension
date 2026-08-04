import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => Promise<void>) | undefined,
  postMessage: vi.fn(async (_message: unknown) => true),
  executeCommand: vi.fn(async () => undefined),
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
  ViewColumn: { Active: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  RelativePattern: class { constructor(..._args: unknown[]) {} },
  commands: { executeCommand: mocks.executeCommand },
  window: {
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
    showErrorMessage: vi.fn()
  },
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {}
    }),
    onDidChangeConfiguration: () => ({ dispose() {} })
  }
}));

vi.mock('./snlDoc', () => ({
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
