import {
  defaultHighlightStrategy,
  parseSnlSyntaxTree,
  resolveStyle,
  resolve_style_template,
  type SnlHighlightStrategy,
  type SnlSyntaxTree
} from '@sjtu-ai4math/snl-basics';
import type { MacroRecord } from './macroData';

/** Consumer-only presentation fallback, not a binding rewrite or Lean inference.
 * Authority: actual Entry SNL explicitly selects Type.annotation[nameless],
 * and the actual catalog's selected formula template is exactly child 1.
 * Keep this deliberately narrower than a general omitted-argument heuristic.
 */
export function createAnnotationHighlightStrategy(
  snl: string | undefined,
  macros: MacroRecord | undefined,
  language: string
): SnlHighlightStrategy {
  const domains = new Map<string, string>();
  if (snl && macros && Object.hasOwn(macros, 'Type.annotation')) {
    try {
      const tree = parseSnlSyntaxTree(snl);
      const macro = macros['Type.annotation'];
      const visit = (node: SnlSyntaxTree, path: string): void => {
        if (node.macro_name === 'Type.annotation' && !node.env_mode &&
            node.style_name === 'nameless' && node.children[0]?.kind === 'binder' &&
            node.children[1] && macro?.name === 'Type.annotation') {
          const style = resolveStyle(node, macro, language);
          const template = resolve_style_template(style, undefined, language, macro.dynamic_arity);
          if ((template.mode === 'formula_inline' || template.mode === 'formula_display') &&
              template.body.trim() === '#1') {
            const prefix = path ? `${path}.` : '';
            domains.set(`${prefix}0`, `${prefix}1`);
          }
        }
        node.children.forEach((child, index) => {
          if (child) visit(child, path ? `${path}.${index}` : String(index));
        });
      };
      visit(tree, '');
    } catch {
      // Parsing/style errors belong to Basics's normal diagnostics, never a
      // guessed presentation map (including any partial map from this traversal).
      domains.clear();
    }
  }
  if (domains.size === 0) return defaultHighlightStrategy;
  return {
    computeHighlightSet(target, container, index, phase = 2) {
      const base = defaultHighlightStrategy.computeHighlightSet(target, container, index, phase);
      if (phase < 1 || target.dataset.kind !== 'bvar' || !container.contains(target)) return base;
      const surface = target.closest('.katex-panel');
      // Basics passes the output element inside its panel, not the panel itself.
      if (!surface || container.closest('.katex-panel') !== surface) return base;
      const source = target.dataset.sourcePath;
      const domain = source === undefined ? undefined : domains.get(source);
      if (domain === undefined) return base;
      const local = (element: HTMLElement): boolean => element.closest('.katex-panel') === surface;
      const visible = (element: HTMLElement): boolean => {
        if (!local(element) || element.closest('.katex-mathml')) return false;
        const style = element.ownerDocument.defaultView?.getComputedStyle(element);
        return style?.visibility !== 'hidden' && style?.visibility !== 'collapse' &&
          style?.display !== 'none' && Array.from(element.getClientRects()).some(r => r.width > 0 && r.height > 0);
      };
      const anchors = Array.from(container.querySelectorAll<HTMLElement>('[data-tree-path]')).filter(local);
      if (base.binderDecl.some(visible) || anchors.some(e => e.dataset.treePath === source && visible(e))) return base;
      const visibleDomains = anchors.filter(e => e.dataset.treePath === domain && visible(e));
      return visibleDomains.length === 0 ? base : {
        ...base,
        binderDecl: [...base.binderDecl, ...visibleDomains]
      };
    }
  };
}
