import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  groups: [] as Array<{ viewColumn: number; tabs: Array<{ input: unknown; isActive: boolean }> }>,
  showCalls: [] as Array<{ document: unknown; options: Record<string, unknown> }>
}));

vi.mock('vscode', () => {
  class Position {
    constructor(public readonly line: number, public readonly character: number) {}
  }
  class Selection {
    constructor(public readonly anchor: Position, public readonly active: Position) {}
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
        lineCount: 4,
        lineAt: (line: number) => ({ range: { end: new Position(line, line === 2 ? 9 : 4) } })
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
        return { document };
      })
    }
  };
});

import * as vscode from 'vscode';
import { revealResolvedPointer } from './pointer';

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
