import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ messages: [] as any[], receive: undefined as any, dirty: [] as any[], writes: vi.fn(), capture: vi.fn(), validate: vi.fn(), root: { fsPath: '/workspace', path: '/workspace', scheme: 'file', toString: () => 'file:///workspace' } }));
vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 }, Uri: { file: (p: string) => ({ path: p, fsPath: p, scheme: 'file' }), joinPath: (_u: any, ...parts: string[]) => ({ path: parts.join('/'), fsPath: parts.join('/'), scheme: 'file' }) },
  workspace: { get textDocuments() { return state.dirty; }, fs: { readFile: async () => Buffer.from('runtime') } },
  window: { createWebviewPanel: () => ({ title: '', webview: { html: '', postMessage: async (m: unknown) => { state.messages.push(m); }, onDidReceiveMessage: (f: unknown) => { state.receive = f; } }, reveal() {}, onDidDispose() {}, dispose() {} }), showWarningMessage: vi.fn() },
  commands: { executeCommand: vi.fn() }
}));
vi.mock('../panelUtil', () => ({ buildPanelHtml: () => '', firstWorkspaceFolder: () => state.root }));
vi.mock('../preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
vi.mock('../preferencesHost', () => ({ bind_preferences_panel_locale_change: () => {} }));
vi.mock('../sourceExport/archive', () => ({ SourcePreflightError: class SourcePreflightError extends Error {}, captureSourceSnapshot: (...a: unknown[]) => state.capture(...a), revalidateSourceSnapshot: (...a: unknown[]) => state.validate(...a) }));
vi.mock('../exportWriter', () => ({ defaultExportName: () => 'export', writeExport: (...a: unknown[]) => state.writes(...a) }));
import { ExportOptionsPanel } from '../exportOptionsPanel';
import { DEFAULT_SOURCE_OPTIONS } from './types';
const options = { ...DEFAULT_SOURCE_OPTIONS, enabled: true };
const sourceContext = () => ({ rootPath: '/workspace', renderSnapshotId: 'render-A', entries: [], entryRoutes: [], revalidate: vi.fn(async () => {}) });
const preview = () => ({ confirmationId: 'capture-A', manifest: { files: [{ displayPath: 'Main.lean', kind: 'text', byteLength: 3 }], directories: [], pointers: [] }, chunks: [], totalBytes: 3, estimatedBytes: 4, exclusions: [], warnings: [], externalRoots: [] });
const payload = { slug: 'L', title: 'L', body: '<p>L</p>', assets: [], renderSnapshotId: 'render-A' };
beforeEach(() => {
  (ExportOptionsPanel as any).current = undefined;
  state.messages = []; state.dirty = []; state.capture.mockReset(); state.validate.mockReset(); state.writes.mockReset();
  state.capture.mockImplementation(async () => preview()); state.validate.mockResolvedValue(undefined);
  state.writes.mockImplementation(async (_request: unknown, deps: any) => { await deps.beforePublish?.(); return { target: { path: '/output/index.html', fsPath: '/output/index.html' }, fileCount: 1, warnings: [] }; });
});
const preflight = () => state.receive({ type: 'previewSources', requestId: 7, shape: 'directory', destination: '/output', sources: options });
const run = (extra = {}) => state.receive({ type: 'runExport', shape: 'directory', destination: '/output', interactive: true, sources: options, confirmationId: 'capture-A', ...extra });
describe('source export host authority', () => {
  it('refuses unconfirmed and retargeted previews, regardless of claimed client consent', async () => {
    ExportOptionsPanel.show({} as never, payload, sourceContext());
    await run(); expect(state.writes).not.toHaveBeenCalled();
    await preflight(); await run({ destination: '/other' }); expect(state.writes).not.toHaveBeenCalled();
    await run(); expect(state.writes).toHaveBeenCalledTimes(1);
    expect(state.validate).toHaveBeenCalledTimes(2);
  });
  it('revalidates document dependencies and rejects source changes before writing', async () => {
    const context = sourceContext(); ExportOptionsPanel.show({} as never, payload, context); await preflight();
    context.revalidate.mockRejectedValueOnce(new Error('document changed'));
    await run(); expect(state.writes).not.toHaveBeenCalled();
    state.validate.mockRejectedValueOnce(new Error('source changed'));
    await run(); expect(state.writes).not.toHaveBeenCalled();
  });
  it('never lets a late preview from a replaced Library regain confirmation authority', async () => {
    let resolve!: (x: any) => void; state.capture.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    ExportOptionsPanel.show({} as never, payload, sourceContext());
    const pending = preflight(); await Promise.resolve();
    ExportOptionsPanel.show({} as never, { ...payload, slug: 'other' }, sourceContext());
    resolve(preview()); await pending; await run();
    expect(state.messages.some(m => m.type === 'sourcePreview')).toBe(false); expect(state.writes).not.toHaveBeenCalled();
  });
  it('requires explicit disk acknowledgement and never implicitly saves buffers', async () => {
    const save = vi.fn(); state.dirty = [{ isDirty: true, uri: { scheme: 'file', fsPath: '/workspace/Main.lean' }, save }];
    ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    await run(); expect(state.writes).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    await run({ diskAcknowledged: true }); expect(state.writes).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  });
  it('fails rather than silently dropping requested sources when interaction is disabled', async () => {
    ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    await run({ interactive: false }); expect(state.writes).not.toHaveBeenCalled();
  });
});
