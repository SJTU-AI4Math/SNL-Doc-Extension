import { describe, expect, it } from 'vitest';
import {
  createSnooglSearchDocument,
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
});
