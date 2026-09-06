import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  root: '/A', changed: () => {}, commands: new Map<string, () => Promise<unknown>>(),
  execute: vi.fn(), editor: undefined as unknown,
  watchers: [] as Array<{ base: { fsPath: string }; pattern: string; disposed: boolean }>,
}));
const uri = (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri([base.fsPath, ...parts].join('/')) },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  ProgressLocation: { Notification: 15 },
  commands: { registerCommand: (id: string, run: () => Promise<unknown>) => { mocks.commands.set(id, run); return { dispose() {} }; }, executeCommand: mocks.execute },
  workspace: {
    fs: { stat: async () => { throw Error('fixture skips startup'); } },
    getWorkspaceFolder: () => ({ uri: uri(mocks.root) }),
    onDidChangeWorkspaceFolders: (run: () => void) => { mocks.changed = run; return { dispose() {} }; },
    onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: (p: { base: { fsPath: string }; pattern: string }) => {
      const record = { ...p, disposed: false }; mocks.watchers.push(record);
      return { onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() { record.disposed = true; } };
    },
  },
  window: {
    get activeTextEditor() { return mocks.editor; },
    onDidChangeWindowState: () => ({ dispose() {} }),
    showWarningMessage() {}, showInformationMessage: async () => undefined,
    withProgress: async (_options: unknown, task: (p: { report(): void }) => Promise<unknown>) => task({ report() {} }),
    createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
  },
}));
vi.mock('./panelUtil', () => ({ firstWorkspaceFolder: () => uri(mocks.root) }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
import { installPointerSyncHost, type PointerHostDriver, type PointerQueryResult } from './pointerSyncHost';
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
function fixture(driver: PointerHostDriver<number>) {
  const subscriptions: { dispose(): void }[] = [];
  const position = { line: 0, isEqual(other: unknown) { return other === this; } };
  mocks.editor = { document: { uri: uri('/A/src.lean'), version: 1, isClosed: false, getText: () => 'source' }, selection: { active: position } };
  installPointerSyncHost({ subscriptions } as never, driver);
  return () => subscriptions.forEach(d => d.dispose());
}
const summary = () => ({ pointers: 1, files: 1, unresolved: 0, details: [] });
beforeEach(() => { mocks.root = '/A'; mocks.watchers = []; mocks.commands.clear(); mocks.execute.mockClear(); });
describe('Pointer host invalidation races', () => {
  it('manual maintenance invalidates a reverse query already resolving against an older generation', async () => {
    const started = deferred<void>(), result = deferred<PointerQueryResult>(); let builds = 0;
    const dispose = fixture({ build: async () => ++builds, publish: async () => {}, files: () => ['src.lean'], summary,
      query: async () => { started.resolve(); return result.promise; } });
    try {
      const navigation = mocks.commands.get('snlDoc.revealNearestEntry')!(); await started.promise;
      await mocks.commands.get('snlDoc.maintainPointers')!();
      result.resolve({ complete: true, candidates: [{ entryId: 'OLD', startLine: 1, endLine: 1, distance: 0 }] });
      await navigation;
      expect(builds).toBe(2); expect(mocks.execute).not.toHaveBeenCalled();
    } finally { dispose(); }
  });
  it('serializes same-root publication across A → B → A lifetimes and ignores old source watchers', async () => {
    const firstStarted = deferred<void>(), releaseFirst = deferred<void>(), secondBuilt = deferred<void>();
    let builds = 0; const writes: number[] = [];
    const dispose = fixture({
      build: async () => { const value = ++builds; if (value === 2) secondBuilt.resolve(); return value; },
      publish: async (_root, index) => { if (index === 1) { firstStarted.resolve(); await releaseFirst.promise; } writes.push(index); },
      files: index => [index === 1 ? 'old/src.lean' : 'new/src.lean'], summary, query: async () => ({ complete: true, candidates: [] }),
    });
    try {
      const first = mocks.commands.get('snlDoc.maintainPointers')!(); await firstStarted.promise;
      mocks.root = '/B'; mocks.changed(); mocks.root = '/A'; mocks.changed();
      const latest = mocks.commands.get('snlDoc.maintainPointers')!(); await secondBuilt.promise;
      // Let an unsynchronized new publication finish before the old one resumes.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      releaseFirst.resolve(); await Promise.all([first, latest]);
      expect(writes).toEqual([1, 2]);
      expect(mocks.watchers.filter(w => w.pattern === '*' && !w.disposed).map(w => w.base.fsPath)).toEqual(['/A/new']);
    } finally { releaseFirst.resolve(); dispose(); }
  });
});
