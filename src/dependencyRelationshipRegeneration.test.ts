import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import {
  reconcileDependencyRelationships,
  type EntryData,
  type MacroPackageEntry,
  type RelationshipData
} from './snlDoc';

const entry = (id: string, snl: string): EntryData => ({
  id,
  kind: 'definition',
  title: id,
  content: { snl },
  contribution_info: null,
  pointer: null
});

const macro = (name: string, sources: string[]): MacroPackageEntry => ({
  name,
  description: '',
  source: { entries: sources, urls: [] },
  dynamic_arity: false,
  default_style: {},
  styles: [],
  tags: []
});

const auto = (id: string, from: string, to: string, label = 'depends'): RelationshipData => ({
  id,
  from,
  to,
  label,
  metadata: {
    generator: 'macro-source-scan',
    isAtomic: true,
    [label === 'depends' ? 'macros' : 'postfixes']: ['old']
  }
});

describe('scoped dependency relationship reconciliation', () => {
  it('replaces only the saved Entry system rows and preserves every other row deeply', () => {
    const customDepends: RelationshipData = {
      id: 'custom-depends',
      from: 'saved',
      to: 'target',
      label: 'depends',
      metadata: { nested: { bytes: [1, 2, 3] }, isAtomic: 'author-value' }
    };
    const foreignGenerator: RelationshipData = {
      id: 'foreign-generator',
      from: 'saved',
      to: 'stale',
      label: 'uses_context',
      metadata: { generator: 'another-system', opaque: true }
    };
    const otherEntryAuto = auto('dep.other.target', 'other', 'target');
    const bridgeAuto = auto('dep.mid.target', 'mid', 'target');
    const customBefore = structuredClone(customDepends);
    const foreignBefore = structuredClone(foreignGenerator);
    const otherBefore = structuredClone(otherEntryAuto);
    const bridgeBefore = structuredClone(bridgeAuto);

    const result = reconcileDependencyRelationships(
      [
        entry('saved', 'freshMacro contextVar@context'),
        entry('other', ''),
        entry('mid', ''),
        entry('target', ''),
        entry('stale', ''),
        entry('context', '')
      ],
      { freshMacro: macro('freshMacro', ['mid', 'target']) },
      [
        auto('dep.saved.stale', 'saved', 'stale'),
        auto('ctx.saved.stale', 'saved', 'stale', 'uses_context'),
        customDepends,
        foreignGenerator,
        otherEntryAuto,
        bridgeAuto
      ],
      { entryIds: new Set(['saved']) }
    );

    expect(result.relationships.some(({ id }) => id === 'dep.saved.stale')).toBe(false);
    expect(result.relationships.some(({ id }) => id === 'ctx.saved.stale')).toBe(false);
    expect(result.relationships).toContainEqual(expect.objectContaining({
      id: 'dep.saved.mid', from: 'saved', to: 'mid', label: 'depends'
    }));
    expect(result.relationships).toContainEqual(expect.objectContaining({
      id: 'dep.saved.target',
      metadata: expect.objectContaining({ generator: 'macro-source-scan', isAtomic: false })
    }));
    expect(result.relationships).toContainEqual(expect.objectContaining({
      id: 'ctx.saved.context', from: 'saved', to: 'context', label: 'uses_context'
    }));

    expect(result.relationships.find(({ id }) => id === customDepends.id)).toEqual(customBefore);
    expect(result.relationships.find(({ id }) => id === foreignGenerator.id)).toEqual(foreignBefore);
    expect(result.relationships.find(({ id }) => id === otherEntryAuto.id)).toEqual(otherBefore);
    expect(result.relationships.find(({ id }) => id === bridgeAuto.id)).toEqual(bridgeBefore);
    expect(customDepends).toEqual(customBefore);
    expect(foreignGenerator).toEqual(foreignBefore);
    expect(otherEntryAuto).toEqual(otherBefore);
    expect(bridgeAuto).toEqual(bridgeBefore);
  });
});
