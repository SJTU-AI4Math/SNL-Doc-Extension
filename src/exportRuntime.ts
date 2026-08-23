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

  // Pre-rendered popover fragments, keyed by Entry id. Baked in at export
  // time (see webview/src/export/popoverPrerender.tsx) because rendering an
  // Entry needs React + KaTeX, which would blow this runtime up by ~40x.
  // Missing global = the export was written without popovers; degrade to no
  // popovers rather than throwing and killing collapse/highlight too.
  function popoverData() {
    var data = globalThis.__SNL_POPOVERS__;
    return data && typeof data === 'object' ? data : null;
  }

  var POPOVER_DELAY_MS = 1000;
  var POPOVER_FADE_MS = 150;
  var POPOVER_MAX_WIDTH = 720;
  // Grace period for the pointer to cross the gap between the anchor and the
  // popover, or between a popover and the one it spawned.
  var POPOVER_CLOSE_MS = 180;

  /**
   * Hover popovers over [data-src] references.
   *
   * A stack, not a single layer: a popover body contains references of its
   * own, so hovering one opens a child popover on top. Closing is depth-based
   * — leaving level N disposes N and everything above it — which is the only
   * rule that keeps the stack consistent when the pointer jumps backwards
   * several levels at once.
   */
  function wirePopovers() {
    if (globalThis.__snlExportPopoverCleanup) globalThis.__snlExportPopoverCleanup();
    var data = popoverData();
    if (!data) return;

    var stack = [];        // { el, depth, anchor }
    var bindings = [];     // delegated listeners on persistent export surfaces
    var closeTimer = null;
    var openTimer = null;
    var pendingAnchor = null;

    function cancelOpen() {
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      pendingAnchor = null;
    }

    function disposeFrom(depth) {
      while (stack.length > depth) {
        (function (layer) {
          layer.el.style.opacity = '0';
          layer.el.style.pointerEvents = 'none';
          // Remove only after the fade so the reader sees it leave.
          setTimeout(function () {
            if (layer.el.parentNode) layer.el.parentNode.removeChild(layer.el);
          }, POPOVER_FADE_MS);
        })(stack.pop());
      }
    }

    function scheduleClose(depth) {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(function () {
        var closeDepth = depth;
        while (closeDepth < stack.length && stack[closeDepth].pinned) closeDepth += 1;
        disposeFrom(closeDepth);
      }, POPOVER_CLOSE_MS);
    }

    function keepOpen() {
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }

    /** Keep the panel inside the viewport, biased below-right of the pointer. */
    function place(el, x, y) {
      var vw = window.innerWidth || 1024;
      var vh = window.innerHeight || 768;
      var rect = el.getBoundingClientRect();
      var w = rect.width || POPOVER_MAX_WIDTH;
      var h = rect.height || 0;
      var left = x + 12;
      var top = y + 16;
      if (left + w > vw - 8) left = Math.max(8, vw - 8 - w);
      // Flip above the pointer rather than clamping to the bottom edge, so the
      // panel never covers the very thing being hovered.
      if (top + h > vh - 8) top = Math.max(8, y - 12 - h);
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    function openPopover(entryId, depth, x, y, anchor, pinned) {
      var html = Object.prototype.hasOwnProperty.call(data, entryId)
        ? data[entryId]
        : null;
      if (html === null || html === undefined) return;
      disposeFrom(depth);

      var el = document.createElement('div');
      el.className = 'snl-export-popover';
      el.setAttribute('data-snl-popover', entryId);
      el.setAttribute('data-snl-popover-depth', String(depth));
      if (pinned) el.setAttribute('data-snl-popover-pinned', 'true');
      el.style.opacity = '0';
      el.innerHTML = html;
      // EntrySurface cards carry inline width:100% with content-box sizing.
      // Their border would otherwise extend beyond the measured shell and be
      // clipped by overflow-x:hidden (5px in the user's integrated HTML).
      if (el.firstElementChild) el.firstElementChild.style.boxSizing = 'border-box';
      document.body.appendChild(el);
      // Popover HTML is inserted lazily, after the document-wide initializer
      // has run. Restore stripped React controls inside this render scope now,
      // before the new surface can receive interaction.
      wireCollapse(el);
      place(el, x, y);

      var layer = { el: el, depth: depth, anchor: anchor, pinned: !!pinned };
      stack.push(layer);

      el.addEventListener('mouseenter', keepOpen);
      el.addEventListener('mouseleave', function () { scheduleClose(depth); });
      // A popover is a hover surface in its own right: bind the same handler
      // so nested references keep working to arbitrary depth.
      bind(el, depth + 1);
      // Highlighting inside a popover body must work too.
      wireHighlightingIn(el);

      // Fade in on the next frame; setting opacity in the same tick as the
      // insert would skip the transition entirely.
      setTimeout(function () { el.style.opacity = '1'; }, 0);
    }

    /** Attach reference-hover handling inside container, at the given depth. */
    function bind(container, depth) {
      function referenceAncestor(start) {
        var node = start;
        while (node && node !== container && node.nodeType === 1) {
          if (node.hasAttribute && node.hasAttribute('data-src')) return node;
          node = node.parentNode;
        }
        return null;
      }
      function onMouseOver(event) {
        var node = referenceAncestor(event.target);
        if (!node) return;
        var entryId = node.getAttribute('data-src');
        if (!entryId) return;
        keepOpen();
        // Already showing this exact anchor's popover — nothing to redo.
        if (stack.length > depth && stack[depth].anchor === node) return;
        if (pendingAnchor === node) return;
        cancelOpen();
        pendingAnchor = node;
        var x = event.clientX;
        var y = event.clientY;
        openTimer = setTimeout(function () {
          openTimer = null;
          pendingAnchor = null;
          openPopover(entryId, depth, x, y, node, false);
        }, POPOVER_DELAY_MS);
      }
      function onMouseOut(event) {
        // Delegating at the whole Entry/popover container must not turn that
        // whole region into the anchor's hitbox. Leaving a [data-src] for an
        // ordinary sibling is a real leave: cancel a not-yet-open timer and
        // close its layer. The old container.contains(to) check returned in
        // precisely that case, so a popover stayed forever — or appeared a
        // second AFTER the pointer had already left the reference.
        var anchor = referenceAncestor(event.target);
        if (!anchor) return;
        var to = event.relatedTarget;
        if (to && anchor.contains(to)) return;
        cancelOpen();
        scheduleClose(depth);
      }
      function onClick(event) {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        var node = referenceAncestor(event.target);
        if (!node) return;
        var entryId = node.getAttribute('data-src');
        if (!entryId || !Object.prototype.hasOwnProperty.call(data, entryId)) return;
        event.preventDefault();
        event.stopPropagation();
        cancelOpen();
        keepOpen();
        for (var i = 0; i < depth && i < stack.length; i++) {
          stack[i].pinned = true;
          stack[i].el.setAttribute('data-snl-popover-pinned', 'true');
        }
        openPopover(entryId, depth, event.clientX, event.clientY, node, true);
      }
      function onKeyDown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        var node = referenceAncestor(event.target);
        if (!node || node.getAttribute('data-snl-keyboard-activation') !== 'true') return;
        event.preventDefault();
        node.click();
      }
      container.addEventListener('mouseover', onMouseOver);
      container.addEventListener('mouseout', onMouseOut);
      container.addEventListener('click', onClick);
      container.addEventListener('keydown', onKeyDown);
      bindings.push({
        container: container,
        mouseover: onMouseOver,
        mouseout: onMouseOut,
        click: onClick,
        keydown: onKeyDown
      });
    }

    var main = document.querySelector('.snl-export') || document.body;
    bind(main, 0);
    function dismissPinned(event) {
      var target = event.target;
      if (target && target.closest) {
        if (target.closest('.snl-export-popover')) return;
        var reference = target.closest('[data-src]');
        if (reference) {
          var entryId = reference.getAttribute('data-src');
          if (entryId && Object.prototype.hasOwnProperty.call(data, entryId)) return;
        }
      }
      cancelOpen();
      disposeFrom(0);
    }
    document.addEventListener('click', dismissPinned);
    function dismissOnEscape(event) {
      if (event.key !== 'Escape') return;
      cancelOpen();
      disposeFrom(0);
    }
    document.addEventListener('keydown', dismissOnEscape);
    globalThis.__snlExportPopoverCleanup = function () {
      document.removeEventListener('click', dismissPinned);
      document.removeEventListener('keydown', dismissOnEscape);
      for (var i = 0; i < bindings.length; i++) {
        var binding = bindings[i];
        binding.container.removeEventListener('mouseover', binding.mouseover);
        binding.container.removeEventListener('mouseout', binding.mouseout);
        binding.container.removeEventListener('click', binding.click);
        binding.container.removeEventListener('keydown', binding.keydown);
      }
      bindings = [];
      cancelOpen();
      if (closeTimer) clearTimeout(closeTimer);
      disposeFrom(0);
      globalThis.__snlExportPopoverCleanup = null;
    };
  }

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
    wireHighlightingIn(document);
  }

  function wireHighlightingIn(scope) {
    if (!hover) return;
    var bodies = scope.querySelectorAll('[data-entry-body]');
    for (var i = 0; i < bodies.length; i++) {
      (function (body) {
        body.addEventListener('mousemove', function (event) {
          var target = event.target;
          if (!target || target.nodeType !== 1) {
            hover.clear(body);
            return;
          }
          var root = hover.resolveRoot(target, body);
          var kind = root && root.getAttribute('data-kind');
          if (!root || !root.hasAttribute('data-name') || kind === 'sub' || kind === 'partial') {
            hover.clear(body);
            return;
          }
          hover.apply(root, body);
        });
        body.addEventListener('mouseleave', function () { hover.clear(body); });
      })(bodies[i]);
    }
  }

  /** Restore stripped toggles from exporter markers. */
  function wireCollapse(root) {
    var boundary = root || document;
    var hosts = boundary.querySelectorAll('[data-snl-collapsible]');
    var records = [];
    var controlGroups = [];

    function ownedSubtree(host) {
      var candidates = host.querySelectorAll('[data-snl-subtree]');
      for (var c = 0; c < candidates.length; c++) {
        var owner = candidates[c].parentNode;
        while (owner && owner !== host && !owner.hasAttribute('data-snl-collapsible')) {
          owner = owner.parentNode;
        }
        if (owner === host) return candidates[c];
      }
      return null;
    }

    function scopeFor(node) {
      var scope = node.closest && node.closest('.snl-collapsible-scope');
      if (scope && (boundary === document || boundary === scope || boundary.contains(scope))) return scope;
      // A lazy popover is an independent exported render surface. Falling back
      // to document.querySelector('.snl-export') here would couple its depth
      // shortcuts and controls to the main page.
      return boundary === document
        ? document.querySelector('.snl-export') || document.body
        : boundary;
    }

    function updateGroups(scope) {
      for (var g = 0; g < controlGroups.length; g++) {
        var group = controlGroups[g];
        if (group.scope !== scope) continue;
        var canExpand = false;
        var canCollapse = false;
        for (var r = 0; r < group.records.length; r++) {
          if (group.records[r].toggle.getAttribute('aria-expanded') === 'true') canCollapse = true;
          else canExpand = true;
        }
        group.expand.disabled = !canExpand;
        group.collapse.disabled = !canCollapse;
      }
    }

    function setOpen(record, open) {
      record.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      record.subtree.hidden = !open;
      record.toggle.textContent = open ? '__GLYPH_EXPANDED__' : '__GLYPH_COLLAPSED__';
      var action = open ? (record.zh ? '收起' : 'Collapse') : (record.zh ? '展开' : 'Expand');
      record.toggle.title = action + ' ' + record.count + ' ' + record.noun;
      if (record.level === null) {
        record.toggle.setAttribute('aria-label', action);
      } else {
        var summary = record.summary;
        record.toggle.setAttribute(
          'aria-label',
          record.zh
            ? action + '可折叠块' + (summary ? ' ' + summary : '')
            : action + ' collapsible block' + (summary ? ' ' + summary : '')
        );
      }
    }

    for (var i = 0; i < hosts.length; i++) {
      (function (host, index) {
        if (host.__snlExportCollapseRecord) {
          records.push(host.__snlExportCollapseRecord);
          return;
        }
        var subtree = ownedSubtree(host);
        if (!subtree) return;
        var count = parseInt(host.getAttribute('data-snl-child-count') || '0', 10);
        var zh = (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
        var noun = host.getAttribute('data-snl-collapse-noun');
        if (!noun) noun = zh ? '个子条目' : 'sub-entr' + (count === 1 ? 'y' : 'ies');
        var levelText = host.getAttribute('data-snl-collapse-level');
        var level = levelText === null ? null : parseInt(levelText, 10);
        if (level !== null && !isFinite(level)) level = null;

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = '__TOGGLE_CLASS__';
        toggle.setAttribute('style', '__TOGGLE_STYLE__');
        var bodyId = subtree.id || 'snl-export-collapse-' + index;
        subtree.id = bodyId;
        toggle.setAttribute('aria-controls', bodyId);
        toggle.setAttribute(
          'aria-expanded',
          host.getAttribute('data-snl-collapsed') === 'true' ? 'false' : 'true'
        );
        var row = host.querySelector(':scope > .snl-collapsible__summary');
        var mount = row || host;
        var record = {
          host: host,
          subtree: subtree,
          toggle: toggle,
          row: mount,
          summary: mount.textContent && mount.textContent.trim(),
          count: count,
          noun: noun,
          zh: zh,
          level: level,
          scope: scopeFor(host)
        };
        records.push(record);
        host.__snlExportCollapseRecord = record;
        toggle.addEventListener('click', function (event) {
          var nextOpen = toggle.getAttribute('aria-expanded') !== 'true';
          if (event.ctrlKey && record.level !== null) {
            event.preventDefault();
            event.stopPropagation();
            var peerHosts = record.scope.querySelectorAll('[data-snl-collapsible]');
            for (var r = 0; r < peerHosts.length; r++) {
              var peer = peerHosts[r].__snlExportCollapseRecord;
              if (peer && peer.scope === record.scope && peer.level === record.level) setOpen(peer, nextOpen);
            }
          } else {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              event.stopPropagation();
            }
            setOpen(record, nextOpen);
          }
          updateGroups(record.scope);
        });
        mount.insertBefore(toggle, mount.firstChild);
        setOpen(record, toggle.getAttribute('aria-expanded') === 'true');
      })(hosts[i], i);
    }

    var controls = boundary.querySelectorAll('[data-snl-collapsible-controls]');
    for (var j = 0; j < controls.length; j++) {
      (function (mount) {
        if (mount.__snlExportCollapseControls) return;
        var scope = scopeFor(mount);
        var scopedRecords = [];
        for (var r = 0; r < records.length; r++) {
          if (records[r].scope === scope && records[r].level !== null) scopedRecords.push(records[r]);
        }
        if (scopedRecords.length === 0) return;
        var zh = (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
        var scopeLabel = scope.getAttribute && scope.getAttribute('data-snl-collapsible-scope-label') ||
          (zh ? '渲染内容' : 'rendered content');
        var expand = document.createElement('button');
        var collapse = document.createElement('button');
        expand.type = collapse.type = 'button';
        expand.className = collapse.className = 'snl-btn snl-btn--sm snl-btn--secondary';
        expand.textContent = zh ? '全部展开' : 'Expand all';
        collapse.textContent = zh ? '全部收起' : 'Collapse all';
        expand.setAttribute('aria-label', zh
          ? '展开' + scopeLabel + '中的所有可折叠块'
          : 'Expand all collapsible blocks in ' + scopeLabel);
        collapse.setAttribute('aria-label', zh
          ? '收起' + scopeLabel + '中的所有可折叠块'
          : 'Collapse all collapsible blocks in ' + scopeLabel);
        function applyAll(open) {
          return function (event) {
            event.preventDefault();
            event.stopPropagation();
            for (var k = 0; k < scopedRecords.length; k++) setOpen(scopedRecords[k], open);
            updateGroups(scope);
          };
        }
        expand.addEventListener('click', applyAll(true));
        collapse.addEventListener('click', applyAll(false));
        mount.appendChild(expand);
        mount.appendChild(collapse);
        mount.__snlExportCollapseControls = true;
        controlGroups.push({
          scope: scope,
          records: scopedRecords,
          expand: expand,
          collapse: collapse
        });
        updateGroups(scope);
      })(controls[j]);
    }
  }

  /**
   * Hash routing for standalone exports.
   *
   * A hash route survives file:// refresh and arbitrary static-host base paths;
   * unlike a history route it needs no server fallback. Headless exporters can
   * provide stable graph-node identities via data-snl-route-id. Older/live DOM
   * snapshots fall back to their Entry id.
   */
  function wireRoutes() {
    var main = document.querySelector('.snl-export');
    if (!main) return;
    var candidates = main.querySelectorAll('[data-snl-route-id], [data-entry-id]');
    var routeBody = main.querySelector('[data-snl-export-body]');
    var outlet = document.createElement('div');
    outlet.setAttribute('data-snl-route-outlet', '');
    outlet.className = 'snl-export-route-outlet';
    outlet.hidden = true;
    main.appendChild(outlet);
    var moved = [];
    var surfaces = [];
    for (var i = 0; i < candidates.length; i++) {
      var surface = candidates[i];
      if (surface.closest('.snl-export-popover')) continue;
      if (!surface.hasAttribute('data-snl-route-id') && surface.closest('[data-snl-route-id]')) continue;
      var identity = surface.getAttribute('data-snl-route-id') || surface.getAttribute('data-entry-id');
      if (!identity) continue;
      surface.setAttribute('data-snl-route-surface', '');
      surfaces.push({ element: surface, identity: identity });
      if (!surface.querySelector(':scope > [data-snl-route-link]')) {
        var link = document.createElement('a');
        link.setAttribute('data-snl-route-link', '');
        link.className = 'snl-export-route-link';
        link.href = '#/node/' + encodeURIComponent(identity);
        var linkLabel = (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0
          ? '此节点的永久链接'
          : 'Permalink to this node';
        link.setAttribute('aria-label', linkLabel);
        link.title = linkLabel;
        link.innerHTML = '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8.1 11.9a3 3 0 0 0 4.2 0l3-3a3 3 0 1 0-4.2-4.2L9.8 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11.9 8.1a3 3 0 0 0-4.2 0l-3 3a3 3 0 1 0 4.2 4.2l1.3-1.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        surface.appendChild(link);
      }
    }

    function clearStatus() {
      var old = main.querySelector('[data-snl-route-not-found]');
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }

    function showMissing(identity) {
      clearStatus();
      var status = document.createElement('p');
      status.setAttribute('data-snl-route-not-found', '');
      status.setAttribute('role', 'status');
      status.className = 'snl-export-route-status';
      status.textContent = (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0
        ? '找不到节点：' + identity
        : 'Node not found: ' + identity;
      main.insertBefore(status, main.firstChild);
    }

    function expandAncestors(element) {
      var cursor = element.parentElement;
      while (cursor && cursor !== main) {
        if (cursor.hasAttribute('data-snl-collapsible')) {
          var record = cursor.__snlExportCollapseRecord;
          if (record && record.toggle.getAttribute('aria-expanded') !== 'true') {
            record.toggle.click();
          }
        }
        cursor = cursor.parentElement;
      }
    }

    function restoreMoved() {
      while (moved.length) {
        var placement = moved.pop();
        if (placement.marker.parentNode) {
          placement.marker.parentNode.insertBefore(placement.element, placement.marker.nextSibling);
          placement.marker.parentNode.removeChild(placement.marker);
        }
      }
      if (routeBody) routeBody.hidden = false;
      outlet.hidden = true;
    }

    function showInOutlet(matches) {
      if (!routeBody) {
        for (var i = 0; i < matches.length; i++) expandAncestors(matches[i]);
        return;
      }
      for (var i = 0; i < matches.length; i++) {
        var target = matches[i];
        if (!target.parentNode) continue;
        var marker = document.createComment('snl-route-origin');
        target.parentNode.insertBefore(marker, target);
        moved.push({ element: target, marker: marker });
        outlet.appendChild(target);
      }
      routeBody.hidden = true;
      outlet.hidden = false;
    }

    function applyRoute() {
      restoreMoved();
      document.documentElement.removeAttribute('data-snl-entry-route');
      clearStatus();
      for (var i = 0; i < surfaces.length; i++) {
        surfaces[i].element.removeAttribute('data-snl-route-current');
        surfaces[i].element.removeAttribute('aria-current');
      }
      var prefix = '#/node/';
      if (window.location.hash.slice(0, prefix.length) !== prefix) return;
      var encoded = window.location.hash.slice(prefix.length);
      var identity;
      try { identity = decodeURIComponent(encoded); }
      catch (_) { showMissing(encoded); return; }
      if (!identity) { showMissing(identity); return; }
      var matches = [];
      for (var j = 0; j < surfaces.length; j++) {
        if (surfaces[j].identity === identity) matches.push(surfaces[j].element);
      }
      if (matches.length === 0) { showMissing(identity); return; }
      document.documentElement.setAttribute('data-snl-entry-route', identity);
      for (var k = 0; k < matches.length; k++) {
        matches[k].setAttribute('data-snl-route-current', '');
        matches[k].setAttribute('aria-current', 'location');
      }
      showInOutlet(matches);
      var target = matches[0];
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      if (target.focus) target.focus({ preventScroll: true });
      if (target.scrollIntoView) target.scrollIntoView({ block: 'start' });
    }

    if (globalThis.__snlExportRouteCleanup) globalThis.__snlExportRouteCleanup();
    window.addEventListener('hashchange', applyRoute);
    globalThis.__snlExportRouteCleanup = function () {
      window.removeEventListener('hashchange', applyRoute);
      restoreMoved();
      if (outlet.parentNode) outlet.parentNode.removeChild(outlet);
      globalThis.__snlExportRouteCleanup = null;
    };
    applyRoute();
  }

  function wireSurface() {
    wireHighlighting();
    wireCollapse();
    wirePopovers();
    wireRoutes();
  }

  /** Top-right language and theme controls for captured live-render variants. */
  function wireVariantControls() {
    var bundle = globalThis.__SNL_EXPORT_VARIANTS__;
    if (!bundle || !Array.isArray(bundle.variants) || bundle.variants.length === 0) return false;
    if (globalThis.__snlExportControlsCleanup) globalThis.__snlExportControlsCleanup();

    var variants = bundle.variants.filter(function (variant) {
      return variant && typeof variant.locale === 'string' &&
        (variant.colorScheme === 'light' || variant.colorScheme === 'dark') &&
        typeof variant.body === 'string';
    });
    if (!variants.length) return false;

    var locales = [];
    for (var i = 0; i < variants.length; i++) {
      if (!locales.some(function (item) { return item.id === variants[i].locale; })) {
        locales.push({ id: variants[i].locale, label: variants[i].languageLabel || variants[i].locale });
      }
    }
    var currentLocale = bundle.initialLocale || variants[0].locale;
    var currentScheme = bundle.initialColorScheme === 'dark' ? 'dark' : 'light';
    var toolbar = document.createElement('div');
    toolbar.className = 'snl-export-toolbar';
    toolbar.setAttribute('data-snl-export-toolbar', '');
    toolbar.setAttribute('role', 'toolbar');
    var languageWrap = document.createElement('div');
    languageWrap.className = 'snl-export-language';
    var languageButton = document.createElement('button');
    languageButton.type = 'button';
    languageButton.className = 'snl-export-tool-button';
    languageButton.setAttribute('data-snl-language-trigger', '');
    languageButton.setAttribute('aria-haspopup', 'menu');
    languageButton.setAttribute('aria-expanded', 'false');
    var menu = document.createElement('div');
    menu.className = 'snl-export-language-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    var themeButton = document.createElement('button');
    themeButton.type = 'button';
    themeButton.className = 'snl-export-tool-button';
    themeButton.setAttribute('data-snl-theme-toggle', '');
    languageWrap.appendChild(languageButton);
    languageWrap.appendChild(menu);
    toolbar.appendChild(languageWrap);
    toolbar.appendChild(themeButton);
    document.body.appendChild(toolbar);

    function isZh() { return currentLocale.toLowerCase().indexOf('zh') === 0; }
    function languageIcon(locale) {
      if (locale === 'zh-CN') return '<svg aria-hidden="true" viewBox="0 0 20 14"><rect width="20" height="14" rx="1" fill="#DE2910"/><polygon points="4,2 4.65,3.35 6.1,3.55 5.05,4.55 5.3,6 4,5.3 2.7,6 2.95,4.55 1.9,3.55 3.35,3.35" fill="#FFDE00"/></svg>';
      if (locale === 'en') return '<svg aria-hidden="true" viewBox="0 0 20 14"><rect width="20" height="14" rx="1" fill="#fff"/><path stroke="#B22234" stroke-width="1.1" d="M0 1h20M0 3h20M0 5h20M0 7h20M0 9h20M0 11h20M0 13h20"/><rect width="9" height="7.5" fill="#3C3B6E"/></svg>';
      return '<svg aria-hidden="true" viewBox="0 0 20 14"><circle cx="10" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.8 7h10.4M10 1.5c2.7 2.8 2.7 8.2 0 11M10 1.5c-2.7 2.8-2.7 8.2 0 11" fill="none" stroke="currentColor"/></svg>';
    }
    function themeIcon() {
      return currentScheme === 'dark'
        ? '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 3v2m0 10v2M3 10h2m10 0h2M5 5l1.4 1.4M13.6 13.6 15 15M15 5l-1.4 1.4M6.4 13.6 5 15" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
        : '<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M15.5 12.8A6 6 0 0 1 7.2 4.5 6 6 0 1 0 15.5 12.8Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    }
    function findVariant(locale, scheme) {
      for (var i = 0; i < variants.length; i++) {
        if (variants[i].locale === locale && variants[i].colorScheme === scheme) return variants[i];
      }
      return null;
    }
    function updateLabels() {
      var language = locales.find(function (item) { return item.id === currentLocale; }) || { label: currentLocale };
      languageButton.innerHTML = languageIcon(currentLocale);
      languageButton.setAttribute('aria-label', (isZh() ? '语言：' : 'Language: ') + language.label);
      themeButton.innerHTML = themeIcon();
      themeButton.setAttribute('aria-label', currentScheme === 'dark'
        ? (isZh() ? '切换到浅色模式' : 'Switch to light mode')
        : (isZh() ? '切换到深色模式' : 'Switch to dark mode'));
      for (var i = 0; i < menu.children.length; i++) {
        var item = menu.children[i];
        item.setAttribute('aria-checked', item.getAttribute('data-snl-language') === currentLocale ? 'true' : 'false');
        var check = item.querySelector('[data-snl-language-check]');
        if (check) check.textContent = item.getAttribute('data-snl-language') === currentLocale ? '✓' : '';
      }
    }
    function applyVariant(locale, scheme) {
      var variant = findVariant(locale, scheme) || findVariant(locale, currentScheme) ||
        findVariant(currentLocale, scheme);
      if (!variant) return;
      if (globalThis.__snlExportRouteCleanup) globalThis.__snlExportRouteCleanup();
      if (globalThis.__snlExportPopoverCleanup) globalThis.__snlExportPopoverCleanup();
      currentLocale = variant.locale;
      currentScheme = variant.colorScheme;
      document.documentElement.lang = currentLocale;
      document.documentElement.dataset.snlColorScheme = currentScheme;
      document.title = variant.title || document.title;
      var title = document.querySelector('[data-snl-export-title]');
      if (title && typeof variant.title === 'string') title.textContent = variant.title;
      var subtitle = document.querySelector('[data-snl-export-subtitle]');
      if (subtitle) {
        subtitle.textContent = variant.subtitle || '';
        subtitle.hidden = !variant.subtitle;
      }
      var body = document.querySelector('[data-snl-export-body]');
      if (body) body.innerHTML = variant.body;
      globalThis.__SNL_POPOVERS__ = variant.popovers || {};
      menu.hidden = true;
      languageButton.setAttribute('aria-expanded', 'false');
      updateLabels();
      wireSurface();
    }

    for (var j = 0; j < locales.length; j++) {
      (function (language) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'snl-export-language-item';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('data-snl-language', language.id);
        item.innerHTML = languageIcon(language.id) + '<span></span><span data-snl-language-check></span>';
        item.children[1].textContent = language.label;
        item.addEventListener('click', function (event) {
          event.stopPropagation();
          applyVariant(language.id, currentScheme);
          languageButton.focus();
        });
        menu.appendChild(item);
      })(locales[j]);
    }
    languageButton.addEventListener('click', function (event) {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      languageButton.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    themeButton.addEventListener('click', function (event) {
      event.stopPropagation();
      applyVariant(currentLocale, currentScheme === 'dark' ? 'light' : 'dark');
    });
    function closeMenu(event) {
      if (!toolbar.contains(event.target)) {
        menu.hidden = true;
        languageButton.setAttribute('aria-expanded', 'false');
      }
    }
    document.addEventListener('click', closeMenu);
    globalThis.__snlExportControlsCleanup = function () {
      document.removeEventListener('click', closeMenu);
      if (toolbar.parentNode) toolbar.parentNode.removeChild(toolbar);
      globalThis.__snlExportControlsCleanup = null;
    };
    applyVariant(currentLocale, currentScheme);
    return true;
  }

  function init() {
    if (!wireVariantControls()) wireSurface();
  }

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
.snl-collapsible-scope { position: relative; min-width: 0; }
.snl-collapsible-scope__controls {
  display: flex; justify-content: flex-end; align-items: center;
  gap: .35rem; margin: 0 0 .4rem;
}
.snl-export-route-outlet { width: 100%; margin: 0; }
.snl-export-route-outlet > [data-snl-route-surface] {
  width: 100%;
  margin: 0 !important;
}
.snl-export-route-outlet > [data-snl-route-surface] > .snl-collapse-toggle {
  display: none !important;
}
html[data-snl-entry-route] .snl-export [data-snl-route-surface]:not([data-snl-route-current]) {
  display: none !important;
}
.snl-export-route-link {
  position: absolute;
  z-index: 2;
  top: .35rem;
  right: .45rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  color: inherit;
  opacity: .48;
}
.snl-export-route-link svg { width: 17px; height: 17px; }
[data-snl-route-surface] .snl-entry-header { padding-right: 2.75rem !important; }
.snl-export-route-link:hover,
.snl-export-route-link:focus-visible {
  opacity: 1;
  background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15));
}
.snl-export-route-status {
  padding: .65rem .8rem;
  border: 1px solid #b91c1c;
  color: #991b1b;
  background: #fef2f2;
}
.snl-export-toolbar {
  position: fixed;
  z-index: 2147483000;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--snl-export-foreground, inherit);
}
.snl-export-language { position: relative; display: flex; }
.snl-export-tool-button {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  min-height: 28px;
  padding: .3rem .28rem;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.28));
  border-radius: 2px;
  color: var(--vscode-input-foreground, inherit);
  background: var(--vscode-input-background, var(--snl-export-background, #fff));
  cursor: pointer;
}
.snl-export-tool-button:hover,
.snl-export-tool-button[aria-expanded="true"] {
  background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15));
}
.snl-export-tool-button:focus-visible,
.snl-export-language-item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0969da);
  outline-offset: 1px;
}
.snl-export-tool-button svg { width: 20px; height: 18px; }
.snl-export-language-menu {
  position: absolute;
  top: calc(100% + 7px);
  right: 0;
  min-width: min(17rem, calc(100vw - 1rem));
  max-width: calc(100vw - 1rem);
  padding: 4px;
  border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.28));
  border-radius: 4px;
  color: var(--vscode-menu-foreground, var(--snl-export-foreground, inherit));
  background: var(--vscode-menu-background, var(--snl-export-background, #fff));
  box-shadow: 0 4px 14px rgba(0,0,0,.24);
}
.snl-export-language-item {
  appearance: none;
  display: grid;
  grid-template-columns: 22px 1fr 18px;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.snl-export-language-item:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15));
}
.snl-export-language-item svg { width: 20px; height: 14px; }
[data-snl-language-check] { text-align: center; }

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

/* Hover popovers.
 *
 * Values mirror the panel's HoverPopoverProvider frame (720px cap, 80vh, the
 * same shadow) so a document reads the same in the browser as in the Infoview.
 * The stack is z-ordered above everything else the page can produce; nesting
 * depth does not need its own z-index because later siblings paint on top. */
.snl-export-popover {
  position: fixed;
  z-index: 2147483000;
  box-sizing: border-box;
  max-width: min(720px, calc(100vw - 16px));
  width: max-content;
  background: var(--snl-export-background, #ffffff);
  color: var(--snl-export-foreground, #111111);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  overflow-x: hidden;
  overflow-y: auto;
  max-height: 80vh;
  transition: opacity 150ms ease;
}
/* EntrySurface cards carry inline width:100% with content-box sizing. Without
 * this override their left border is added outside the popover's measured
 * width, then clipped by overflow-x:hidden — observed as a missing 5px edge in
 * the user's actual integrated HTML, recursively at every popover level. */
.snl-export-popover > [data-entry-id] { box-sizing: border-box; }
.snl-export-popover-fallback { padding: 0.6rem 0.8rem; }
`.trim();
