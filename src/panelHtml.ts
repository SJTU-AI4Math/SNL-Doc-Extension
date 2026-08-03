import type { ExtensionPreferences } from './preferences-core';

export function escape_html_attribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function preference_html_attributes(
  preferences: ExtensionPreferences
): string {
  return [
    `lang="${escape_html_attribute(preferences.language)}"`,
    `data-snl-language-preference="${escape_html_attribute(preferences.language_preference)}"`,
    `data-snl-color-scheme="${escape_html_attribute(preferences.color_scheme)}"`,
    `data-snl-motion="${escape_html_attribute(preferences.motion)}"`
  ].join(' ');
}

/** Brand assets are bootstrapped with the document just like preferences. */
export function brand_html_attributes(black_logo: string, white_logo: string): string {
  return [
    `data-snl-logo-black="${escape_html_attribute(black_logo)}"`,
    `data-snl-logo-white="${escape_html_attribute(white_logo)}"`
  ].join(' ');
}
