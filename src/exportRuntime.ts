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

/** Emitted verbatim into the exported page. Keep it dependency-free ES5-ish. */
export const EXPORT_RUNTIME_JS = String.raw`
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
   */
  function wireCollapse() {
    var hosts = document.querySelectorAll('[data-snl-collapsible]');
    for (var i = 0; i < hosts.length; i++) {
      (function (host) {
        var subtree = host.querySelector(':scope > [data-snl-subtree]');
        if (!subtree) return;

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'snl-export-toggle';
        toggle.setAttribute('aria-expanded', 'true');

        var count = host.getAttribute('data-snl-child-count') || '';
        function paint() {
          var open = toggle.getAttribute('aria-expanded') === 'true';
          subtree.hidden = !open;
          toggle.textContent = (open ? '\u25be' : '\u25b8') + (count ? ' ' + count : '');
          toggle.title = (open ? 'Collapse' : 'Expand') + ' subtree';
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

/** Styling for the collapse control the runtime injects. */
export const EXPORT_RUNTIME_CSS = `
.snl-export-toggle {
  position: absolute;
  left: -1.5rem;
  top: 0.35rem;
  min-width: 1.25rem;
  padding: 0 0.25rem;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  font: inherit;
  font-size: 0.8rem;
  line-height: 1.4;
  cursor: pointer;
}
.snl-export-toggle:hover { opacity: 1; background: rgba(0, 0, 0, 0.06); }
[data-snl-collapsible] { position: relative; }
/*
 * The toggle hangs in the gutter to the left of a row. A top-level row sits
 * flush with the page edge, so without room the control is clipped off-screen
 * (observed in headless Chromium). Reserve that gutter on the export body.
 */
.snl-export { padding-left: 1.75rem; }
`.trim();
