import { describe, expect, it } from 'vitest';
import type { I18n } from '@snl-basics/react';
import {
  localized_string_or_undefined,
  macro_template_variants,
  normalize_entry_content,
  normalize_macro_template,
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

  it('rejects localized values in invariant fields', () => {
    expect(() => localized_string_or_undefined(localized, false)).toThrow(/language-invariant/);
  });

  it('preserves I18n only for text Macro templates', () => {
    expect(normalize_macro_template('text', localized)).toEqual(localized);
    expect(normalize_macro_template('formula_inline', '#0')).toBe('#0');
    expect(() => normalize_macro_template('formula_inline', localized)).toThrow(/text Macro/);
  });

  it('exposes every localized template variant for validation', () => {
    expect(macro_template_variants('text', localized)).toEqual(['Group', '群']);
    expect(macro_template_variants('formula_inline', '#0')).toEqual(['#0']);
  });

  it('computes a stable placeholder signature', () => {
    expect(template_placeholder_signature(String.raw`#1 + #0 + #1 + \#2`)).toBe('#0,#1');
    expect(template_placeholder_signature('all: #*')).toBe('#*');
  });

  it('accepts a partial map whose declared default is absent', () => {
    expect(localized_string_or_undefined({
      type: 'i18n',
      default_language: 'en',
      values: { 'zh-CN': '条目' }
    }, true)).toEqual({
      type: 'i18n',
      default_language: 'en',
      values: { 'zh-CN': '条目' }
    });
  });

  it('rejects malformed I18n instead of silently deleting it', () => {
    expect(() => localized_string_or_undefined({
      type: 'i18n', default_language: 'en', values: {}
    }, true)).toThrow(/invalid .*string/);
  });
});
