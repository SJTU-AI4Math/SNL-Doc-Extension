import { describe, expect, it } from 'vitest';
import {
  chooseEntryReturn,
  groupEntryRelationships,
  parseEntryReturnRoute
} from './entryInfoviewRelationships';

const entries = new Map([
  ['a', { id: 'a', title: 'Alpha', kind: 'definition', package: 'logic' }],
  ['b', { id: 'b', title: 'Beta', kind: 'theorem', package: 'logic' }],
  ['c', { id: 'c', title: 'Gamma', kind: 'lemma', package: 'other' }]
]);

describe('single Entry relationship sections', () => {
  it('groups every label and direction deterministically', () => {
    const sections = groupEntryRelationships('b', [
      { id: '4', from: 'b', to: 'c', label: 'uses_context', metadata: null },
      { id: '2', from: 'a', to: 'b', label: 'depends', metadata: { rank: 1 } },
      { id: '3', from: 'b', to: 'a', label: 'depends', metadata: null },
      { id: '1', from: 'c', to: 'b', label: 'cites', metadata: null }
    ], entries);

    expect(sections.map(({ label, direction }) => [label, direction])).toEqual([
      ['cites', 'incoming'],
      ['depends', 'incoming'],
      ['depends', 'outgoing'],
      ['uses_context', 'outgoing']
    ]);
    expect(sections[0].rows[0]).toMatchObject({ id: 'c', package: 'other', relationshipId: '1' });
    expect(sections[2].rows[0]).toMatchObject({ id: 'a', relationshipId: '3' });
  });

  it('keeps parallel relationships and skips only dangling counterparts', () => {
    const sections = groupEntryRelationships('a', [
      { id: 'r1', from: 'a', to: 'b', label: 'related', metadata: null },
      { id: 'r2', from: 'a', to: 'b', label: 'related', metadata: null },
      { id: 'r3', from: 'a', to: 'missing', label: 'related', metadata: null }
    ], entries);
    expect(sections).toHaveLength(1);
    expect(sections[0].rows.map((row) => row.relationshipId)).toEqual(['r1', 'r2']);
  });
});

describe('single Entry return fallback', () => {
  it('returns root, one library, or a deterministic chooser', () => {
    expect(chooseEntryReturn([])).toEqual({ kind: 'root' });
    expect(chooseEntryReturn([{ slug: 'one', title: 'One' }])).toEqual({
      kind: 'library', slug: 'one', title: 'One'
    });
    expect(chooseEntryReturn([
      { slug: 'z', title: 'Zulu' },
      { slug: 'a', title: 'Alpha' }
    ])).toEqual({
      kind: 'chooseLibrary', libraries: [
        { slug: 'a', title: 'Alpha' },
        { slug: 'z', title: 'Zulu' }
      ]
    });
  });

  it('accepts only normalized command-origin routes', () => {
    expect(parseEntryReturnRoute({ kind: 'library', slug: ' logic ', title: 'Logic' }))
      .toEqual({ kind: 'library', slug: 'logic', title: 'Logic' });
    expect(parseEntryReturnRoute({
      kind: 'entry', entryId: ' theorem ', entryPackage: 'pkg'
    })).toEqual({ kind: 'entry', entryId: 'theorem', entryPackage: 'pkg' });
    expect(parseEntryReturnRoute({ kind: 'library', slug: '' })).toBeUndefined();
    expect(parseEntryReturnRoute({ kind: 'chooseLibrary', libraries: 'not-an-array' }))
      .toBeUndefined();
  });
});
