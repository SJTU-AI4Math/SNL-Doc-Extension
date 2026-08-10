import type { I18n, Localized } from '@sjtu-ai4math/snl-basics';

export function is_valid_i18n_string(value: unknown): value is I18n<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'i18n' || typeof record.default_language !== 'string') {
    return false;
  }
  if (!record.values || typeof record.values !== 'object' || Array.isArray(record.values)) {
    return false;
  }
  const values = record.values as Record<string, unknown>;
  const keys = Object.keys(values);
  return keys.length > 0 && keys.every((key) => typeof values[key] === 'string');
}

export function is_valid_macro_i18n_string(value: unknown): value is I18n<string, string> {
  return is_valid_i18n_string(value) &&
    Object.prototype.hasOwnProperty.call(value.values, value.default_language) &&
    typeof value.values[value.default_language] === 'string';
}

export function localized_string_or_undefined(
  value: unknown,
  allow_i18n: false
): string | undefined;
export function localized_string_or_undefined(
  value: unknown,
  allow_i18n: true
): Localized<string, string> | undefined;
export function localized_string_or_undefined(
  value: unknown,
  allow_i18n: boolean
): Localized<string, string> | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (value === undefined || value === null) return undefined;
  if (is_valid_i18n_string(value)) {
    if (!allow_i18n) throw new Error('field is language-invariant');
    return value;
  }
  if (typeof value === 'object') {
    throw new Error('invalid localized string');
  }
  throw new Error('localized string must be a string or I18n map');
}

export function normalize_entry_title(value: unknown): Localized<string, string> {
  if (typeof value === 'string') return value.trim();
  if (!is_valid_i18n_string(value)) {
    throw new Error('Entry title must be a string or valid partial I18n map');
  }
  const values: Record<string, string> = {};
  for (const language of Object.keys(value.values)) {
    Object.defineProperty(values, language, {
      value: value.values[language], enumerable: true, configurable: true, writable: true
    });
  }
  return {
    type: 'i18n',
    default_language: value.default_language,
    values
  };
}

export function resolve_localized_string(
  value: Localized<string, string> | null | undefined,
  language: string
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Object.prototype.hasOwnProperty.call(value.values, language)) {
    return value.values[language] ?? '';
  }
  if (Object.prototype.hasOwnProperty.call(value.values, value.default_language)) {
    return value.values[value.default_language] ?? '';
  }
  for (const sourceLanguage of Object.keys(value.values)) {
    const candidate = value.values[sourceLanguage];
    if (candidate !== undefined) return candidate;
  }
  return '';
}

export interface LocalizedEntryContent {
  snl?: string;
  typst?: Localized<string, string>;
  latex?: Localized<string, string>;
  markdown?: Localized<string, string>;
  text?: Localized<string, string>;
}

export function normalize_entry_content(value: unknown): LocalizedEntryContent {
  const input = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const output: LocalizedEntryContent = {};
  const snl = localized_string_or_undefined(input.snl, false);
  const typst = localized_string_or_undefined(input.typst, true);
  const latex = localized_string_or_undefined(input.latex, true);
  const markdown = localized_string_or_undefined(input.markdown, true);
  const text = localized_string_or_undefined(input.text, true);
  if (snl !== undefined) output.snl = snl;
  if (typst !== undefined) output.typst = typst;
  if (latex !== undefined) output.latex = latex;
  if (markdown !== undefined) output.markdown = markdown;
  if (text !== undefined) output.text = text;
  return output;
}

export function normalize_macro_template(
  mode: 'text',
  value: unknown,
  fallback?: string
): Localized<string, string>;
export function normalize_macro_template(
  mode: 'formula_inline' | 'formula_display' | 'block',
  value: unknown,
  fallback?: string
): string;
export function normalize_macro_template(
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block',
  value: unknown,
  fallback?: string
): Localized<string, string>;
export function normalize_macro_template(
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block',
  value: unknown,
  fallback = ''
): Localized<string, string> {
  if (typeof value === 'string') return value;
  if (is_valid_macro_i18n_string(value)) {
    if (mode !== 'text') throw new Error(`I18n templates are not valid in Macro ${mode} styles`);
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    throw new Error('invalid localized string');
  }
  return fallback;
}

export function template_placeholder_signature(template: string): string {
  const placeholders = new Set<string>();
  const regex = /(?<!\\)#(\*|\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    placeholders.add(`#${match[1]}`);
  }
  return [...placeholders].sort().join(',');
}

export function macro_template_variants(
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block',
  value: unknown
): string[] {
  if (is_valid_macro_i18n_string(value)) {
    if (mode !== 'text') throw new Error(`I18n templates are not valid in Macro ${mode} styles`);
    return Object.values(value.values).filter((template): template is string => typeof template === 'string');
  }
  if (mode === 'text') return [normalize_macro_template('text', value) as string];
  return [normalize_macro_template(mode, value)];
}
