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

vi.mock('./preferencesHost', () => ({ bind_preferences_panel_locale_change() {} }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));

import { ExportOptionsPanel } from './exportOptionsPanel';
import * as vscode from 'vscode';
import { buildExportDocument } from './exportHtmlDocument';
import { writeExport } from './exportWriter';

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
          defaultDestination: '/workspace/algebra-export', sourceAvailable: false, sourceRoot: ''
        }
      }
    ]);
    // Continue the complete historical oracle: compatibility refresh must use
    // the latest handed-over frozen payload, never recapture or export it.
    const revalidate = vi.fn();
    const payload = { slug: 'geometry', title: 'Frozen geometry', body: '<i data-entry-id="b"></i><i data-entry-id="c"></i>', assets: [{ path: 'a.png', sourceUrl: 'file:///a.png' }] };
    const before = structuredClone(payload);
    ExportOptionsPanel.show({ path: '/extension', fsPath: '/extension' } as never, payload,
      { rootPath: '/frozen-root', renderSnapshotId: 'frozen-2', revalidate } as never);
    mocks.posted.length = 0;
    await mocks.receive!({ type: 'unknown' });
    expect(mocks.posted).toEqual([]);
    for (const type of ['nav.refresh', 'ready', 'nav.refresh']) await mocks.receive!({ type });
    expect(mocks.posted).toEqual(Array.from({ length: 3 }, () => ({ type: 'exportContext', context: {
      slug: 'geometry', title: 'Frozen geometry', entryCount: 2, assetCount: 1,
      defaultDestination: '/workspace/geometry-export', sourceAvailable: true, sourceRoot: '/frozen-root'
    } })));
    expect(payload).toEqual(before);
    expect(revalidate).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(buildExportDocument).not.toHaveBeenCalled();
    expect(writeExport).not.toHaveBeenCalled();
  });
});
