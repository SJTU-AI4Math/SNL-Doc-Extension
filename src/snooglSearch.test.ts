import { describe, expect, it } from 'vitest';
import {
  createSnooglSearchDocument,
  expandSnooglToken,
  rankSnooglCandidates,
  rankSnooglDocuments,
  SnooglSearchIndex,
  type SnooglSearchDocument
} from './snooglSearch';

interface Item {
  id: string;
}

function doc(
  id: string,
  fields: Partial<SnooglSearchDocument<Item>['fields']>
): SnooglSearchDocument<Item> {
  return {
    id,
    value: { id },
    fields: {
      primary: fields.primary ?? [],
      secondary: fields.secondary ?? [],
      tertiary: fields.tertiary ?? []
    }
  };
}

describe('rankSnooglDocuments', () => {
  it('supports one reusable index across successive queries', () => {
    const index = new SnooglSearchIndex([
      createSnooglSearchDocument({
        id: 'FOL.forall',
        value: { id: 'FOL.forall' },
        labels: ['quantifier']
      }),
      createSnooglSearchDocument({
        id: 'Add.add',
        value: { id: 'Add.add' }
      })
    ]);

    expect(index.search('quantifier').map((result) => result.value.id))
      .toEqual(['FOL.forall']);
    expect(index.search('add')[0]?.value.id).toBe('Add.add');
  });

  it('offers a reusable candidate wrapper for UI search surfaces', () => {
    const ranked = rankSnooglCandidates('quantifier forall', [
      { id: 'FOL.forall', labels: ['quantifier'] },
      { id: 'Other.forall', labels: [] }
    ]);

    expect(ranked.map((candidate) => candidate.id)).toEqual(['FOL.forall']);
  });

  it('builds reusable namespace-tail, labels, and namespace-middle fields', () => {
    const document = createSnooglSearchDocument({
      id: 'Lean.FOL.forall',
      value: { id: 'Lean.FOL.forall' },
      labels: ['quantifier']
    });

    expect(document.fields).toEqual({
      primary: ['forall'],
      secondary: ['quantifier'],
      tertiary: ['Lean', 'FOL']
    });
  });

  it('uses soft field preferences so a perfect secondary match can beat a poor primary match', () => {
    const ranked = rankSnooglDocuments('forall', [
      doc('poor-tail', { primary: ['forxallx'] }),
      doc('perfect-tag', { secondary: ['forall'] })
    ]);

    expect(ranked.map((result) => result.value.id)).toEqual([
      'perfect-tag',
      'poor-tail'
    ]);
  });

  it('prefers primary over secondary when match quality is equal', () => {
    const ranked = rankSnooglDocuments('forall', [
      doc('tag', { secondary: ['forall'] }),
      doc('tail', { primary: ['forall'] })
    ]);

    expect(ranked.map((result) => result.value.id)).toEqual(['tail', 'tag']);
  });

  it('splits whitespace into independent token spaces and requires every token to match', () => {
    const ranked = rankSnooglDocuments('  xyz   forall  ', [
      doc('complete', {
        primary: ['forall'],
        tertiary: ['xyz']
      }),
      doc('missing-xyz', {
        primary: ['forall']
      }),
      doc('tags-only', {
        secondary: ['xyz', 'forall']
      })
    ]);

    expect(ranked.map((result) => result.value.id)).toEqual([
      'tags-only',
      'complete'
    ]);
    expect(ranked[0].tokenScores).toHaveLength(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('returns an empty query as a stable id-sorted catalog', () => {
    const ranked = rankSnooglDocuments('', [
      doc('zeta', {}),
      doc('alpha', {})
    ]);

    expect(ranked.map((result) => result.value.id)).toEqual(['alpha', 'zeta']);
    expect(ranked.every((result) => result.score === 0)).toBe(true);
  });

  it('ranks a fully-typed dotted id first instead of burying it', () => {
    // Cat 2026-07-25: typing `to` found `Type.to`, but typing the full
    // `Type.to` pushed it far down — a dotted query was matched as one
    // opaque string against fields that are already namespace-split, so
    // every `Type.*` scored identically.
    const ids = ['Type.to', 'Type.toFun', 'Type.tot', 'Type.of', 'Nat.to', 'Foo.total'];
    const index = new SnooglSearchIndex(
      ids.map((id) => createSnooglSearchDocument({ id, value: id }))
    );

    expect(index.search('Type.to')[0]?.value).toBe('Type.to');
    // A dotted query must behave like the equivalent space-separated one.
    expect(index.search('Type.to').map((r) => r.value))
      .toEqual(index.search('Type to').map((r) => r.value));
    // The namespace part is a real constraint, not decoration.
    expect(index.search('Type.to').map((r) => r.value)).not.toContain('Nat.to');
  });

  it('prefers a whole-field match over a longer field it merely prefixes', () => {
    const index = new SnooglSearchIndex(
      ['Type.toFun', 'Type.tot', 'Type.to'].map((id) =>
        createSnooglSearchDocument({ id, value: id })
      )
    );
    const ranked = index.search('to').map((result) => result.value);
    expect(ranked[0]).toBe('Type.to');
    expect(ranked.indexOf('Type.tot')).toBeLessThan(ranked.indexOf('Type.toFun'));
  });

  it('still finds a Macro by its tail alone', () => {
    const index = new SnooglSearchIndex(
      ['Type.to', 'Other.thing'].map((id) => createSnooglSearchDocument({ id, value: id }))
    );
    expect(index.search('to')[0]?.value).toBe('Type.to');
  });

  it('splits a dotted token into tail and namespace probes', () => {
    expect(expandSnooglToken('Type.to')).toEqual([
      { text: 'to', tiers: ['primary', 'secondary'] },
      { text: 'Type', tiers: ['tertiary'] }
    ]);
    expect(expandSnooglToken('to')).toEqual([
      { text: 'to', tiers: ['primary', 'secondary', 'tertiary'] }
    ]);
    // A trailing dot is just a namespace prefix, not an empty tail.
    expect(expandSnooglToken('Type.')).toEqual([
      { text: 'Type', tiers: ['primary', 'secondary', 'tertiary'] }
    ]);
  });

  it('scores each dotted segment against its own tier only', () => {
    // 'Alpha' must be read as a namespace constraint, never as a tail match.
    const index = new SnooglSearchIndex([
      doc('Beta.Alpha', { primary: ['Alpha'], tertiary: ['Beta'] }),
      doc('Alpha.thing', { primary: ['thing'], tertiary: ['Alpha'] })
    ]);
    const ranked = index.search('Alpha.thing').map((result) => result.value.id);
    expect(ranked).toEqual(['Alpha.thing']);
  });

  it('requires every segment of a dotted token to match', () => {
    const index = new SnooglSearchIndex([
      doc('Right.tail', { primary: ['tail'], tertiary: ['Right'] }),
      doc('tail', { primary: ['tail'], tertiary: [] })
    ]);
    // The bare 'tail' document has no namespace, so it cannot satisfy the
    // 'Right' half and must be excluded rather than scored on the tail alone.
    expect(index.search('Right.tail').map((result) => result.value.id))
      .toEqual(['Right.tail']);
  });

  it('does not let a namespace probe satisfy itself against a tail', () => {
    // 'Alpha' is the namespace half of the query. A document whose TAIL is
    // 'Alpha' must not use that tail to satisfy the namespace requirement.
    const index = new SnooglSearchIndex([
      doc('thing.Alpha', { primary: ['Alpha'], tertiary: ['thing'] })
    ]);
    expect(index.search('Alpha.thing')).toEqual([]);
  });
});
