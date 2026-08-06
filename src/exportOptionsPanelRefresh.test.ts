import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => Promise<void>) | undefined,
  posted: [] as unknown[]
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  Uri: {
    joinPath: (base: any, ...parts: string[]) => ({
      path: [base.path, ...parts].join('/'),
      fsPath: [base.fsPath ?? base.path, ...parts].join('/')
    }),
    file: (fsPath: string) => ({ fsPath })
  },
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: '', cspSource: 'test',
        asWebviewUri: (uri: any) => ({ toString: () => uri.path }),
        postMessage: async (message: unknown) => { mocks.posted.push(message); return true; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          mocks.receive = handler;
          return { dispose() {} };
        }
      },
      reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} })
    })
  },
  commands: { executeCommand: vi.fn() },
  workspace: { fs: { readFile: vi.fn() } }
}));

vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/workspace', fsPath: '/workspace' })
}));

vi.mock('./exportHtmlDocument', () => ({ buildExportDocument: vi.fn(), EXPORT_BASE_CSS: '' }));
vi.mock('./exportRuntime', () => ({ EXPORT_RUNTIME_CSS: '' }));
vi.mock('./exportWriter', () => ({
  defaultExportName: (slug: string, inline: boolean) => inline ? `${slug}.html` : `${slug}-export`,
  writeExport: vi.fn()
}));

import { ExportOptionsPanel } from './exportOptionsPanel';

describe('ExportOptionsPanel refresh', () => {
  beforeEach(() => {
    mocks.receive = undefined;
    mocks.posted.length = 0;
  });

  it('publishes current export context for nav.refresh', async () => {
    ExportOptionsPanel.show({ path: '/extension', fsPath: '/extension' } as never, {
      slug: 'algebra', title: 'Algebra', body: '<article data-entry-id="a"></article>', assets: []
    });
    expect(mocks.receive).toBeTypeOf('function');
    await mocks.receive!({ type: 'nav.refresh' });
    expect(mocks.posted).toEqual([
      {
        type: 'exportContext',
        context: {
          slug: 'algebra', title: 'Algebra', entryCount: 1, assetCount: 0,
          defaultDestination: '/workspace/algebra-export'
        }
      }
    ]);
  });
});
