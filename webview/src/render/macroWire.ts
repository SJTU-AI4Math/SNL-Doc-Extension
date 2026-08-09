import type { Localized, SnlMacro, SnlMacroRecord, SnlMacroStyle } from '@sjtu-ai4math/snl-basics';

/** Strict Macro v8 shape received from the host. */
interface WireMacroStyleBase {
  style_name: string;
  separator?: string;
  tags: string[];
}
export type WireMacroStyle =
  | (WireMacroStyleBase & {
      mode: 'formula_inline' | 'formula_display';
      template: string;
      block_template_name?: never;
    })
  | (WireMacroStyleBase & {
      mode: 'block';
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
  if (style.mode === 'block') {
    return {
      ...base,
      mode: 'block',
      template: style.template,
      ...(style.block_template_name ? { block_template_name: style.block_template_name } : {})
    };
  }
  return {
    ...base,
    mode: style.mode,
    template: style.template
  };
}

/** Convert keyed wire entries without invoking Object.prototype setters. */
export function wireMacroEntriesToRenderable(
  entries: Iterable<readonly [string, WireMacro]>
): SnlMacroRecord {
  return Object.fromEntries(
    Array.from(entries, ([name, macro]) => [name, wireMacroToRenderable(macro)] as const)
  );
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
