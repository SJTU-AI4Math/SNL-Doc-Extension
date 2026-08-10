import type { SnlMacro, SnlMacroRecord, SnlMacroStyle } from '@sjtu-ai4math/snl-basics';

/** Complete Macro v11 projection owned by the Extension. Consumer backends and
 * presentation data remain opaque fields here and are preserved in storage. */
export interface WireMacroTemplate {
  [key: string]: unknown;
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block';
  body: string;
  separator?: string;
  block_template_name?: string;
}

export interface WireLocalizedTemplate {
  type: 'i18n';
  default_language: string;
  values: Record<string, WireMacroTemplate | undefined>;
}

/** Strict Macro v11 Style received from the host. Identity/tags are invariant. */
export interface WireMacroStyle {
  style_name: string;
  tags: string[];
  template: WireMacroTemplate | WireLocalizedTemplate;
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

function isLocalizedTemplate(
  template: WireMacroStyle['template']
): template is WireLocalizedTemplate {
  return template.type === 'i18n';
}

/** Resolve one complete projection. No render field may cross locale boundaries. */
export function resolveWireTemplate(
  template: WireMacroStyle['template'],
  language: string
): WireMacroTemplate {
  if (!isLocalizedTemplate(template)) return template;
  const selected = Object.hasOwn(template.values, language)
    ? template.values[language]
    : undefined;
  if (selected !== undefined) return selected;
  const fallback = Object.hasOwn(template.values, template.default_language)
    ? template.values[template.default_language]
    : undefined;
  if (fallback !== undefined) return fallback;
  const first = Object.values(template.values).find(
    (projection): projection is WireMacroTemplate => projection !== undefined
  );
  if (!first) throw new Error('localized Macro template has no projection');
  return first;
}

/**
 * Adapt Macro v11 to the published SNL-Basics 0.2 renderer contract. Localization
 * is resolved before adaptation so mode/body/separator/block renderer are chosen
 * atomically even though 0.2 stores those fields at Style scope.
 */
function wireStyleToRenderable(style: WireMacroStyle, language: string): SnlMacroStyle {
  const projection = resolveWireTemplate(style.template, language);
  return {
    style_name: style.style_name,
    tags: style.tags,
    mode: projection.mode,
    template: projection.body,
    ...(projection.separator === undefined ? {} : { separator: projection.separator }),
    ...(projection.mode === 'block' && projection.block_template_name !== undefined
      ? { block_template_name: projection.block_template_name }
      : {})
  } as SnlMacroStyle;
}

/** Convert keyed wire entries without invoking Object.prototype setters. */
export function wireMacroEntriesToRenderable(
  entries: Iterable<readonly [string, WireMacro]>,
  language: string
): SnlMacroRecord {
  return Object.fromEntries(
    Array.from(entries, ([name, macro]) => [name, wireMacroToRenderable(macro, language)] as const)
  );
}

export function wireMacroToRenderable(macro: WireMacro, language: string): SnlMacro {
  const styles: SnlMacroStyle[] = Array.isArray(macro.styles)
    ? macro.styles.map((style) => wireStyleToRenderable(style, language))
    : [];
  return {
    name: macro.name,
    description: macro.description,
    source: { entries: macro.source.entries, urls: macro.source.urls },
    ...(macro.kind ? { kind: macro.kind } : {}),
    dynamic_arity: !!macro.dynamic_arity,
    tags: macro.tags,
    styles: styles.length > 0
      ? styles
      : [{ style_name: 'default', mode: 'formula_inline', template: '', tags: [] }]
  };
}
