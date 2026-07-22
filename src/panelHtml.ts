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
    `data-snl-color-scheme="${escape_html_attribute(preferences.color_scheme)}"`,
    `data-snl-motion="${escape_html_attribute(preferences.motion)}"`
  ].join(' ');
}
