import { describe, expect, it } from 'vitest';
import {
  ENTRY_STORAGE_VERSION,
  PACKAGE_STORAGE_VERSION,
  MACRO_STORAGE_VERSION,
  entityIdentityHash,
  entryEntityPath,
  legacy005EntryEntityPath,
  macroEntityPath,
  packageManifestPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest
} from './entityStorage';

describe('per-entity Package-hash storage identities', () => {
  it('uses the frozen domain-separated NUL-delimited SHA-256 identity encoding', () => {
    expect(entityIdentityHash('package', '_unpackaged')).toBe('60979c6e210d0e2a20cb');
    expect(entityIdentityHash('entry', 'Set.mem')).toBe('dc23c2ae0a0b9459393a');
    expect(entityIdentityHash('macro', 'core', 'Add.add.infix')).toBe('40a64e36a6fa48582270');
  });

  it('derives an Entry path from its globally unique stable ID alone', () => {
    expect(entryEntityPath('Set.mem')).toBe(
      'entries/dc23c2ae0a0b9459393a.json'
    );
    expect(legacy005EntryEntityPath('_unpackaged', 'Set.mem')).toBe(
      'entries/_unpackaged-a45ab8852b86c1868f0f.json'
    );
    // Package membership is mutable metadata. Moving an Entry between
    // Packages must never move its file or invalidate package-free references
    // in Library graphs and relationships.
    expect(entryEntityPath('Set.mem')).toBe(entryEntityPath('Set.mem'));
  });

  it('derives Windows-safe Package and Macro paths from their identities', () => {
    expect(packageManifestPath('_unpackaged')).toBe(
      'packages/_unpackaged-60979c6e210d0e2a20cb.json'
    );
    expect(macroEntityPath('core', 'Add.add.infix')).toBe(
      'macros/core-40a64e36a6fa48582270.json'
    );
    expect(() => packageManifestPath('bad/name')).toThrow(/package id/i);
    expect(() => packageManifestPath('foo.json')).toThrow(/not end in \.json/i);
    expect(() => packageManifestPath('CON')).toThrow(/reserved/i);
  });

  it('stores a common package identity and typed entity envelopes', () => {
    expect(makePackageManifest('_unpackaged', 'Unpackaged', 'Legacy Entries')).toEqual({
      format: 'snl-package',
      version: PACKAGE_STORAGE_VERSION,
      id: '_unpackaged',
      name: 'Unpackaged',
      description: 'Legacy Entries'
    });
    expect(makeEntryEnvelope('_unpackaged', { id: 'Set.mem', title: 'Membership' })).toEqual({
      format: 'snl-entry',
      version: ENTRY_STORAGE_VERSION,
      package: '_unpackaged',
      entry: { id: 'Set.mem', title: 'Membership' }
    });
    expect(makeMacroEnvelope('core', { name: 'Add.add.infix', styles: [] })).toEqual({
      format: 'snl-macro',
      version: MACRO_STORAGE_VERSION,
      package: 'core',
      macro: { name: 'Add.add.infix', styles: [] }
    });
  });
});
