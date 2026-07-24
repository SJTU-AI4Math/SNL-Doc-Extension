import type { Localized, SnlMacro, SnlMacroStyle } from '@sjtu-ai4math/snl-basics';

/** Strict Macro v7 shape received from the host. */
interface WireMacroStyleBase {
  style_name: string;
  separator?: string;
  tags: string[];
}
export type WireMacroStyle =
  | (WireMacroStyleBase & {
      mode: 'formula_inline' | 'formula_display' | 'block';
      template: string;
      block_template_name?: string;
    })
  | (WireMacroStyleBase & {
      mode: 'text';
      template: Localized<string, string>;
      block_template_name?: never;
    });
export interface WireMacro {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind?: string;
  dynamic_arity: boolean;
  styles: WireMacroStyle[];
  tags: string[];
}

/** Extension-owned style → discriminated Basics render style. */
function wireStyleToRenderable(style: WireMacroStyle): SnlMacroStyle {
  const base = {
    style_name: style.style_name,
    ...(style.separator !== undefined ? { separator: style.separator } : {}),
    tags: style.tags
  };
  if (style.mode === 'text') {
    return { ...base, mode: 'text', template: style.template };
  }
  const invariant = style as Extract<WireMacroStyle, {
    mode: 'formula_inline' | 'formula_display' | 'block';
  }>;
  return {
    ...base,
    mode: invariant.mode,
    template: invariant.template,
    ...(invariant.mode === 'block' && invariant.block_template_name
      ? { block_template_name: invariant.block_template_name }
      : {})
  };
}

/** Extension-owned backends → SNL-Basics render shape for every webview. */
export function wireMacroToRenderable(macro: WireMacro): SnlMacro {
  const styles: SnlMacroStyle[] = Array.isArray(macro.styles)
    ? macro.styles.map(wireStyleToRenderable)
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
