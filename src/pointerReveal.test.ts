import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const state = vi.hoisted(() => ({
  groups: [] as Array<{ viewColumn: number; tabs: Array<{ input: unknown; isActive: boolean }> }>,
  showCalls: [] as Array<{ document: unknown; options: Record<string, unknown> }>,
  editors: [] as Array<{ selection: vscode.Selection }>,
  sourceText: 'xxxx\nxxxx\nxxxxxxxxx\nxxxx'
}));

vi.mock('vscode', () => {
  class Position {
    constructor(public readonly line: number, public readonly character: number) {}
  }
  class Selection {
    readonly start: Position;
    readonly end: Position;
    constructor(public readonly anchor: Position, public readonly active: Position) {
      const reversed = anchor.line > active.line ||
        (anchor.line === active.line && anchor.character > active.character);
      this.start = reversed ? active : anchor;
      this.end = reversed ? anchor : active;
    }
  }
  class TabInputText {
    constructor(public readonly uri: { toString(): string }) {}
  }
  const makeUri = (absolutePath: string) => ({
    fsPath: absolutePath,
    toString: () => `file://${absolutePath}`
  });
  return {
    Position,
    Selection,
    TabInputText,
    Uri: { file: makeUri },
    ViewColumn: { One: 1 },
    workspace: {
      openTextDocument: vi.fn(async (uri: { toString(): string }) => ({
        uri,
        lineCount: state.sourceText.split(/\r\n|\r|\n/).length,
        lineAt: (line: number) => ({ range: { end: new Position(line, state.sourceText.split(/\r\n|\r|\n/)[line].length) } })
      }))
    },
    window: {
      tabGroups: { get all() { return state.groups; } },
      showTextDocument: vi.fn(async (document: { uri: { toString(): string } }, options: Record<string, unknown>) => {
        state.showCalls.push({ document, options });
        const column = options.viewColumn as number | undefined;
        const group = column === undefined
          ? state.groups[0]
          : state.groups.find((candidate) => candidate.viewColumn === column);
        if (group && !group.tabs.some((tab) =>
          tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString()
        )) {
          group.tabs.push({ input: new TabInputText(document.uri), isActive: true });
        }
        // TextDocumentShowOptions.selection is a Range. Model the real
        // extHostTextEditors Range.from transport: anchor/active are lost.
        const range = options.selection as Selection;
        const editor = { document, selection: new Selection(range.start, range.end) };
        state.editors.push(editor as unknown as { selection: vscode.Selection });
        return editor;
      })
    }
  };
});

import * as vscode from 'vscode';
import { resolveEntryPointer, revealResolvedPointer, type EntryPointer } from './pointer';
import { buildPointerIndex, findNearestEntries } from './pointerSync';

const targetPath = '/workspace/source.lean';
const targetUri = vscode.Uri.file(targetPath);
const resolved = {
  status: 'ok' as const,
  absolutePath: targetPath,
  startLine: 2,
  endLine: 3
};

function textTab(uri: typeof targetUri, isActive: boolean) {
  return { input: new vscode.TabInputText(uri), isActive };
}

describe('pointer reveal tab policy', () => {
  beforeEach(() => {
    state.groups = [];
    state.showCalls = [];
    state.editors = [];
    state.sourceText = 'xxxx\nxxxx\nxxxxxxxxx\nxxxx';
    vi.clearAllMocks();
  });

  it.each([
    ['visible', true],
    ['hidden', false]
  ])('reuses the same-URI %s tab without creating a duplicate', async (_visibility, isActive) => {
    state.groups = [
      { viewColumn: 1, tabs: [] },
      { viewColumn: 2, tabs: [textTab(targetUri, isActive)] }
    ];

    await revealResolvedPointer(resolved);

    const matchingTabs = state.groups.flatMap((group) => group.tabs).filter((tab) =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === targetUri.toString()
    );
    expect(matchingTabs).toHaveLength(1);
  });

  it('keeps an existing same-URI tab in its current editor group', async () => {
    state.groups = [
      { viewColumn: 1, tabs: [] },
      { viewColumn: 2, tabs: [textTab(targetUri, false)] }
    ];

    await revealResolvedPointer(resolved);

    expect(state.showCalls[0]?.options).toMatchObject({ viewColumn: 2 });
    expect(state.groups[1].tabs).toHaveLength(1);
    expect(state.groups[0].tabs).toHaveLength(0);
  });

  it('opens an absent file in the leftmost editor group', async () => {
    state.groups = [
      { viewColumn: 1, tabs: [] },
      { viewColumn: 2, tabs: [] }
    ];

    await revealResolvedPointer(resolved);

    expect(state.showCalls[0]?.options).toMatchObject({ viewColumn: vscode.ViewColumn.One });
  });

  it('preserves pointer selection, reveal, preview, and focus options', async () => {
    state.groups = [{ viewColumn: 1, tabs: [] }];

    await revealResolvedPointer(resolved);

    expect(state.showCalls[0]?.options).toEqual({
      viewColumn: vscode.ViewColumn.One,
      selection: new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 9)),
      preserveFocus: false,
      preview: false
    });
  });
});

describe('public source reveal → active caret → inverse lookup', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-reveal-caret-'));
    state.groups = [];
    state.showCalls = [];
    state.editors = [];
    vi.clearAllMocks();
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('round-trips an exact multiline half-open source range', async () => {
    state.sourceText = 'prefix\n  def image :=\n    target suffix\nnext';
    await fs.writeFile(path.join(root, 'source.lean'), state.sourceText);
    const pointer = { file: 'source.lean', mode: 'lines' as const,
      line: 2, column: 3, endLine: 3, endColumn: 11 };
    const index = await buildPointerIndex(root, [{ id: 'Set.image', pointer }]);
    const forward = await resolveEntryPointer(vscode.Uri.file(root), pointer);
    expect(forward.status).toBe('ok');
    await revealResolvedPointer(forward);

    const selection = state.editors[0].selection;
    expect(findNearestEntries(index, pointer.file,
      selection.active.line + 1, selection.active.character + 1).candidates.map(c => c.entryId))
      .toEqual(['Set.image']);
    expect(selection.start).toEqual(new vscode.Position(1, 2));
    expect(selection.end).toEqual(new vscode.Position(2, 10));
    expect(selection.active).toEqual(selection.start);
    expect(selection.anchor).toEqual(selection.end);
    expect(findNearestEntries(index, pointer.file, 3, 11).candidates).toEqual([]);
  });

  describe.each([['LF', '\n'], ['CRLF', '\r\n']])('%s boundaries', (_name, eol) => {
    const fixtures: Array<{
      name: string; text: string; pointer: EntryPointer;
      start: [number, number]; end: [number, number]; selected: string;
    }> = [
      { name: 'multiline explicit columns', text: `pre${eol}  目标😀${eol}body tail`,
        pointer: { file: 'source.lean', mode: 'lines', line: 2, column: 3, endLine: 3, endColumn: 5 },
        start: [1, 2], end: [2, 4], selected: `目标😀${eol}body` },
      { name: 'single-line explicit columns', text: `pre${eol}  目标😀 tail`,
        pointer: { file: 'source.lean', mode: 'lines', line: 2, column: 3, endLine: 2, endColumn: 7 },
        start: [1, 2], end: [1, 6], selected: '目标😀' },
      { name: 'multiline regex', text: `pre${eol}  目标😀${eol}body tail`,
        pointer: { file: 'source.lean', mode: 'regex', pattern: '目标😀\\r?\\nbody' },
        start: [1, 2], end: [2, 4], selected: `目标😀${eol}body` },
      { name: 'single-line regex', text: `pre${eol}  目标😀 tail`,
        pointer: { file: 'source.lean', mode: 'regex', pattern: '目标😀' },
        start: [1, 2], end: [1, 6], selected: '目标😀' },
      { name: 'regex ending at next line start', text: `pre${eol}  目标😀${eol}next`,
        pointer: { file: 'source.lean', mode: 'regex', pattern: '目标😀\\r?\\n' },
        start: [1, 2], end: [2, 0], selected: `目标😀${eol}` },
      { name: 'empty explicit range', text: `pre${eol}  target`,
        pointer: { file: 'source.lean', mode: 'lines', line: 2, column: 3, endLine: 2, endColumn: 3 },
        start: [1, 2], end: [1, 2], selected: '' },
      { name: 'zero-width regex', text: `pre${eol}  target`,
        pointer: { file: 'source.lean', mode: 'regex', pattern: '(?=target)' },
        start: [1, 2], end: [1, 2], selected: '' },
      { name: 'zero-width regex at empty EOF line', text: `pre${eol}`,
        pointer: { file: 'source.lean', mode: 'regex', pattern: '(?![\\s\\S])' },
        start: [1, 0], end: [1, 0], selected: '' },
      { name: 'empty file', text: '',
        pointer: { file: 'source.lean', mode: 'lines', line: 1, column: 1, endColumn: 1 },
        start: [0, 0], end: [0, 0], selected: '' }
    ];
    it.each(fixtures)('$name retains the full source range and queries its active caret', async fixture => {
      state.sourceText = fixture.text;
      await fs.writeFile(path.join(root, 'source.lean'), fixture.text);
      const pointer = { ...fixture.pointer };
      const index = await buildPointerIndex(root, [{ id: 'target', pointer }]);
      const forward = await resolveEntryPointer(vscode.Uri.file(root), pointer);
      expect(forward.status).toBe('ok');
      await revealResolvedPointer(forward);
      const selection = state.editors[0].selection;
      const query = (position: vscode.Position) => findNearestEntries(index, pointer.file,
        position.line + 1, position.character + 1).candidates.map(c => c.entryId);
      expect(query(selection.active)).toEqual(['target']);
      expect(selection.start).toEqual(new vscode.Position(...fixture.start));
      expect(selection.end).toEqual(new vscode.Position(...fixture.end));
      expect(selection.active).toEqual(selection.start);
      expect(selection.anchor).toEqual(selection.end);
      const offset = (position: vscode.Position) => fixture.text.split(eol).slice(0, position.line)
        .reduce((total, line) => total + line.length + eol.length, 0) + position.character;
      expect(fixture.text.slice(offset(selection.start), offset(selection.end))).toBe(fixture.selected);

      // Ordinary user-selected forward ranges still query the active end:
      // exclude nonempty half-open ends; zero-width points include only themselves.
      const userSelection = new vscode.Selection(selection.start, selection.end);
      expect(query(userSelection.active)).toEqual(fixture.selected ? [] : ['target']);
      expect(query(new vscode.Position(selection.end.line, selection.end.character + 1))).toEqual([]);
      if (selection.start.character > 0) {
        expect(query(new vscode.Position(selection.start.line, selection.start.character - 1))).toEqual([]);
      }
    });
  });
});
