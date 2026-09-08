import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rootCount: 1, messages: [] as any[], receive: undefined as any, dirty: [] as any[], onReadDocuments: undefined as (() => void) | undefined, onRealpath: undefined as ((path: string) => void) | undefined, writes: vi.fn(), capture: vi.fn(), validate: vi.fn(), root: { fsPath: '/workspace', path: '/workspace', scheme: 'file', toString: () => 'file:///workspace' } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: async (path: string) => { state.onRealpath?.(path); return actual.realpath(path); } };
});
vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 }, Uri: { file: (p: string) => ({ path: p, fsPath: p, scheme: 'file' }), joinPath: (_u: any, ...parts: string[]) => ({ path: parts.join('/'), fsPath: parts.join('/'), scheme: 'file' }) },
  workspace: { get workspaceFolders() { return Array.from({length:state.rootCount},()=>({uri:state.root})); }, get textDocuments() { state.onReadDocuments?.(); return state.dirty; }, fs: { readFile: async () => Buffer.from('runtime') } },
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
const payload = { slug: 'L', title: 'L', body: '<p>L</p>', assets: [], renderSnapshotId: 'render-A', readerSnapshot: {
  version: 1 as const, renderSnapshotId: 'render-A',
  library: { slug: 'L', title: 'L', outline: [], warnings: [] },
  entries: [], entryKinds: [], entryPackages: {}, macros: {}, macroKinds: [], relationships: [], resources: {},
  preferences: { language: 'en', color_scheme: 'light', motion: 'full' }, contentLanguage: 'en',
  languages: [{ id: 'en', display_name: 'English' }]
} };
beforeEach(() => {
  (ExportOptionsPanel as any).current = undefined;
  state.rootCount = 1; state.messages = []; state.dirty = []; state.onReadDocuments = undefined; state.onRealpath = undefined; state.capture.mockReset(); state.validate.mockReset(); state.writes.mockReset();
  state.capture.mockImplementation(async () => preview()); state.validate.mockResolvedValue(undefined);
  state.writes.mockImplementation(async (_request: unknown, deps: any) => { await deps.beforePublish?.(); return { target: { path: '/output/index.html', fsPath: '/output/index.html' }, fileCount: 1, warnings: [] }; });
});
const preflight = () => state.receive({ type: 'previewSources', requestId: 7, shape: 'directory', destination: '/output', sources: options });
const run = (extra = {}) => state.receive({ type: 'runExport', shape: 'directory', destination: '/output', interactive: true, sources: options, confirmationId: 'capture-A', ...extra });
describe('source export host authority', () => {
  it.each([true, false])('carries unavailable Pointer diagnostics to preview and honors allowMissing=%s at publication', async allowMissing => {
    const p = { ...preview(), manifest: { ...preview().manifest, pointers: [{ entryId: 'missing', status: 'excluded', reason: 'default build/cache exclusion' }] } };
    state.capture.mockResolvedValue(p);
    const selected = { ...options, allowMissing };
    ExportOptionsPanel.show({} as never, payload, sourceContext());
    await state.receive({ type: 'previewSources', requestId: 7, shape: 'directory', destination: '/output', sources: selected });
    expect(state.messages.find(m => m.type === 'sourcePreview').preview.unresolved).toEqual(p.manifest.pointers);
    await run({ sources: selected });
    if (allowMissing) {
      expect(state.writes).toHaveBeenCalledOnce();
      expect(state.writes.mock.calls[0][0].body).toBe(payload.body);
      expect(state.writes.mock.calls[0][0].sourcePreview).toEqual(p);
      expect(state.validate).toHaveBeenCalledTimes(2);
    } else {
      expect(state.writes).not.toHaveBeenCalled();
      expect(state.messages.at(-1).message).toMatch(/Pointer targets unavailable/);
    }
  });
  it('fails closed when an interactive export has no versioned raw snapshot', async () => {
    const { readerSnapshot: _snapshot, ...legacyPayload } = payload;
    ExportOptionsPanel.show({} as never, legacyPayload, sourceContext()); await preflight(); await run();
    expect(state.writes).not.toHaveBeenCalled();
    expect(state.messages.at(-1).message).toMatch(/snapshot missing|snapshot\/context mismatch/i);
  });
  it('rejects ambiguous multi-root source export instead of silently choosing first root', async () => {
    state.rootCount=2; ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    expect(state.capture).not.toHaveBeenCalled(); expect(state.messages.at(-1).message).toMatch(/single.*local|one.*local|single.*root/i);
  });
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
  it.each([false, true])('rechecks newly dirty buffers after final source validation (disk consent=%s)', async (diskAcknowledged) => {
    const save = vi.fn(), publish = vi.fn();
    state.validate.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      state.dirty = [{ isDirty: true, uri: { scheme: 'file', fsPath: '/workspace/Main.lean' }, save }];
    });
    state.writes.mockImplementation(async (_request, deps) => {
      await deps.beforePublish(); publish();
      return { target: { fsPath: '/output/index.html' }, fileCount: 1, warnings: [] };
    });
    ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    await run({ diskAcknowledged });
    expect(state.validate).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(diskAcknowledged ? 1 : 0);
    expect(save).not.toHaveBeenCalled();
    expect(state.messages.at(-1).type).toBe(diskAcknowledged ? 'exportDone' : 'exportFailed');
    if (!diskAcknowledged) expect(state.messages.at(-1).message).toMatch(/unsaved source files/i);
  });
  it('samples dirty flags after asynchronous document alias lookups have finished', async () => {
    const selected = { isDirty: false, uri: { scheme: 'file', fsPath: '/workspace/Main.lean' } };
    state.dirty = [selected, { isDirty: true, uri: { scheme: 'file', fsPath: '/workspace/Unrelated.lean' } }];
    const publish = vi.fn();
    state.writes.mockImplementation(async (_request, deps) => {
      await deps.beforePublish(); publish();
      return { target: { fsPath: '/output/index.html' }, fileCount: 1, warnings: [] };
    });
    ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    state.onRealpath = (path) => {
      if (state.validate.mock.calls.length === 2 && path.endsWith('/Unrelated.lean')) selected.isDirty = true;
    };
    await run();
    expect(selected.isDirty).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(state.messages.at(-1).message).toMatch(/unsaved source files/i);
  });
  it('rejects context replacement during the final dirty-buffer lookup', async () => {
    const publish = vi.fn();
    state.writes.mockImplementation(async (_request, deps) => {
      await deps.beforePublish(); publish();
      return { target: { fsPath: '/output/index.html' }, fileCount: 1, warnings: [] };
    });
    ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    state.onReadDocuments = () => {
      if (state.validate.mock.calls.length !== 2) return;
      state.onReadDocuments = undefined;
      ExportOptionsPanel.show({} as never, { ...payload, slug: 'replacement' }, sourceContext());
    };
    await run();
    expect(publish).not.toHaveBeenCalled();
    expect(state.messages.at(-1).message).toMatch(/context changed/i);
  });
  it('does not require disk consent for source-disabled export', async () => {
    state.dirty = [{ isDirty: true, uri: { scheme: 'file', fsPath: '/workspace/Main.lean' } }];
    ExportOptionsPanel.show({} as never, payload, sourceContext());
    await run({ sources: { ...options, enabled: false } });
    expect(state.writes).toHaveBeenCalledOnce();
    expect(state.messages.at(-1).type).toBe('exportDone');
  });
  it('fails rather than silently dropping requested sources when interaction is disabled', async () => {
    ExportOptionsPanel.show({} as never, payload, sourceContext()); await preflight();
    await run({ interactive: false }); expect(state.writes).not.toHaveBeenCalled();
  });
});
