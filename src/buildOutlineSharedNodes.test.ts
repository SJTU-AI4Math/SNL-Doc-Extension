import { describe, expect, it, vi } from 'vitest';

// `infoviewPanel.ts` imports `vscode` at module scope, but `buildOutline` is
// pure graph->tree logic that touches none of it.
vi.mock('vscode', () => ({
  window: {},
  workspace: {},
  Uri: { joinPath: () => ({}), file: () => ({}) },
  ViewColumn: { One: 1 },
  EventEmitter: class {}
}));

import { buildOutline } from './infoviewPanel';
import type { EntryData, EntryKind } from './snlDoc';
import type { LibraryGraph } from './libraryGraph';

const entry = (id: string): EntryData =>
  ({ id, title: id, kind: 'k', content: { snl: '' } }) as unknown as EntryData;

/** Build the argument bundle `buildOutline` takes, with sane empty defaults. */
function callBuildOutline(graph: LibraryGraph, entryIds: string[] = []) {
  const entriesById = new Map<string, EntryData>(
    entryIds.map((id) => [id, entry(id)])
  );
  const warnings: string[] = [];
  const outline = buildOutline(
    graph,
    entriesById,
    new Map<string, EntryKind>(),
    new Map(),
    new Map(),
    [],
    warnings
  );
  return { outline, warnings };
}

/** Every nodeId in the tree, in DFS order. */
function ids(nodes: ReturnType<typeof callBuildOutline>['outline']): string[] {
  const acc: string[] = [];
  const walk = (list: typeof nodes): void => {
    for (const n of list) {
      acc.push(n.nodeId);
      walk(n.children);
    }
  };
  walk(nodes);
  return acc;
}

describe('buildOutline: every graph node reaches the outline', () => {
  it('keeps a node that two parents both branch to', () => {
    // 猫猫 2026-07-29: "有时候索引条目显示不出来". A `visited` set shared across
    // the whole build means the SECOND parent to reach a shared child gets
    // `null` back and silently drops it — along with its entire subtree. It is
    // intermittent because it only bites when a node is reachable twice, and
    // which parent "wins" depends on nodes[] declaration order.
    const graph: LibraryGraph = {
      nodes: [
        { id: 'p1', label: 'Entry', props: { entryId: 'P1' } },
        { id: 'p2', label: 'Entry', props: { entryId: 'P2' } },
        { id: 'shared', label: 'Entry', props: { entryId: 'S' } }
      ],
      relationships: [
        { from: 'p1', to: 'shared', label: 'branch' },
        { from: 'p2', to: 'shared', label: 'branch' }
      ]
    } as unknown as LibraryGraph;

    const { outline } = callBuildOutline(graph, ['P1', 'P2', 'S']);

    // p2 is a root (its only parent link is as a source, never a target).
    const p2 = outline.find((n) => n.nodeId === 'p2');
    expect(p2).toBeDefined();
    // The shared child must appear under BOTH parents, not just the first.
    expect(p2!.children.map((c) => c.nodeId)).toContain('shared');
    const p1 = outline.find((n) => n.nodeId === 'p1');
    expect(p1!.children.map((c) => c.nodeId)).toContain('shared');
  });

  it('does not lose a shared node\'s subtree', () => {
    const graph: LibraryGraph = {
      nodes: [
        { id: 'p1', label: 'Entry', props: { entryId: 'P1' } },
        { id: 'p2', label: 'Entry', props: { entryId: 'P2' } },
        { id: 'shared', label: 'Entry', props: { entryId: 'S' } },
        { id: 'deep', label: 'Entry', props: { entryId: 'D' } }
      ],
      relationships: [
        { from: 'p1', to: 'shared', label: 'branch' },
        { from: 'p2', to: 'shared', label: 'branch' },
        { from: 'shared', to: 'deep', label: 'branch' }
      ]
    } as unknown as LibraryGraph;

    const { outline } = callBuildOutline(graph, ['P1', 'P2', 'S', 'D']);
    // 'deep' must be present under both copies of 'shared'.
    const under = (rootId: string): string[] => {
      const root = outline.find((n) => n.nodeId === rootId)!;
      const sh = root.children.find((c) => c.nodeId === 'shared');
      return sh ? sh.children.map((c) => c.nodeId) : [];
    };
    expect(under('p1')).toContain('deep');
    expect(under('p2')).toContain('deep');
  });

  it('still terminates on a cycle instead of recursing forever', () => {
    // The `visited` set existed to guard cycles; per-path tracking must keep
    // that property while allowing legitimate re-visits on sibling branches.
    const graph: LibraryGraph = {
      nodes: [
        { id: 'a', label: 'Entry', props: { entryId: 'A' } },
        { id: 'b', label: 'Entry', props: { entryId: 'B' } }
      ],
      relationships: [
        { from: 'a', to: 'b', label: 'branch' },
        { from: 'b', to: 'a', label: 'branch' }
      ]
    } as unknown as LibraryGraph;

    const { outline } = callBuildOutline(graph, ['A', 'B']);
    // Must not hang, and must not emit an infinitely deep tree.
    const all = ids(outline);
    expect(all.length).toBeLessThan(10);
  });

  it('indexes the graph once while numbering the whole outline', () => {
    let nodeWalks = 0;
    let relationshipWalks = 0;
    const counted = <T>(values: T[], walked: () => void): T[] => new Proxy(values, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) walked();
        return Reflect.get(target, property, receiver);
      }
    });
    const graph: LibraryGraph = {
      nodes: counted([
        { id: 'r', label: 'Entry', props: { entryId: 'R' } },
        { id: 'c1', label: 'Entry', props: { entryId: 'C1' } },
        { id: 'c2', label: 'Entry', props: { entryId: 'C2' } }
      ], () => { nodeWalks += 1; }),
      relationships: counted([
        { from: 'r', to: 'c1', label: 'branch' },
        { from: 'r', to: 'c2', label: 'branch' }
      ], () => { relationshipWalks += 1; })
    };
    const entriesById = new Map<string, EntryData>(
      ['R', 'C1', 'C2'].map((id) => [id, entry(id)])
    );
    const warnings: string[] = [];

    const outline = buildOutline(
      graph,
      entriesById,
      new Map(),
      new Map(['R', 'C1', 'C2'].map((id) => [id, { kind: 'k' }])),
      new Map([['k', { defaultCounterName: 'main' }]]),
      [{ id: 'counter', name: 'main', numbering: '1.', children: [] }],
      warnings
    );

    expect(ids(outline)).toEqual(['r', 'c1', 'c2']);
    expect({ nodeWalks, relationshipWalks }).toEqual({ nodeWalks: 4, relationshipWalks: 1 });
  });

  it('emits every Entry node exactly once when the graph is a plain tree', () => {
    const graph: LibraryGraph = {
      nodes: [
        { id: 'r', label: 'Entry', props: { entryId: 'R' } },
        { id: 'c1', label: 'Entry', props: { entryId: 'C1' } },
        { id: 'c2', label: 'Entry', props: { entryId: 'C2' } }
      ],
      relationships: [
        { from: 'r', to: 'c1', label: 'branch' },
        { from: 'r', to: 'c2', label: 'branch' }
      ]
    } as unknown as LibraryGraph;

    const { outline } = callBuildOutline(graph, ['R', 'C1', 'C2']);
    expect(ids(outline).sort()).toEqual(['c1', 'c2', 'r']);
  });
});
