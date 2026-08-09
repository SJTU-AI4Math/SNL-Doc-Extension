import type { SnlMacro, SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';

/** Maximum number of numbered arguments rendered in a Macro preview. */
export const MAX_MACRO_PREVIEW_ARGS = 8;

/**
 * Render-only numbered argument Macros shared by the Macro editor and Package
 * table. `\mathord` keeps KaTeX's trailing atom spacing outside the visible
 * placeholder frame.
 */
export const MACRO_PREVIEW_ARGUMENTS: Record<string, SnlMacro> = {};
for (let index = 0; index < MAX_MACRO_PREVIEW_ARGS; index += 1) {
  MACRO_PREVIEW_ARGUMENTS[`_snl_arg_${index}`] = {
    name: `_snl_arg_${index}`,
    description: `Argument placeholder ${index}`,
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    tags: [],
    styles: [
      {
        style_name: 'default',
        mode: 'formula_inline',
        template: `\\mathord{\\htmlClass{snlArgPlaceholder}{${index}}}`,
        tags: []
      }
    ]
  };
}

export function macroPreviewArgumentNode(index: number): SnlSyntaxTree {
  return {
    macro_name: `_snl_arg_${index}`,
    kind: 'argPlaceholder',
    mdata: null,
    children: []
  };
}

/** Max unescaped `#N` child index in a template, or -1 when none. */
export function maxMacroTemplateChildIndex(template: string): number {
  let max = -1;
  const pattern = /(?<!\\)#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    const index = Number(match[1]);
    if (Number.isFinite(index) && index > max) max = index;
  }
  return max;
}
