import type { SnlMacro, SnlMacroStyle } from '@snl-basics/react';

export interface WireMacroStyle {
  tag: string;
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block';
  template: string;
  variadic_left?: string;
  variadic_join?: string;
  variadic_right?: string;
  react_renderer_key?: string;
}
export interface WireMacro {
  name: string;
  description?: string;
  source?: { entries?: string[]; urls?: string[] };
  kind?: string;
  dynamic_arity: boolean;
  styles: WireMacroStyle[];
}

/** Canonical wire → @snl-basics render-shape adapter for every webview. */
export function wireMacroToRenderable(macro: WireMacro): SnlMacro {
  const styles: SnlMacroStyle[] = Array.isArray(macro.styles)
    ? macro.styles.map((style) => ({
        tag: style.tag,
        mode: style.mode,
        template: style.template,
        ...(style.variadic_left ? { variadic_left: style.variadic_left } : {}),
        ...(style.variadic_join ? { variadic_join: style.variadic_join } : {}),
        ...(style.variadic_right ? { variadic_right: style.variadic_right } : {}),
        ...(style.mode === 'block' && style.react_renderer_key
          ? { react_renderer_key: style.react_renderer_key }
          : {})
      }))
    : [];
  return {
    name: macro.name,
    description: macro.description ?? '',
    source: {
      entries: Array.isArray(macro.source?.entries) ? macro.source!.entries! : [],
      urls: Array.isArray(macro.source?.urls) ? macro.source!.urls! : []
    },
    ...(macro.kind ? { kind: macro.kind } : {}),
    dynamic_arity: !!macro.dynamic_arity,
    styles: styles.length > 0
      ? styles
      : [{ tag: 'default', mode: 'formula_inline', template: '' }]
  };
}
