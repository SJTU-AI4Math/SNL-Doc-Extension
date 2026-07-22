export type SupportedLanguage = 'en' | 'zh-CN';
export type LanguagePreference = 'auto' | SupportedLanguage;
export type ColorScheme = 'light' | 'dark' | 'high-contrast';
export type ColorSchemePreference = 'auto' | ColorScheme;
export type MotionPreference = 'auto' | 'full' | 'reduced';

export interface ExtensionPreferences {
  language: SupportedLanguage;
  color_scheme: ColorScheme;
  motion: MotionPreference;
}

export function resolve_language(
  preference: LanguagePreference,
  vscode_language: string
): SupportedLanguage {
  if (preference !== 'auto') return preference;
  const normalized = vscode_language.trim().toLowerCase().replace(/_/g, '-');
  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized === 'zh-hans' ||
    normalized === 'zh-sg'
  ) {
    return 'zh-CN';
  }
  return 'en';
}

export function resolve_color_scheme(
  preference: ColorSchemePreference,
  active: ColorScheme
): ColorScheme {
  return preference === 'auto' ? active : preference;
}

export function resolve_motion(preference: MotionPreference): MotionPreference {
  return preference;
}
