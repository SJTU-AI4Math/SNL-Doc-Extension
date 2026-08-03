/** Built-in locale descriptors shared by the extension host and every Webview. */
export const BUILT_IN_LANGUAGE_CATALOG = [
  {
    id: 'zh-CN',
    display_name: '简体中文（中国大陆）'
  },
  {
    id: 'en',
    display_name: 'English (US)'
  }
] as const;

export type SupportedLanguage = typeof BUILT_IN_LANGUAGE_CATALOG[number]['id'];

export function is_supported_language(value: unknown): value is SupportedLanguage {
  return BUILT_IN_LANGUAGE_CATALOG.some((language) => language.id === value);
}
