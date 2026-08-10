import type { SnlMacro, SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { analyzeLatexTemplatePlaceholders } from '../../../src/templatePlaceholders';

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

/** Max effective `#N` child index in a valid template, or -1 when none/invalid. */
export function maxMacroTemplateChildIndex(template: string): number {
  const analysis = analyzeLatexTemplatePlaceholders(template);
  return analysis.invalid ? -1 : analysis.positional_arity - 1;
}
