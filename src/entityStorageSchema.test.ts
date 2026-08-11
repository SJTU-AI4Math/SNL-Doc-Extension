import { describe, expect, it } from 'vitest';
import {
  CURRENT_ENTRY_SCHEMA_VERSION,
  CURRENT_MACRO_SCHEMA_VERSION,
  CURRENT_PACKAGE_SCHEMA_VERSION,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  upgradeEntryEnvelopeSchema,
  upgradeMacroEnvelopeSchema,
  upgradePackageManifestSchema
} from './entityStorage';

describe('per-file entity schema versions', () => {
  it('stamps every newly-created split-storage file with its current payload schema version', () => {
    expect(CURRENT_ENTRY_SCHEMA_VERSION).toBe(1);
    expect(CURRENT_MACRO_SCHEMA_VERSION).toBe(1);
    expect(CURRENT_PACKAGE_SCHEMA_VERSION).toBe(1);
    expect(makeEntryEnvelope('logic', { id: 'entry-1' }).schema_version).toBe(1);
    expect(makeMacroEnvelope('logic', { name: 'Eq' }).schema_version).toBe(1);
    expect(makePackageManifest('logic', 'Logic', '').schema_version).toBe(1);
  });

  it('upgrades legacy files that predate per-file schema versions without mutating their read snapshot', () => {
    const entry = {
      format: 'snl-entry' as const,
      version: 1 as const,
      package: 'logic',
      vendor_extension: { keep: true },
      entry: { id: 'entry-1' }
    };
    const macro = {
      format: 'snl-macro' as const,
      version: 1 as const,
      package: 'logic',
      vendor_extension: ['keep'],
      macro: { name: 'Eq' }
    };
    const manifest = {
      format: 'snl-package' as const,
      version: 1 as const,
      id: 'logic',
      name: 'Logic',
      description: '',
      vendor_extension: 'keep'
    };

    expect(upgradeEntryEnvelopeSchema(entry)).toEqual({
      ...entry,
      schema_version: CURRENT_ENTRY_SCHEMA_VERSION
    });
    expect(upgradeMacroEnvelopeSchema(macro)).toEqual({
      ...macro,
      schema_version: CURRENT_MACRO_SCHEMA_VERSION
    });
    expect(upgradePackageManifestSchema(manifest)).toEqual({
      ...manifest,
      schema_version: CURRENT_PACKAGE_SCHEMA_VERSION
    });
    expect(Object.hasOwn(entry, 'schema_version')).toBe(false);
    expect(Object.hasOwn(macro, 'schema_version')).toBe(false);
    expect(Object.hasOwn(manifest, 'schema_version')).toBe(false);
  });

  it.each([
    ['Entry', upgradeEntryEnvelopeSchema, { format: 'snl-entry', version: 1, package: 'logic', entry: {} }],
    ['Macro', upgradeMacroEnvelopeSchema, { format: 'snl-macro', version: 1, package: 'logic', macro: {} }],
    ['Package', upgradePackageManifestSchema, { format: 'snl-package', version: 1, id: 'logic', name: 'Logic', description: '' }]
  ] as const)('rejects malformed and future %s schema markers instead of guessing', (_label, upgrade, base) => {
    expect(() => upgrade({ ...base, schema_version: 0 })).toThrow(/schema_version.*positive integer/i);
    expect(() => upgrade({ ...base, schema_version: '1' })).toThrow(/schema_version.*positive integer/i);
    expect(() => upgrade({ ...base, schema_version: 2 })).toThrow(/newer.*supports/i);
  });
});
