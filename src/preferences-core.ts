import {
  is_supported_language,
  type SupportedLanguage
} from './languageCatalog';

export { is_supported_language, type SupportedLanguage } from './languageCatalog';
export type LanguagePreference = 'auto' | SupportedLanguage;
export type ColorScheme = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';
export type ColorSchemePreference = 'auto' | ColorScheme;
export type MotionPreference = 'auto' | 'full' | 'reduced';

export interface ExtensionPreferences {
  language: SupportedLanguage;
  language_preference: LanguagePreference;
  color_scheme: ColorScheme;
  motion: MotionPreference;
}

export type LanguageConfigurationTarget = 'global' | 'workspace';

export function language_configuration_target(inspect: {
  workspaceValue?: unknown;
} | undefined): LanguageConfigurationTarget {
  return inspect?.workspaceValue !== undefined ? 'workspace' : 'global';
}

export function resolve_language(
  preference: LanguagePreference,
  vscode_language: string
): SupportedLanguage {
  if (preference !== 'auto' && is_supported_language(preference)) return preference;
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
