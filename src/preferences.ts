import * as vscode from 'vscode';
import { ReaderRuntime } from '@sjtu-ai4math/snl-basics/runtime';
import {
  resolve_color_scheme,
  resolve_language,
  resolve_motion,
  resolve_formatter_indent_spaces,
  resolve_formatter_inline_parenthesis_depth,
  type ColorScheme,
  type ColorSchemePreference,
  type ExtensionPreferences,
  type LanguagePreference,
  type MotionPreference
} from './preferences-core';

function language_preference(value: unknown): LanguagePreference {
  return value === 'en' || value === 'zh-CN' ? value : 'auto';
}

function color_scheme_preference(value: unknown): ColorSchemePreference {
  return value === 'light' || value === 'dark' || value === 'high-contrast' ||
    value === 'high-contrast-light'
    ? value
    : 'auto';
}

function motion_preference(value: unknown): MotionPreference {
  return value === 'full' || value === 'reduced' ? value : 'auto';
}

function active_color_scheme(): ColorScheme {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast-light';
    default:
      return 'dark';
  }
}

/** Read effective preferences from VS Code without exposing that backend to Basics. */
export function read_extension_preferences(): ExtensionPreferences {
  const config = vscode.workspace.getConfiguration('snlDoc');
  const languagePreference = language_preference(config.get('locale'));
  return {
    language: resolve_language(
      languagePreference,
      vscode.env.language
    ),
    language_preference: languagePreference,
    color_scheme: resolve_color_scheme(
      color_scheme_preference(config.get('appearance.theme')),
      active_color_scheme()
    ),
    motion: resolve_motion(motion_preference(config.get('appearance.motion'))),
    formatter_indent_spaces: resolve_formatter_indent_spaces(
      config.get('editor.formatter.indentSpaces')
    ),
    formatter_inline_parenthesis_depth: resolve_formatter_inline_parenthesis_depth(
      config.get('editor.formatter.inlineParenthesisDepth')
    ),
    popover_hover_enabled: config.get<boolean>('popovers.openOnHover', true)
  };
}

/** Query-backed Basics runtime; every run re-reads Extension Settings. */
export const extension_preferences_runtime = new ReaderRuntime<ExtensionPreferences>({
  queries: {
    query_environment: read_extension_preferences
  }
});
