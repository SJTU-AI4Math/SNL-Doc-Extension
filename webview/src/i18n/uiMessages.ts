import { useMemo } from 'react';
import { use_preferences_revision } from '../runtime/preferencesRuntime';

export type UiMessageValue = string | number;
export type UiMessageParams = Readonly<Record<string, UiMessageValue>>;

export interface UiPluralMessage {
  readonly arg: string;
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type UiMessageTemplate = string | UiPluralMessage;
export type UiCatalog = Readonly<Record<string, UiMessageTemplate>>;
export type UiLocale = 'en' | 'zh-CN';

export interface UiMessages<Messages extends UiCatalog = UiCatalog> {
  readonly namespace: string;
  readonly catalogs: Readonly<{
    en: Messages;
    'zh-CN': { readonly [Key in keyof Messages]: UiMessageTemplate };
  }>;
}

export type UiTranslator<Messages extends UiCatalog> =
  <Key extends keyof Messages & string>(key: Key, params?: UiMessageParams) => string;

export function defineUiMessages<const Messages extends UiCatalog>(
  namespace: string,
  english: Messages,
  chinese: { readonly [Key in keyof Messages]: UiMessageTemplate }
): UiMessages<Messages> {
  const extraKeys = Object.keys(chinese).filter((key) => !(key in english));
  if (extraKeys.length > 0) {
    throw new Error(`Extra zh-CN UI messages in ${namespace}: ${extraKeys.join(', ')}`);
  }
  for (const key of Object.keys(english) as Array<keyof Messages & string>) {
    const enTemplate = english[key];
    const zhTemplate = chinese[key];
    if (zhTemplate === undefined) {
      throw new Error(`Missing zh-CN UI message: ${namespace}.${key}`);
    }
    const enPlural = typeof enTemplate !== 'string';
    const zhPlural = typeof zhTemplate !== 'string';
    if (enPlural && zhPlural && enTemplate.arg !== zhTemplate.arg) {
      throw new Error(`UI message ${namespace}.${key} has incompatible plural arguments`);
    }
    const enParams = placeholderNames(enTemplate);
    const zhParams = placeholderNames(zhTemplate);
    const missing = [...enParams].filter((name) => !zhParams.has(name));
    const extra = [...zhParams].filter((name) => !enParams.has(name));
    if (missing.length || extra.length) {
      throw new Error(
        `UI message ${namespace}.${key} placeholder mismatch: ` +
        `missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
      );
    }
  }
  return {
    namespace,
    catalogs: { en: english, 'zh-CN': chinese }
  };
}

function placeholderNames(template: UiMessageTemplate): Set<string> {
  const names = new Set<string>();
  const strings = typeof template === 'string'
    ? [template]
    : [template.zero, template.one, template.two, template.few, template.many, template.other];
  for (const value of strings) {
    if (!value) continue;
    for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

export function resolveUiLocale(locale: string | null | undefined): UiLocale {
  return locale?.toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
}

export function formatUiMessage(
  template: string,
  params: UiMessageParams = {}
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`Missing UI message parameter: ${name}`);
    }
    return String(params[name]);
  });
}

function selectUiTemplate(
  locale: UiLocale,
  template: UiMessageTemplate,
  params: UiMessageParams
): string {
  if (typeof template === 'string') return template;
  const count = params[template.arg];
  if (typeof count !== 'number') {
    throw new Error(`Missing numeric UI plural parameter: ${template.arg}`);
  }
  const category = new Intl.PluralRules(locale).select(count);
  return template[category] ?? template.other;
}

export function createUiTranslator<Messages extends UiCatalog>(
  locale: string,
  definition: UiMessages<Messages>
): UiTranslator<Messages> {
  const resolvedLocale = resolveUiLocale(locale);
  const catalog = definition.catalogs[resolvedLocale];
  return ((key: keyof Messages & string, params: UiMessageParams = {}) => {
    const template = catalog[key];
    if (template === undefined) {
      throw new Error(`Unknown UI message: ${definition.namespace}.${key}`);
    }
    return formatUiMessage(selectUiTemplate(resolvedLocale, template, params), params);
  }) as UiTranslator<Messages>;
}

/** Resolve one component's stable message definition against live preferences. */
export function useUiMessages<Messages extends UiCatalog>(
  definition: UiMessages<Messages>
): UiTranslator<Messages> {
  const revision = use_preferences_revision();
  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang;
  return useMemo(
    () => createUiTranslator(locale, definition),
    [definition, locale, revision]
  );
}

export type InvariantTextReason =
  | 'brand'
  | 'product-name'
  | 'protocol-token'
  | 'file-format'
  | 'keyboard-shortcut';

/** Mark deliberately language-invariant display text for the source gate. */
export function invariantText(value: string, _reason: InvariantTextReason): string {
  return value;
}
