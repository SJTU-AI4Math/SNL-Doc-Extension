import { describe, expect, it } from 'vitest';
import {
  REVERSE_EXCLUDED_LABELS,
  selectEntryRelationships,
  type EntryLike,
  type RelationshipLike
} from './entryRelationships';

const entries: EntryLike[] = [
  { id: 'me', title: 'Me', kind: 'theorem' },
  { id: 'a', title: 'Alpha', kind: 'definition' },
  { id: 'b', title: 'Beta', kind: 'lemma' },
  { id: 'c', title: 'Gamma', kind: 'lemma' }
];

const rel = (
  id: string,
  from: string,
  to: string,
  label: string
): RelationshipLike => ({ id, from, to, label });

describe('selectEntryRelationships', () => {
  it('keeps outgoing depends edges (this entry depends on X)', () => {
    const rows = selectEntryRelationships('me', [rel('r1', 'me', 'a', 'depends')], entries);
    expect(rows).toEqual([
      {
        id: 'r1',
        label: 'depends',
        direction: 'outgoing',
        otherId: 'a',
        otherTitle: 'Alpha',
        otherKindId: 'definition'
      }
    ]);
  });

  it('drops incoming depends edges (X depends on this entry)', () => {
    // `from` depends on `to` — verified against regenerateDependencyRelationships,
    // which emits `E → macro-source-entry` for "E depends on that entry".
    const rows = selectEntryRelationships('me', [rel('r2', 'a', 'me', 'depends')], entries);
    expect(rows).toEqual([]);
  });

  it('keeps incoming non-dependency edges', () => {
    const rows = selectEntryRelationships(
      'me',
      [rel('r3', 'a', 'me', 'generalizes'), rel('r4', 'b', 'me', 'uses_context')],
      entries
    );
    expect(rows.map((r) => [r.id, r.direction])).toEqual([
      ['r3', 'incoming'],
      ['r4', 'incoming']
    ]);
  });

  it('excludes exactly the labels declared reverse-excluded', () => {
    expect(REVERSE_EXCLUDED_LABELS).toContain('depends');
    const rows = selectEntryRelationships(
      'me',
      REVERSE_EXCLUDED_LABELS.map((label, i) => rel(`x${i}`, 'a', 'me', label)),
      entries
    );
    expect(rows).toEqual([]);
  });

  it('ignores edges that do not touch the entry', () => {
    expect(
      selectEntryRelationships('me', [rel('r5', 'a', 'b', 'depends')], entries)
    ).toEqual([]);
  });

  it('reports a self-loop once, as outgoing', () => {
    const rows = selectEntryRelationships('me', [rel('r6', 'me', 'me', 'depends')], entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('outgoing');
    expect(rows[0].otherId).toBe('me');
  });

  it('sorts outgoing first, then by label, then by display name', () => {
    const rows = selectEntryRelationships(
      'me',
      [
        rel('r-in', 'c', 'me', 'proves'),
        rel('r-out-z', 'me', 'c', 'zeta'),
        rel('r-out-a2', 'me', 'b', 'alpha'),
        rel('r-out-a1', 'me', 'a', 'alpha')
      ],
      entries
    );
    expect(rows.map((r) => r.id)).toEqual([
      'r-out-a1',
      'r-out-a2',
      'r-out-z',
      'r-in'
    ]);
  });

  it('still lists an endpoint that is missing from the pool', () => {
    const rows = selectEntryRelationships('me', [rel('r7', 'me', 'ghost', 'proves')], entries);
    expect(rows).toEqual([
      {
        id: 'r7',
        label: 'proves',
        direction: 'outgoing',
        otherId: 'ghost',
        otherTitle: ''
      }
    ]);
  });

  it('returns nothing without an entry id (create mode)', () => {
    expect(selectEntryRelationships('', [rel('r8', 'a', 'b', 'depends')], entries)).toEqual([]);
  });
});
