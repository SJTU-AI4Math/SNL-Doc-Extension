import { describe, expect, it } from 'vitest';
import type { I18n } from '@sjtu-ai4math/snl-basics';
import {
  localized_string_or_undefined,
  macro_template_variants,
  normalize_entry_content,
  normalize_entry_title,
  normalize_kind_label,
  normalize_macro_template,
  resolve_localized_string,
  template_placeholder_signature
} from './localizedContent';

const localized: I18n<string, string> = {
  type: 'i18n',
  default_language: 'en',
  values: { en: 'Group', 'zh-CN': '群' }
};

describe('localized persistence boundaries', () => {
  it('preserves valid localized Entry content without projecting it', () => {
    expect(localized_string_or_undefined(localized, true)).toEqual(localized);
    expect(localized_string_or_undefined('plain', true)).toBe('plain');
    expect(localized_string_or_undefined('', true)).toBeUndefined();
  });

  it('normalizes a complete Entry content object without losing I18n', () => {
    expect(normalize_entry_content({ snl: 'Group(G)', markdown: localized })).toEqual({
      snl: 'Group(G)',
      markdown: localized
    });
  });

  it('preserves partial localized Entry titles and resolves them by content language', () => {
    const title = {
      type: 'i18n' as const,
      default_language: 'en',
      values: JSON.parse('{"zh-CN":"群","__proto__":"Prototype title"}') as Record<string, string>
    };
    expect(normalize_entry_title(title)).toEqual(title);
    expect(resolve_localized_string(title, 'zh-CN')).toBe('群');
    expect(resolve_localized_string(title, '__proto__')).toBe('Prototype title');
    expect(resolve_localized_string(title, 'fr')).toBe('群');
    expect(normalize_entry_title(' Plain title ')).toBe('Plain title');
  });

  it('validates required Entry Kind labels without losing partial or prototype-shaped locales', () => {
    const name = {
      type: 'i18n' as const,
      default_language: 'constructor',
      values: JSON.parse('{"zh-CN":"定理","__proto__":"Theorem"}') as Record<string, string>
    };
    const normalized = normalize_kind_label(name, 'Entry Kind name', true);
    expect(normalized).toEqual(name);
    expect(resolve_localized_string(normalized, 'fr')).toBe('定理');
    expect(() => normalize_kind_label({
      type: 'i18n', default_language: 'en', values: { en: '', 'zh-CN': '  ' }
    }, 'Entry Kind name', true)).toThrow(/non-empty label/);
    expect(normalize_kind_label({
      type: 'i18n', default_language: 'en', values: { en: '' }
    }, 'Entry Kind description', false)).toMatchObject({ values: { en: '' } });
    expect(normalize_kind_label('  Theorem  ', 'Entry Kind name', true)).toBe('  Theorem  ');
    expect(normalize_kind_label('  legacy description  ', 'Entry Kind description', false))
      .toBe('  legacy description  ');
  });

  it('rejects localized values in invariant fields', () => {
    expect(() => localized_string_or_undefined(localized, false)).toThrow(/language-invariant/);
  });

  it('accepts localized text Macro templates and rejects them in structural modes', () => {
    expect(normalize_macro_template('formula_inline', '#0')).toBe('#0');
    expect(normalize_macro_template('text', '#0 is a group')).toBe('#0 is a group');
    expect(normalize_macro_template('text', localized)).toEqual(localized);
    expect(() => normalize_macro_template('formula_inline', localized)).toThrow(/not valid/);
  });

  it('exposes every localized text projection for validation', () => {
    expect(macro_template_variants('formula_inline', '#0')).toEqual(['#0']);
    expect(macro_template_variants('text', localized)).toEqual(['Group', '群']);
  });

  it('computes a stable placeholder signature', () => {
    expect(template_placeholder_signature(String.raw`#1 + #0 + #1 + \#2`)).toBe('#0,#1');
    expect(template_placeholder_signature('all: #*')).toBe('#*');
  });

  it('accepts a partial Entry map but rejects it as a Macro Template', () => {
    const partial = {
      type: 'i18n' as const,
      default_language: 'en',
      values: { 'zh-CN': '条目' }
    };
    expect(localized_string_or_undefined(partial, true)).toEqual(partial);
    expect(() => normalize_macro_template('text', partial)).toThrow(/invalid localized string/);
    expect(() => macro_template_variants('text', partial)).toThrow(/invalid localized string/);
  });

  it('rejects an inherited Macro default projection', () => {
    const values = Object.assign(Object.create({ fr: 'Héritée' }), { en: 'English' });
    const inheritedDefault = { type: 'i18n' as const, default_language: 'fr', values };
    expect(() => normalize_macro_template('text', inheritedDefault)).toThrow(/invalid localized string/);
  });

  it('rejects malformed I18n instead of silently deleting it', () => {
    expect(() => localized_string_or_undefined({
      type: 'i18n', default_language: 'en', values: {}
    }, true)).toThrow(/invalid .*string/);
  });
});
