import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DARK_KIND_COLORING,
  DEFAULT_LIGHT_KIND_COLORING,
  assertThemedKindCatalogs,
  fillKindColoringDefaults,
  mergeThemedKindColoring,
  normalizeKindColoring,
  requireThemedKindColoring
} from './kindColoring';

describe('Kind themed coloring', () => {
  it('duplicates a legacy pair losslessly for compatibility reads', () => {
    expect(normalizeKindColoring({ stroke: '#123456', background: '#abcdef' })).toEqual({
      light: { stroke: '#123456', background: '#abcdef' },
      dark: { stroke: '#123456', background: '#abcdef' }
    });
  });

  it('repairs blank or missing legacy pair fields before canonical writes', () => {
    expect(normalizeKindColoring({ stroke: '', background: '#abcdef' })).toEqual({
      light: { stroke: '#abcdef', background: '#abcdef' },
      dark: { stroke: '#abcdef', background: '#abcdef' }
    });
    expect(normalizeKindColoring({ stroke: '#123456' })).toEqual({
      light: { stroke: '#123456', background: '#123456' },
      dark: { stroke: '#123456', background: '#123456' }
    });
  });

  it('distinguishes an absent compatibility value from a malformed non-object', () => {
    expect(normalizeKindColoring(undefined)).toEqual({
      light: DEFAULT_LIGHT_KIND_COLORING,
      dark: DEFAULT_DARK_KIND_COLORING
    });
    expect(() => normalizeKindColoring('red')).toThrow(/object|coloring/i);
    expect(() => normalizeKindColoring(null)).toThrow(/object|coloring/i);
  });

  it('preserves independent light and dark variants without aliasing them', () => {
    const source = {
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '#222222' }
    };
    const normalized = requireThemedKindColoring(source, 'kind.coloring');
    expect(normalized).toEqual(source);
    expect(normalized.light).not.toBe(source.light);
    expect(normalized.dark).not.toBe(source.dark);
  });

  it('preserves unknown coloring and variant extension fields', () => {
    expect(normalizeKindColoring({
      vendor: { keep: true },
      light: { stroke: '#111111', background: '#eeeeee', token: 'light-token' },
      dark: { stroke: '#dddddd', background: '#222222', token: 'dark-token' }
    })).toEqual({
      vendor: { keep: true },
      light: { stroke: '#111111', background: '#eeeeee', token: 'light-token' },
      dark: { stroke: '#dddddd', background: '#222222', token: 'dark-token' }
    });
    expect(normalizeKindColoring({
      stroke: '#123456', background: '#abcdef', vendor: { keep: true }
    })).toEqual({
      vendor: { keep: true },
      light: { stroke: '#123456', background: '#abcdef' },
      dark: { stroke: '#123456', background: '#abcdef' }
    });
  });

  it('merges edited managed colors without dropping existing extensions', () => {
    expect(mergeThemedKindColoring({
      vendor: { keep: true },
      light: { stroke: '#111111', background: '#eeeeee', token: 'light-token' },
      dark: { stroke: '#dddddd', background: '#222222', token: 'dark-token' }
    }, {
      light: { stroke: '#123456', background: '#abcdef' },
      dark: { stroke: '#fedcba', background: '#654321' }
    })).toEqual({
      vendor: { keep: true },
      light: { stroke: '#123456', background: '#abcdef', token: 'light-token' },
      dark: { stroke: '#fedcba', background: '#654321', token: 'dark-token' }
    });
  });

  it('keeps current writes strict for a partial themed palette', () => {
    expect(() => requireThemedKindColoring({
      light: { stroke: '#111111', background: '#eeeeee' }
    }, 'kind.coloring')).toThrow(/kind\.coloring\.dark/);
    expect(() => requireThemedKindColoring({
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd' }
    }, 'kind.coloring')).toThrow(/kind\.coloring\.dark\.background/);
    expect(() => requireThemedKindColoring({
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '   ' }
    }, 'kind.coloring')).toThrow(/kind\.coloring\.dark\.background/);
  });

  it('fills a missing compatibility theme from the surviving side', () => {
    expect(normalizeKindColoring({
      light: { stroke: '#111111', background: '#eeeeee' }
    })).toEqual({
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#111111', background: '#eeeeee' }
    });
    expect(normalizeKindColoring({
      dark: { stroke: '#dddddd', background: '#222222' }
    })).toEqual({
      light: { stroke: '#dddddd', background: '#222222' },
      dark: { stroke: '#dddddd', background: '#222222' }
    });
  });

  it('fills blank compatibility fields from the counterpart before defaults', () => {
    expect(normalizeKindColoring({
      light: { stroke: '', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '' }
    })).toEqual({
      light: { stroke: '#dddddd', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '#eeeeee' }
    });
  });

  it('rejects mixed legacy and themed managed fields', () => {
    expect(() => requireThemedKindColoring({
      stroke: '#legacy', background: '#legacy-bg',
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '#222222' }
    }, 'kind.coloring')).toThrow(/mix|legacy|stroke/i);
  });

  it('validates complete current catalogs before an ordinary write', () => {
    const valid = {
      entry_kinds: [{ id: 'theorem', name: 'Theorem', defaultCounterName: '', style: '', coloring: {
        light: { stroke: '#111111', background: '#eeeeee' },
        dark: { stroke: '#dddddd', background: '#222222' }
      } }],
      macro_kinds: [{ id: 'operator', name: 'Operator', description: '', coloring: {
        light: { stroke: '#123456', background: '#abcdef' },
        dark: { stroke: '#fedcba', background: '#654321' }
      } }]
    };
    expect(() => assertThemedKindCatalogs(valid)).not.toThrow();
    const localized = structuredClone(valid) as unknown as {
      entry_kinds: Array<Record<string, unknown>>;
      macro_kinds: Array<Record<string, unknown>>;
    };
    const localizedEntry = localized.entry_kinds[0];
    localizedEntry.name = {
      type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' }
    };
    localizedEntry.description = {
      type: 'i18n', default_language: 'en', values: { en: 'A result.', 'zh-CN': '一个结果。' }
    };
    expect(() => assertThemedKindCatalogs(localized)).not.toThrow();
    localizedEntry.name = {
      type: 'i18n', default_language: 'en', values: { en: '', 'zh-CN': ' ' }
    };
    expect(() => assertThemedKindCatalogs(localized)).toThrow(/entry_kinds.*name.*non-empty/i);
    expect(() => assertThemedKindCatalogs({
      ...valid,
      macro_kinds: [{ id: 'operator', name: 'Operator', description: '', coloring: {
        light: { stroke: '#123456', background: '#abcdef' }
      } }]
    })).toThrow(/macro_kinds.*dark/i);
    expect(() => assertThemedKindCatalogs({
      ...valid,
      entry_kinds: [{ id: 'theorem', name: 'Theorem', defaultCounterName: '', style: '' }]
    })).toThrow(/entry_kinds.*coloring/i);
    for (const field of ['name', 'defaultCounterName', 'style'] as const) {
      const malformed = structuredClone(valid);
      delete (malformed.entry_kinds[0] as unknown as Record<string, unknown>)[field];
      expect(() => assertThemedKindCatalogs(malformed)).toThrow(new RegExp(`entry_kinds.*${field}`, 'i'));
    }
    for (const field of ['name', 'description'] as const) {
      const malformed = structuredClone(valid);
      delete (malformed.macro_kinds[0] as unknown as Record<string, unknown>)[field];
      expect(() => assertThemedKindCatalogs(malformed)).toThrow(new RegExp(`macro_kinds.*${field}`, 'i'));
    }
    expect(() => assertThemedKindCatalogs({
      ...valid,
      entry_kinds: [...valid.entry_kinds, structuredClone(valid.entry_kinds[0])]
    })).toThrow(/entry_kinds.*duplicate/i);
  });

  it('uses distinct new-record defaults for light and dark themes', () => {
    expect(DEFAULT_LIGHT_KIND_COLORING).toEqual({ stroke: '#475569', background: '#F1F5F9' });
    expect(DEFAULT_DARK_KIND_COLORING).toEqual({ stroke: '#94A3B8', background: '#313131' });
    expect(DEFAULT_LIGHT_KIND_COLORING).not.toEqual(DEFAULT_DARK_KIND_COLORING);
  });

  it('fills each submitted theme from its own defaults', () => {
    expect(fillKindColoringDefaults({
      light: { stroke: '  ', background: '#ffffff' },
      dark: { stroke: '#dddddd', background: '' }
    })).toEqual({
      light: { stroke: '#475569', background: '#ffffff' },
      dark: { stroke: '#dddddd', background: '#313131' }
    });
  });
});
