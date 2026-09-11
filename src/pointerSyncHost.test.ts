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
  it('does not rebuild on global or Library cache writes but still reacts to authored metadata', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      for (const file of ['.SNL_Doc/.cache/pointer-inverse/result.json', '.SNL_Doc/libraries/lib/.cache/graph-layout/result.json'])
        for (const changed of mocks.watchers) changed(uri('/ws/' + file));
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.driver.build).toHaveBeenCalledTimes(1);
      for (const changed of mocks.watchers) changed(uri('/ws/.SNL_Doc/entries/entry.json'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.driver.build).toHaveBeenCalledTimes(2);
    } finally { f.dispose(); vi.useRealTimers(); }
  });
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
  it.each([true, false])('opens a single known candidate without QuickPick (complete=%s)', async complete => {
    const f = fixture();
    try {
      vi.mocked(f.driver.query).mockResolvedValue({ complete, candidates: [{ entryId: 'Known', startLine: 1, endLine: 1, distance: 0 }] });
      expect(await mocks.commands.get('snlDoc.revealNearestEntry')!()).toBe('Known');
      expect(mocks.execute).toHaveBeenCalledWith('snlDoc.openEntryInfoview', 'Known', undefined, undefined);
      expect(mocks.pick).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it.each([true, false])('opens deterministic identity from shuffled known ties (complete=%s)', async complete => {
    const f = fixture();
    try {
      const candidates = [
        { entryId: 'ä', package: '', title: 'A' },
        { entryId: 'Z', package: 'ä', title: 'B' },
        { entryId: 'Z', package: 'Z', title: 'C' },
        { entryId: 'Z', title: 'ZZZ' },
      ].map((identity, i) => ({ ...identity, startLine: i + 1, endLine: i + 1, distance: i }));
      for (const input of [candidates, [...candidates].reverse()]) {
        vi.mocked(f.driver.query).mockResolvedValue({ complete, candidates: input });
        const before = [...input];
        expect(await mocks.commands.get('snlDoc.revealNearestEntry')!()).toBe('Z');
        expect(mocks.execute).toHaveBeenLastCalledWith('snlDoc.openEntryInfoview', 'Z', undefined, undefined);
        expect(input).toEqual(before);
      }
      expect(mocks.pick).not.toHaveBeenCalled();
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('retains incomplete feedback when no known candidate exists', async () => {
    const f = fixture();
    try {
      vi.mocked(f.driver.query).mockResolvedValue({ complete: false, candidates: [] });
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(mocks.info).toHaveBeenCalledWith(expect.stringContaining('Results are incomplete'));
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.pick).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it.each([true, false])('does not open an Entry for a late query after an edit (complete=%s)', async complete => {
    const f = fixture();
    try {
      vi.mocked(f.driver.query).mockImplementation(async () => {
        f.editor.document.version++;
        return { complete, candidates: [{ entryId: 'Old', startLine: 1, endLine: 1, distance: 0 }] };
      });
      await mocks.commands.get('snlDoc.revealNearestEntry')!();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it.each([true, false])('discards a late query after a same-line column move (complete=%s)', async complete => {
    const f=fixture();
    try {
      vi.mocked(f.driver.query).mockImplementation(async () => {
        const old=f.editor.selection.active;
        f.editor.selection.active={...old,character:old.character+1,isEqual:()=>false};
        return {complete,candidates:[{entryId:'Old',startLine:1,endLine:1,distance:0}]};
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
