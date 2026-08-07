import { describe, expect, it } from 'vitest';
import { wrapRawLibraryGraphNodeWithParent } from './libraryGraph';

describe('wrapRawLibraryGraphNodeWithParent', () => {
  it('preserves unknown envelope, node, relationship, and malformed records', () => {
    const raw = {
      version: 2,
      extension: { keep: true },
      nodes: [
        { id: 'root', label: 'Entry', props: {}, extra: 7 },
        { id: 'target', label: 'Entry', props: { entryId: 'old' } },
        'malformed'
      ],
      relationships: [
        { from: 'root', to: 'target', label: 'branch', properties: { order: 1 } },
        { from: 'target', to: 'root', label: 'custom', extra: true },
        9
      ]
    };
    const parent = { id: 'parent', label: 'Entry', props: { entryId: 'new' } };

    const result = wrapRawLibraryGraphNodeWithParent(raw, 'target', parent);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.extension).toEqual({ keep: true });
    expect(result.value.nodes).toEqual([
      { id: 'root', label: 'Entry', props: {}, extra: 7 },
      parent,
      { id: 'target', label: 'Entry', props: { entryId: 'old' } },
      'malformed'
    ]);
    expect(result.value.relationships).toEqual([
      { from: 'root', to: 'parent', label: 'branch', properties: { order: 1 } },
      { from: 'parent', to: 'target', label: 'branch' },
      { from: 'target', to: 'root', label: 'custom', extra: true },
      9
    ]);
  });

  it('fails closed for missing targets, duplicate ids, and multiple branch parents', () => {
    const graph = {
      nodes: [
        { id: 'x', label: 'Entry', props: {} },
        { id: 'y', label: 'Entry', props: {} },
        { id: 'target', label: 'Entry', props: {} }
      ],
      relationships: [
        { from: 'x', to: 'target', label: 'branch' },
        { from: 'y', to: 'target', label: 'branch' }
      ]
    };
    expect(wrapRawLibraryGraphNodeWithParent(
      graph,
      'missing',
      { id: 'parent', label: 'Entry', props: {} }
    )).toEqual({ ok: false, reason: 'notFound' });
    expect(wrapRawLibraryGraphNodeWithParent(
      graph,
      'target',
      { id: 'x', label: 'Entry', props: {} }
    )).toEqual({ ok: false, reason: 'invalid' });
    expect(wrapRawLibraryGraphNodeWithParent(
      graph,
      'target',
      { id: 'parent', label: 'Entry', props: {} }
    )).toEqual({ ok: false, reason: 'malformed' });
    expect(graph.nodes.map((node) => node.id)).toEqual(['x', 'y', 'target']);
  });

  it('fails closed without rewriting ignored malformed or dangling incoming edges', () => {
    for (const relationship of [
      { label: 'branch', to: 'target', extension: 'missing-from' },
      { from: 'missing', label: 'branch', to: 'target', extension: 'dangling-from' },
      { from: 'target', label: 'branch', to: 'target', extension: 'self-loop' }
    ]) {
      const raw = {
        keep: true,
        nodes: [{ id: 'target', label: 'Entry', props: {}, extension: 'node' }],
        relationships: [relationship]
      };
      const before = JSON.stringify(raw);
      expect(wrapRawLibraryGraphNodeWithParent(
        raw,
        'target',
        { id: 'parent', label: 'Entry', props: {} }
      )).toEqual({ ok: false, reason: 'malformed' });
      expect(JSON.stringify(raw)).toBe(before);
    }
  });
});
