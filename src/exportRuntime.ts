// The runtime injected into an exported document to restore interaction.
//
// ── Hover highlighting is NOT reimplemented here ─────────────────────────────
//
// 猫猫 2026-07-29: "这应该是 SNL-Basics 里就确定的行为，你到底有没有复用代码?"
// It previously WAS reimplemented — a hand-written mirror of
// `defaultHighlightStrategy` — and the copy drifted from the original: it never
// set `--snl-base-text-color`, which `.snl-single-hover [data-kind]` in
// SNL-Basics's stylesheet reads to keep nested subtrees at the base colour. So
// hovering a node highlighted its whole subtree instead of just the node.
//
// Hover now comes from SNL-Basics itself. `buildHoverRuntimeSource` bundles
// `applySnlHoverHighlight` + `findMinimalHoverRoot` (both public API since the
// 2026-07-29 hover-apply extraction) into a self-contained IIFE via esbuild.
// The panel and the exported file therefore run the SAME function, and a future
// change to the highlight policy reaches both without anyone remembering to
// copy it.
//
// What this module still owns is the part SNL-Basics has no concept of:
//   - collapse — the outline / block expand-collapse, which is Extension
//     structure (`data-snl-collapsible` / `data-snl-subtree`) and pure DOM
//     state. The React <button> is stripped on export, so the static file
//     rebuilds it from those markers.
//   - wiring — attaching listeners to `[data-entry-body]` regions.
//
// The rest of what a reader needs already travels with the document: the
// semantic `data-*` attributes SNL-Basics paints onto the rendered DOM
// (`data-kind`, `data-bindref`, `data-scope`, `data-src`, `data-name`,
// `data-tree-path`) all survive `harvestLibraryHtml`, and the highlight CSS is
// inside the stylesheet the export inlines.

import {
  COLLAPSE_GLYPH,
  COLLAPSE_TOGGLE_CLASS,
  COLLAPSE_TOGGLE_GEOMETRY,
  COLLAPSE_TOGGLE_STYLE
} from './collapseToggleContract';

/** Object style -> inline `style="..."` string. */
function toInlineStyle(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${v}`)
    .join(';');
}

/**
 * Entry module bundled into the exported page's hover runtime.
 *
 * Kept as source text (rather than a real file) so the bundling step has no
 * on-disk dependency and `buildHoverRuntimeSource` can be called from a test.
 * It re-exports SNL-Basics's own helpers onto a global the wiring code below
 * calls — no policy is expressed here, only plumbing.
 */
export const HOVER_ENTRY_SOURCE = `
import {
  applySnlHoverHighlight,
  clearSnlHoverHighlight,
  findMinimalHoverRoot
} from '@sjtu-ai4math/snl-basics/hover';

globalThis.__snlHover = {
  apply: applySnlHoverHighlight,
  clear: clearSnlHoverHighlight,
  resolveRoot: findMinimalHoverRoot
};
`.trim();

/**
 * Wiring layer. Deliberately ES5-ish and dependency-free: it is concatenated
 * after the bundled SNL-Basics hover code and runs in a bare page.
 *
 * Hover delegates every decision to `__snlHover` (i.e. to SNL-Basics). The only
 * judgement made here is WHERE to attach listeners.
 */
const RUNTIME_TEMPLATE = String.raw`
(function () {
  'use strict';

  var hover = globalThis.__snlHover;

  /**
   * Attach hover to each entry body.
   *
   * findMinimalHoverRoot walks up to the nearest semantic node and skips
   * kind="partial" wrappers, matching the panel exactly — the export used to
   * do its own naive data-kind walk here, which disagreed with the panel on
   * matrix cells and dynamic-arity delimiters.
   */
  function wireHighlighting() {
    if (!hover) return;
    var bodies = document.querySelectorAll('[data-entry-body]');
    for (var i = 0; i < bodies.length; i++) {
      (function (body) {
        body.addEventListener('mousemove', function (event) {
          var target = event.target;
          if (!target || target.nodeType !== 1) {
            hover.clear(body);
            return;
          }
          var root = hover.resolveRoot(target, body);
          if (!root || !root.hasAttribute('data-name') || root.getAttribute('data-kind') === 'partial') {
            hover.clear(body);
            return;
          }
          hover.apply(root, body);
        });
        body.addEventListener('mouseleave', function () { hover.clear(body); });
      })(bodies[i]);
    }
  }

  /**
   * Restore expand/collapse. The exporter marks each subtree wrapper with
   * data-snl-subtree and its owning row with data-snl-collapsible, so the
   * static file can rebuild the toggle the live Infoview renders as a button.
   *
   * The toggle is built to the SAME contract as the live one
   * (src/collapseToggleContract.ts): same glyphs, same geometry, same .snl-btn
   * classes, count in the tooltip rather than on the button face. Those
   * .snl-btn styles are already inside the stylesheet the export inlines.
   */
  function wireCollapse() {
    var hosts = document.querySelectorAll('[data-snl-collapsible]');
    for (var i = 0; i < hosts.length; i++) {
      (function (host) {
        // The subtree is a DIRECT child in the Entry outline, but the
        // collapsible block renderer nests its body one level down (inside
        // .snl-collapsible, after the summary row). Search descendants and
        // keep only the one whose nearest collapsible host is THIS host, so a
        // nested collapsible's body never gets adopted by its ancestor.
        var subtree = null;
        var candidates = host.querySelectorAll('[data-snl-subtree]');
        for (var c = 0; c < candidates.length; c++) {
          var owner = candidates[c].parentNode;
          while (owner && owner !== host && !owner.hasAttribute('data-snl-collapsible')) {
            owner = owner.parentNode;
          }
          if (owner === host) { subtree = candidates[c]; break; }
        }
        if (!subtree) return;

        var count = parseInt(host.getAttribute('data-snl-child-count') || '0', 10);
        // Vocabulary travels with the markup: the Entry outline hides
        // sub-entries, a collapsible block hides body parts.
        var noun = host.getAttribute('data-snl-collapse-noun');
        if (!noun) noun = 'sub-entr' + (count === 1 ? 'y' : 'ies');

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = '__TOGGLE_CLASS__';
        toggle.setAttribute('style', '__TOGGLE_STYLE__');
        // Honour the state the reader was looking at when they exported.
        toggle.setAttribute(
          'aria-expanded',
          host.getAttribute('data-snl-collapsed') === 'true' ? 'false' : 'true'
        );

        function paint() {
          var open = toggle.getAttribute('aria-expanded') === 'true';
          subtree.hidden = !open;
          toggle.textContent = open ? '__GLYPH_EXPANDED__' : '__GLYPH_COLLAPSED__';
          toggle.title = (open ? 'Collapse ' : 'Expand ') + count + ' ' + noun;
          toggle.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
        }
        toggle.addEventListener('click', function () {
          toggle.setAttribute(
            'aria-expanded',
            toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'
          );
          paint();
        });

        // The toggle's left:-20px is measured from its offset parent, which
        // must be the positioned row it belongs to. In the Entry outline that
        // is the host's first child; in a collapsible block it is the
        // .snl-collapsible__summary row (see ui.css). Mount inside that row
        // when one exists, otherwise fall back to the host.
        var row = host.querySelector(':scope > .snl-collapsible__summary');
        var mount = row || host;
        mount.insertBefore(toggle, mount.firstChild);
        paint();
      })(hosts[i]);
    }
  }

  function init() { wireHighlighting(); wireCollapse(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`.trim();

/**
 * The wiring half of the runtime, with the shared toggle contract substituted
 * in. Concatenate after the bundled hover code to get the full script.
 */
export const EXPORT_RUNTIME_WIRING_JS = RUNTIME_TEMPLATE
  .replace('__TOGGLE_CLASS__', COLLAPSE_TOGGLE_CLASS)
  .replace('__TOGGLE_STYLE__', toInlineStyle(COLLAPSE_TOGGLE_STYLE))
  .replace('__GLYPH_EXPANDED__', COLLAPSE_GLYPH.expanded)
  .replace('__GLYPH_COLLAPSED__', COLLAPSE_GLYPH.collapsed);

/**
 * Gutter reservation and the collapse rule — the styles the export genuinely
 * owns. Everything else (.snl-btn appearance, highlight colours) comes from
 * the stylesheet the export already inlines.
 *
 * The toggle hangs to the LEFT of a row (shared geometry puts it at -20px). In
 * the panel the outline already sits inside padded chrome; a bare exported page
 * does not, so a top-level row would clip the control off-screen — observed in
 * headless Chromium.
 */
export const EXPORT_RUNTIME_CSS = `
[data-snl-collapsible] { position: relative; }
.snl-export { padding-left: ${-COLLAPSE_TOGGLE_GEOMETRY.left + 8}px; }

/* Collapse MUST beat the inline style on the row it hides.
 *
 * The Entry outline renders its subtree with an inline
 * \`style="display: flex; ..."\`, and an inline declaration outranks the UA's
 * \`[hidden] { display: none }\`. So setting \`subtree.hidden = true\` marked the
 * element hidden while it stayed on screen: 猫猫 2026-07-29 saw block collapse
 * work (its body carries no inline display) and outline collapse do nothing.
 *
 * \`!important\` is the only thing that outranks an inline declaration without
 * mutating author markup, so the rule is scoped as tightly as possible: only
 * the subtree of a collapsible, only while hidden. */
[data-snl-collapsible] > [data-snl-subtree][hidden],
[data-snl-collapsible] [data-snl-subtree][hidden] { display: none !important; }
`.trim();
