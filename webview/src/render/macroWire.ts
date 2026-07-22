import type { SnlMacro, SnlMacroStyle } from '@snl-basics/react';

/** Strict Macro v7 shape received from the host. */
export interface WireMacroStyle {
  style_name: string;
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block';
  template: string;
  separator?: string;
  block_template_name?: string;
  tags: string[];
}
export interface WireMacro {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind?: string;
  dynamic_arity: boolean;
  styles: WireMacroStyle[];
  tags: string[];
}

/** Extension-owned backends → SNL-Basics render shape for every webview. */
export function wireMacroToRenderable(macro: WireMacro): SnlMacro {
  const styles: SnlMacroStyle[] = Array.isArray(macro.styles)
    ? macro.styles.map((style) => ({
          style_name: style.style_name,
          mode: style.mode,
          template: style.template,
          ...(style.separator !== undefined ? { separator: style.separator } : {}),
          ...(style.mode === 'block' && style.block_template_name
            ? { block_template_name: style.block_template_name }
            : {}),
          tags: style.tags
        }))
    : [];
  return {
    name: macro.name,
    description: macro.description,
    source: {
      entries: macro.source.entries,
      urls: macro.source.urls
    },
    ...(macro.kind ? { kind: macro.kind } : {}),
    dynamic_arity: !!macro.dynamic_arity,
    tags: macro.tags,
    styles: styles.length > 0
      ? styles
      : [{ style_name: 'default', mode: 'formula_inline', template: '', tags: [] }]
  };
}
