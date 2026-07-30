import { beforeEach, describe, expect, it, vi } from 'vitest';

const commands: unknown[][] = [];
let receive: ((message: unknown) => Promise<void>) | undefined;

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { path: string }, ...parts: string[]) => ({
      path: [base.path, ...parts].join('/'),
      fsPath: [base.path, ...parts].join('/')
    })
  },
  ViewColumn: { Active: -1 },
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class {},
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  env: { language: 'en' },
  commands: {
    executeCommand: async (...args: unknown[]) => { commands.push(args); }
  },
  window: {
    activeColorTheme: { kind: 2 },
    onDidChangeActiveColorTheme: () => ({ dispose: () => undefined }),
    createOutputChannel: () => undefined,
    showErrorMessage: () => undefined,
    showWarningMessage: () => undefined,
    createWebviewPanel: () => ({
      webview: {
        html: '',
        asWebviewUri: (uri: { path: string }) => ({ toString: () => uri.path }),
        cspSource: 'vscode-webview://x',
        postMessage: async () => true,
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          receive = handler;
          return { dispose: () => undefined };
        }
      },
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    })
  },
  workspace: {
    workspaceFolders: [{ uri: { path: '/ws', fsPath: '/ws' } }],
    getConfiguration: () => ({ get: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  }
}));

vi.mock('./snlDoc', () => ({
  readMacroKinds: async () => [],
  readMacroPackage: async () => ({ status: 'noFile' }),
  readMacroPackages: async () => [],
  resolveActiveMacroPackages: async () => [],
  setActiveMacroPackages: async () => undefined,
  batchDeleteMacros: async () => ({ status: 'ok' }),
  batchMoveMacros: async () => ({ status: 'ok' }),
  batchCopyMacros: async () => ({ status: 'ok' }),
  batchPackageAsNew: async () => ({ status: 'ok' }),
  batchMoveToNewPackage: async () => ({ status: 'ok' }),
  readEntries: async () => []
}));

const extensionUri = { path: '/ext', fsPath: '/ext' } as never;

describe('PackagePanel Copy Macro host route', () => {
  beforeEach(() => {
    commands.length = 0;
    receive = undefined;
    vi.resetModules();
  });

  it('opens the existing Create Macro lifecycle in the same package with copyFrom', async () => {
    const { PackagePanel } = await import('./packagePanel');
    PackagePanel.createOrShow(extensionUri, 'algebra.json');

    await receive?.({ type: 'copyMacro', name: 'original' });

    expect(commands).toEqual([
      ['snlDoc.createMacro', 'algebra', { copyFrom: 'original' }]
    ]);
  });
});
