// The runtime injected into an exported document to restore interaction.
//
// Deliberately NOT the SNL-Basics React bundle. That bundle renders Entries and
// talks to the VS Code host over `postMessage`; in a static file there is no
// host, no macro query endpoint, and nothing left to render — the markup is
// already final. Shipping it would add ~60 KB of code whose entry points are
// all unreachable.
//
// What actually drives SNL interaction is the semantic `data-*` attributes
// SNL-Basics paints onto the rendered DOM, and `harvestLibraryHtml` keeps every
// one of them. Verified in headless Chromium against Fulcrum-Notes-SNL:
// `data-kind`, `data-bindref`, `data-scope`, `data-src`, `data-name`,
// `data-tree-path` all survive. So the export ships a small vanilla script that
// reimplements the two behaviours a *reader* needs, against those attributes:
//
//   1. hover highlight — mirrors `defaultHighlightStrategy`: the hovered node
//      gets `.snl-single-hover`, and hovering a bvar/binder lights up its whole
//      binding scope via `.snl-bvar-scope` / `.snl-binder-decl`.
//   2. collapse — the outline's expand/collapse, which is pure DOM state and
//      was previously lost because the export stripped every <button>.
//
// The highlight CSS already travels with the document (SNL-Basics emits it as
// an inline <style> inside the entry body), so this script only toggles the
// classes that stylesheet already targets.
//
// The collapse toggle's APPEARANCE is not reinvented here either: glyphs,
// geometry, classes and label wording all come from
// `src/collapseToggleContract.ts`, the same module the live React
// toggle uses. The `.snl-btn` styles those classes reference are already inside
// the built stylesheet the export inlines.

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

const RUNTIME_TEMPLATE = String.raw`
(function () {
  'use strict';

  var SINGLE = 'snl-single-hover';
  var BVAR_SCOPE = 'snl-bvar-scope';
  var BINDER_DECL = 'snl-binder-decl';

  function bindRefOf(el) {
    return el.getAttribute('data-bindref') || el.getAttribute('data-bindRef');
  }

  function clear(root) {
    var sel = '.' + SINGLE + ', .' + BVAR_SCOPE + ', .' + BINDER_DECL;
    var marked = root.querySelectorAll(sel);
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove(SINGLE, BVAR_SCOPE, BINDER_DECL);
    }
  }

  /** Mirror of SNL-Basics defaultHighlightStrategy, DOM-only. */
  function highlight(container, target) {
    clear(container);
    if (!target) return;
    target.classList.add(SINGLE);

    var kind = target.getAttribute('data-kind');
    var ref = bindRefOf(target);
    if ((kind !== 'bvar' && kind !== 'binder') || !ref) return;

    var scopeRoot = container;
    var scopes = container.querySelectorAll('[data-scope="binder"]');
    for (var s = 0; s < scopes.length; s++) {
      if (bindRefOf(scopes[s]) === ref) { scopeRoot = scopes[s]; break; }
    }

    var all = scopeRoot.querySelectorAll('[data-kind="bvar"], [data-kind="binder"]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (bindRefOf(el) !== ref) continue;
      el.classList.add(el.getAttribute('data-kind') === 'bvar' ? BVAR_SCOPE : BINDER_DECL);
    }
  }

  /** Innermost semantic node under the pointer — the minimal hover root. */
  function resolveTarget(node, container) {
    var el = node;
    while (el && el !== container) {
      if (el.nodeType === 1 && el.hasAttribute('data-kind')) return el;
      el = el.parentNode;
    }
    return null;
  }

  function wireHighlighting() {
    var bodies = document.querySelectorAll('[data-entry-body]');
    for (var i = 0; i < bodies.length; i++) {
      (function (body) {
        body.addEventListener('mousemove', function (event) {
          highlight(body, resolveTarget(event.target, body));
        });
        body.addEventListener('mouseleave', function () { clear(body); });
      })(bodies[i]);
    }
  }

  /**
   * Restore expand/collapse. The exporter marks each subtree wrapper with
   * data-snl-subtree and its owning row with data-snl-collapsible, so the
   * static file can rebuild the toggle the live Infoview renders as a button.
   *
   * The toggle is built to the SAME contract as the live one
   * (webview/src/components/collapseToggle.ts): same glyphs, same geometry,
   * same .snl-btn classes, count in the tooltip rather than on the button
   * face. Those .snl-btn styles are already inside the stylesheet the export
   * inlines, so this reuses them instead of restyling from scratch.
   */
  function wireCollapse() {
    var hosts = document.querySelectorAll('[data-snl-collapsible]');
    for (var i = 0; i < hosts.length; i++) {
      (function (host) {
        var subtree = null;
        for (var c = 0; c < host.children.length; c++) {
          if (host.children[c].hasAttribute('data-snl-subtree')) {
            subtree = host.children[c];
            break;
          }
        }
        if (!subtree) return;

        var count = parseInt(host.getAttribute('data-snl-child-count') || '0', 10);
        var noun = 'sub-entr' + (count === 1 ? 'y' : 'ies');

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = '__TOGGLE_CLASS__';
        toggle.setAttribute('style', '__TOGGLE_STYLE__');
        toggle.setAttribute('aria-expanded', 'true');

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

        host.insertBefore(toggle, host.firstChild);
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
 * The script emitted into the exported page.
 *
 * Placeholders are filled from `src/collapseToggleContract.ts` —
 * the same module the live React toggle uses — so glyphs, geometry, classes
 * and label wording cannot drift between the two surfaces.
 */
export const EXPORT_RUNTIME_JS = RUNTIME_TEMPLATE
  .replace('__TOGGLE_CLASS__', COLLAPSE_TOGGLE_CLASS)
  .replace('__TOGGLE_STYLE__', toInlineStyle(COLLAPSE_TOGGLE_STYLE))
  .replace('__GLYPH_EXPANDED__', COLLAPSE_GLYPH.expanded)
  .replace('__GLYPH_COLLAPSED__', COLLAPSE_GLYPH.collapsed);

/**
 * Gutter reservation, the one style the export genuinely needs on its own.
 *
 * The toggle hangs to the LEFT of a row (shared geometry puts it at -20px). In
 * the panel the outline already sits inside padded chrome; a bare exported page
 * does not, so a top-level row would clip the control off-screen — observed in
 * headless Chromium. Everything else (.snl-btn appearance) comes from the
 * stylesheet the export already inlines.
 */
export const EXPORT_RUNTIME_CSS = `
[data-snl-collapsible] { position: relative; }
.snl-export { padding-left: ${-COLLAPSE_TOGGLE_GEOMETRY.left + 8}px; }
`.trim();
