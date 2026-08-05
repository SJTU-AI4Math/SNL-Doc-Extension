import { describe, expect, it, vi } from 'vitest';

const posted: any[] = [];
let messageHandler: ((message: unknown) => Promise<void>) | undefined;

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: any, ...parts: string[]) => ({ path: [base.path, ...parts].join('/'), fsPath: [base.path, ...parts].join('/') }) },
  ViewColumn: { Active: -1 },
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: '', cspSource: 'vscode-webview://test',
        asWebviewUri: (uri: any) => ({ toString: () => uri.path }),
        postMessage: async (message: unknown) => { posted.push(message); return true; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { messageHandler = handler; return { dispose() {} }; }
      },
      reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} })
    })
  },
  commands: { executeCommand: async () => undefined }
}));

const pendingEntries: Array<{
  resolve: (entries: any[]) => void;
  reject: (error: Error) => void;
  promise: Promise<any[]>;
}> = [];
function deferredEntries(): Promise<any[]> {
  let resolve!: (entries: any[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any[]>((done, fail) => { resolve = done; reject = fail; });
  pendingEntries.push({ resolve, reject, promise });
  return promise;
}

vi.mock('./snlDoc', () => ({
  readEntries: vi.fn(() => deferredEntries()),
  readAllMacros: async () => ({}),
  resolveActiveMacroPackages: async () => [],
  readMacroPackages: async () => [],
  readMacroPackage: async () => ({ status: 'noFile' })
}));

vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/workspace', fsPath: '/workspace' }),
  handlePanelNavMessage: async () => false
}));
vi.mock('./preferences', () => ({
  read_extension_preferences: () => ({ language: 'en' })
}));

describe('SNoogLPanel query ordering', () => {
  it('never lets an older slower query replace the newest results', async () => {
    const { SnoogLPanel } = await import('./snooglPanel');
    SnoogLPanel.open({ path: '/extension', fsPath: '/extension' } as never);
    expect(messageHandler).toBeTruthy();

    const older = messageHandler!({ type: 'query', q: '', mode: 'entry', filters: {} });
    await vi.waitFor(() => expect(pendingEntries).toHaveLength(1));
    const newer = messageHandler!({ type: 'query', q: '', mode: 'entry', filters: {} });
    await vi.waitFor(() => expect(pendingEntries).toHaveLength(2));

    pendingEntries[1].resolve([{ id: 'new', title: 'Newest', kind: 'definition' }]);
    await newer;
    pendingEntries[0].resolve([{ id: 'old', title: 'Stale', kind: 'definition' }]);
    await older;

    const results = posted.filter((message) => message.type === 'results');
    expect(results).toHaveLength(1);
    expect(results[0].results.map((hit: any) => hit.id)).toEqual(['new']);

    const olderError = messageHandler!({ type: 'query', q: 'older-error', mode: 'entry', filters: {} });
    const newerSuccess = messageHandler!({ type: 'query', q: '', mode: 'entry', filters: {} });
    await vi.waitFor(() => expect(pendingEntries).toHaveLength(4));
    pendingEntries[3].resolve([{ id: 'newer-success', title: 'Newest success', kind: 'definition' }]);
    await newerSuccess;
    pendingEntries[2].reject(new Error('stale failure'));
    await olderError;
    expect(posted.filter((message) => message.type === 'error')).toHaveLength(0);

    const olderSuccess = messageHandler!({ type: 'query', q: '', mode: 'entry', filters: {} });
    const newerError = messageHandler!({ type: 'query', q: 'newest-error', mode: 'entry', filters: {} });
    await vi.waitFor(() => expect(pendingEntries).toHaveLength(6));
    pendingEntries[5].reject(new Error('newest failure'));
    await newerError;
    pendingEntries[4].resolve([{ id: 'stale-success', title: 'Stale success', kind: 'definition' }]);
    await olderSuccess;

    const errors = posted.filter((message) => message.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('newest failure');
    expect(posted.filter((message) => message.type === 'results').flatMap((message) =>
      message.results.map((hit: any) => hit.id))).not.toContain('stale-success');
  });
});
