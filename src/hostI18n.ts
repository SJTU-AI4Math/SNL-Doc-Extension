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

export type HostTranslator<Messages extends HostMessageCatalog> =
  <Key extends keyof Messages & string>(key: Key, params?: HostMessageParams) => string;

export function defineHostMessages<const Messages extends HostMessageCatalog>(
  english: Messages,
  chinese: { readonly [Key in keyof Messages]: HostMessageTemplate }
): HostMessages<Messages> {
  return { en: english, 'zh-CN': chinese };
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
