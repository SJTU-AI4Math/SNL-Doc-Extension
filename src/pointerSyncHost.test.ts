import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  commands: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  execute: vi.fn(async (..._args: unknown[]) => undefined),
  info: vi.fn(async (..._args: unknown[]) => undefined),
  warn: vi.fn(),
  pick: vi.fn(async (items: { candidate: unknown }[]) => items[0]),
  editor: undefined as unknown,
  watchers: [] as Array<(uri: unknown) => void>,
}));
const uri = (p: string) => ({ fsPath: p, path: p, scheme: 'file', toString: () => `file://${p}` });
vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri([base.fsPath, ...parts].join('/')) },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  ProgressLocation: { Notification: 15 },
  commands: {
    registerCommand: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => {
      mocks.commands.set(name, callback); return { dispose() { mocks.commands.delete(name); } };
    }, executeCommand: mocks.execute,
  },
  workspace: {
    fs: { stat: async () => { throw Error('no automatic initial build in fixture'); } },
    getWorkspaceFolder: () => ({ uri: uri('/ws') }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({
      onDidCreate: (fn: (u: unknown) => void) => { mocks.watchers.push(fn); return { dispose() {} }; },
      onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {},
    }),
  },
  window: {
    get activeTextEditor() { return mocks.editor; },
    onDidChangeWindowState: () => ({ dispose() {} }),
    showWarningMessage: mocks.warn, showInformationMessage: mocks.info,
    showQuickPick: mocks.pick,
    withProgress: async (_options: unknown, task: (p: { report(): void }) => Promise<unknown>) => task({ report() {} }),
    createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
  },
}));
vi.mock('./panelUtil', () => ({ firstWorkspaceFolder: () => uri('/ws') }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
import { installPointerSyncHost, type PointerHostDriver } from './pointerSyncHost';
import { notifyPointerEntriesWritten } from './pointerSyncHostState';

function fixture() {
  const position = { line: 19, character: 0, isEqual(other: unknown) { return other === this; } };
  const editor = { document: { uri: uri('/ws/Example.lean'), version: 1, isClosed: false, getText: () => 'dirty text' }, selection: { active: position } };
  mocks.editor = editor;
  const subscriptions: { dispose(): void }[] = [];
  const driver: PointerHostDriver<number> = {
    build: vi.fn(async () => 1), publish: vi.fn(async () => {}),
    query: vi.fn(async () => ({ complete: true, candidates: [{ entryId: 'Target', package: 'P', startLine: 20, endLine: 21, distance: 0 }] })),
    files: () => ['Example.lean'], summary: () => ({ files: 1, pointers: 1, unresolved: 0, details: [] }),
  };
  installPointerSyncHost({ subscriptions } as never, driver);
  return { editor, driver, dispose: () => subscriptions.forEach(d => d.dispose()) };
}
beforeEach(() => { vi.clearAllMocks(); mocks.commands.clear(); mocks.watchers = []; });
describe('Pointer host command behavior', () => {
  it('opens the existing Entry Infoview command with a current-buffer query and warm metadata cache', async () => {
    const f = fixture();
    try {
      expect(await mocks.commands.get('snlDoc.revealNearestEntry')!()).toBe('Target');
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(f.driver.query).toHaveBeenCalledWith(expect.anything(), 1, 'Example.lean', 20, 'dirty text', 1);
      expect(f.driver.build).toHaveBeenCalledTimes(1);
      expect(mocks.execute).toHaveBeenCalledWith('snlDoc.openEntryInfoview', 'Target', undefined, 'P');
    } finally { f.dispose(); }
  });
  it.each(['snlDoc.revealNearestEntry', 'snlDoc.maintainPointers'])('reports every explicit failure of %s rather than suppressing retries', async command => {
    const f = fixture();
    try {
      vi.mocked(f.driver.build).mockRejectedValue(new Error('Invalid Pointer index'));
      await mocks.commands.get(command)!();
      await mocks.commands.get(command)!();
      expect(mocks.warn).toHaveBeenCalledTimes(2);
      expect(mocks.warn).toHaveBeenLastCalledWith(expect.stringContaining('Invalid Pointer index'));
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('reports no match without replacing the current panel', async () => {
    const f = fixture();
    try {
      vi.mocked(f.driver.query).mockResolvedValue({ complete: true, candidates: [] });
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('No Entry'));
    } finally { f.dispose(); }
  });
  it('requires an explicit pick even for a single incomplete candidate', async () => {
    const f = fixture();
    try {
      vi.mocked(f.driver.query).mockResolvedValue({ complete: false, candidates: [{ entryId: 'Known', startLine: 1, endLine: 1, distance: 1 }] });
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(mocks.pick).toHaveBeenCalledTimes(1);
    } finally { f.dispose(); }
  });
  it('does not open an Entry for a late query after an edit', async () => {
    const f = fixture();
    try {
      vi.mocked(f.driver.query).mockImplementation(async () => {
        f.editor.document.version++;
        return { complete: true, candidates: [{ entryId: 'Old', startLine: 1, endLine: 1, distance: 0 }] };
      });
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('discards a late query after a same-line column move', async () => {
    const f=fixture();
    try {
      vi.mocked(f.driver.query).mockImplementation(async () => {
        const old=f.editor.selection.active;
        f.editor.selection.active={...old,character:old.character+1,isEqual:()=>false};
        return {complete:true,candidates:[{entryId:'Old',startLine:1,endLine:1,distance:0}]};
      });
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('rejects an editor outside the supported root', async () => {
    const f = fixture();
    try {
      f.editor.document.uri = uri('/other/Example.lean');
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(f.driver.build).not.toHaveBeenCalled(); expect(mocks.warn).toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('awaits write-side refresh and provides maintenance counts', async () => {
    const f = fixture();
    try {
      await notifyPointerEntriesWritten('file:///ws');
      expect(f.driver.publish).toHaveBeenCalledTimes(1);
      expect(await mocks.commands.get('snlDoc.maintainPointers')!()).toEqual({ files: 1, pointers: 1, unresolved: 0 });
      expect(f.driver.build).toHaveBeenCalledTimes(2);
    } finally { f.dispose(); }
  });
});
