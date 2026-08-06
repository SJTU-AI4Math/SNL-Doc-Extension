export type HostMessageValue = string | number | boolean;
export type HostMessageParams = Readonly<Record<string, HostMessageValue>>;

export interface HostPluralMessage {
  readonly arg: string;
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type HostMessageTemplate = string | HostPluralMessage;
export type HostMessageCatalog = Readonly<Record<string, HostMessageTemplate>>;

export interface HostMessages<Messages extends HostMessageCatalog = HostMessageCatalog> {
  readonly en: Messages;
  readonly 'zh-CN': { readonly [Key in keyof Messages]: HostMessageTemplate };
}

type HostTemplateText<Template> = Template extends string
  ? Template
  : Template extends HostPluralMessage
    ? Extract<Template[keyof Template], string>
    : never;
type HostPlaceholderNames<Text extends string> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | HostPlaceholderNames<Rest>
  : never;
type HostRequiredNames<Template> =
  HostPlaceholderNames<HostTemplateText<Template>> |
  (Template extends HostPluralMessage ? Template['arg'] : never);
type HostTypedParams<Template> = Readonly<
  Record<Exclude<HostPlaceholderNames<HostTemplateText<Template>>, Template extends HostPluralMessage ? Template['arg'] : never>, HostMessageValue> &
  (Template extends HostPluralMessage ? Record<Template['arg'], number> : object)
>;
export type HostTranslatorArgs<Template> = [HostRequiredNames<Template>] extends [never]
  ? []
  : [params: HostTypedParams<Template>];

export type HostTranslator<Messages extends HostMessageCatalog> =
  <Key extends keyof Messages & string>(key: Key, ...args: HostTranslatorArgs<Messages[Key]>) => string;

export function defineHostMessages<const Messages extends HostMessageCatalog>(
  english: Messages,
  chinese: { readonly [Key in keyof Messages]: HostMessageTemplate }
): HostMessages<Messages> {
  const extraKeys = Object.keys(chinese).filter((key) => !(key in english));
  if (extraKeys.length > 0) {
    throw new Error(`Extra zh-CN host messages: ${extraKeys.join(', ')}`);
  }
  for (const key of Object.keys(english) as Array<keyof Messages & string>) {
    const enTemplate = english[key];
    const zhTemplate = chinese[key];
    if (zhTemplate === undefined) throw new Error(`Missing zh-CN host message: ${key}`);
    const enPlural = typeof enTemplate !== 'string';
    const zhPlural = typeof zhTemplate !== 'string';
    if (enPlural && zhPlural && enTemplate.arg !== zhTemplate.arg) {
      throw new Error(`Host message ${key} has incompatible plural arguments`);
    }
    const enParams = hostPlaceholderNames(enTemplate);
    const zhParams = hostPlaceholderNames(zhTemplate);
    const missing = [...enParams].filter((name) => !zhParams.has(name));
    const extra = [...zhParams].filter((name) => !enParams.has(name));
    if (missing.length || extra.length) {
      throw new Error(
        `Host message ${key} placeholder mismatch: missing [${missing.join(', ')}], ` +
        `extra [${extra.join(', ')}]`
      );
    }
  }
  return { en: english, 'zh-CN': chinese };
}

function hostPlaceholderNames(template: HostMessageTemplate): Set<string> {
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

export function formatHostMessage(
  template: string,
  params: HostMessageParams = {}
): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (!(name in params)) throw new Error(`Missing host message parameter: ${name}`);
    return String(params[name]);
  });
}

function selectTemplate(
  locale: 'en' | 'zh-CN',
  template: HostMessageTemplate,
  params: HostMessageParams
): string {
  if (typeof template === 'string') return template;
  const count = params[template.arg];
  if (typeof count !== 'number') {
    throw new Error(`Missing numeric host message parameter: ${template.arg}`);
  }
  const category = new Intl.PluralRules(locale).select(count);
  return template[category] ?? template.other;
}

export function createHostTranslator<Messages extends HostMessageCatalog>(
  language: string,
  messages: HostMessages<Messages>
): HostTranslator<Messages> {
  const locale = language.toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
  const catalog = messages[locale];
  return ((key: keyof Messages & string, params: HostMessageParams = {}) => {
    const template = catalog[key];
    if (template === undefined) throw new Error(`Unknown host message: ${key}`);
    return formatHostMessage(selectTemplate(locale, template, params), params);
  }) as HostTranslator<Messages>;
}
