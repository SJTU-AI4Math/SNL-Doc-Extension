import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => Promise<void>) | undefined,
  posted: [] as Array<Record<string, unknown>>,
  readMacroPackagesCalls: 0,
  otherInFlight: 0,
  maxOtherInFlight: 0,
  packageReads: [] as string[]
}));

vi.mock('vscode', () => ({
  ColorThemeKind: { Dark: 2 },
  env: { language: 'en' },
  Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
  ViewColumn: { Active: -1 },
  RelativePattern: class {},
  commands: { executeCommand: async () => undefined },
  window: {
    activeColorTheme: { kind: 2 },
    createWebviewPanel: () => ({
      webview: {
        html: '',
        postMessage: async (message: Record<string, unknown>) => { state.posted.push(message); return true; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          state.receive = handler;
          return { dispose: () => undefined };
        }
      },
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }),
    showWarningMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  }
}));

vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/ws' }),
  handlePanelNavMessage: async () => false
}));

vi.mock('./snlDoc', () => ({
  readMacroPackage: async (_root: unknown, file: string) => {
    state.packageReads.push(file);
    if (file === 'current') {
      return { status: 'ok', pkg: { name: 'Current' }, macros: [] };
    }
    state.otherInFlight += 1;
    state.maxOtherInFlight = Math.max(state.maxOtherInFlight, state.otherInFlight);
    await new Promise((resolve) => setTimeout(resolve, file === 'alpha' ? 8 : 2));
    state.otherInFlight -= 1;
    if (file === 'missing') return { status: 'noFile' };
    return { status: 'ok', pkg: { name: file.toUpperCase() }, macros: [] };
  },
  readMacroPackages: async () => {
    state.readMacroPackagesCalls += 1;
    return ['current', 'alpha', 'beta'].map((file) => ({ file: `${file}.json`, macroCount: 0 }));
  },
  resolveActiveMacroPackages: async () => ['current', 'alpha', 'beta', 'missing'],
  readMacroKinds: async () => [],
  readAllMacros: async () => ({}),
  readEntries: async () => [],
  setMacroPackageActive: async () => undefined,
  batchDeleteMacros: async () => ({ status: 'ok' }),
  batchMoveMacros: async () => ({ status: 'ok' }),
  batchCopyMacros: async () => ({ status: 'ok' }),
  batchPackageAsNew: async () => ({ status: 'ok' }),
  batchMoveToNewPackage: async () => ({ status: 'ok' })
}));

const extensionUri = { path: '/ext' } as never;

describe('PackagePanel read cost', () => {
  beforeEach(() => {
    state.receive = undefined;
    state.posted.length = 0;
    state.readMacroPackagesCalls = 0;
    state.otherInFlight = 0;
    state.maxOtherInFlight = 0;
    state.packageReads.length = 0;
  });

  it('loads active package metadata once and concurrently without a summary N+1 pass', async () => {
    const { PackagePanel } = await import('./packagePanel');
    (PackagePanel as unknown as { panels: Map<string, unknown> }).panels.clear();
    PackagePanel.createOrShow(extensionUri, 'current.json');

    await state.receive?.({ type: 'ready' });

    expect(state.readMacroPackagesCalls).toBe(0);
    expect(state.maxOtherInFlight).toBeGreaterThan(1);
    expect(state.packageReads.sort()).toEqual(['alpha', 'beta', 'current', 'missing']);
    const payload = state.posted.find(({ type }) => type === 'package');
    expect(payload?.otherPackages).toEqual([
      { file: 'alpha', name: 'ALPHA' },
      { file: 'beta', name: 'BETA' }
    ]);
  });
});
