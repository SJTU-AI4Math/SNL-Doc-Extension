// Static HTML export for a rendered Library.
//
// Design note (2026-07-28): we deliberately do NOT server-render the Entry
// tree. `renderToStaticMarkup` cannot render this pipeline at all —
// HoverPopoverProvider mounts a portal ("Portals are not currently supported
// by the server renderer"), and the SNL body resolves asynchronously, so a
// synchronous render only ever yields the "Resolving Entry context…" stub.
//
// Instead we harvest the DOM the Infoview has *already* rendered. By the time
// the reader can click Export, every Entry is settled, KaTeX has painted, and
// macro context is resolved. The export is therefore a snapshot of exactly
// what the reader sees, which is also the property we want from a document
// exporter.
//
// Entry card presentation is inline-styled by SNL-Basics, so it survives the
// copy for free. Only KaTeX + the two SNL-Basics stylesheets have to travel
// alongside, and those are collected host-side from the built webview bundle.

import type { MacroRecord } from '../render/macroData';

/** An image referenced by the harvested DOM, to be emitted alongside it. */
export interface ExportedAsset {
  /** Path relative to the export root, e.g. `assets/Dashboard-Panel.png`. */
  path: string;
  /** Source URL as it appeared in the live DOM (a `vscode-webview:` URI). */
  sourceUrl: string;
}

export interface HarvestResult {
  /** Body markup with image sources rewritten to export-relative paths. */
  html: string;
  /** Every distinct asset the markup now points at. */
  assets: ExportedAsset[];
}

/** Interactive affordances that mean nothing in a static file. */
const STRIPPED_SELECTORS = [
  '[data-export-strip]',
  'button',
  '[role="button"]'
].join(',');

/**
 * Normalise the collapse structure so the exported runtime can rebuild it.
 *
 * The live Infoview renders the toggle as a React `<button>` that the strip
 * pass removes, so the exporter guarantees the annotations the runtime needs
 * and drops any marker whose subtree is missing.
 *
 * Ownership matters: the Entry outline puts `data-snl-subtree` on a DIRECT
 * child, but the `collapsible` block renderer nests its body under a summary
 * row, and collapsibles nest inside each other. So we search descendants and
 * accept a subtree only when the nearest enclosing collapsible host is THIS
 * host — the same rule `src/exportRuntime.ts` applies at read time. A direct-
 * children-only scan (the original) saw no subtree on every block collapsible
 * and stripped its markers, which is why 猫猫 found "到处以后所有的 Collapse
 * 都不 work" (2026-07-29).
 */
function ownedSubtree(host: HTMLElement): HTMLElement | undefined {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-snl-subtree]')).find(
    (sub) => {
      let owner: HTMLElement | null = sub.parentElement;
      while (owner && owner !== host && !owner.hasAttribute('data-snl-collapsible')) {
        owner = owner.parentElement;
      }
      return owner === host;
    }
  );
}

function markCollapsibleRows(clone: HTMLElement): void {
  for (const host of Array.from(
    clone.querySelectorAll<HTMLElement>('[data-snl-collapsible]')
  )) {
    if (!ownedSubtree(host)) {
      host.removeAttribute('data-snl-collapsible');
      host.removeAttribute('data-snl-child-count');
      host.removeAttribute('data-snl-collapse-noun');
      host.removeAttribute('data-snl-collapsed');
    }
  }
}

/**
 * Copy a rendered outline subtree into standalone markup.
 *
 * `assetBaseUri` is the webview asset root (`webview.asWebviewUri` of
 * `.SNL_Doc/assets`). Images under it become `assets/<name>`; anything else
 * (absolute http(s), data: URLs) is left untouched so external figures keep
 * working.
 *
 * Interactive controls are stripped, but the *structure* they operated on is
 * preserved and annotated first (see {@link markCollapsibleRows}) so the
 * exported runtime can rebuild collapse without the React tree.
 */
export function harvestLibraryHtml(
  root: HTMLElement,
  assetBaseUri: string,
  macros?: MacroRecord
): HarvestResult {
  const clone = root.cloneNode(true) as HTMLElement;

  // The live EntryRender resolves a reference as
  // `context.macro?.source.entries[0] ?? target.dataset.src`. A static DOM has
  // no interaction context or macro driver, so project that exact first source
  // into data-src while the same macro DB is still available. Constants such
  // as `Set` otherwise lose the Entry popover that works in the panel, whereas
  // bvars happen to keep working because context resolution already painted
  // data-src onto them.
  if (macros) {
    for (const node of Array.from(clone.querySelectorAll<HTMLElement>('[data-name]'))) {
      if (node.hasAttribute('data-src')) continue;
      const name = node.getAttribute('data-name') ?? '';
      const source = macros[name]?.source?.entries?.[0];
      if (typeof source === 'string' && source) node.setAttribute('data-src', source);
    }
  }

  markCollapsibleRows(clone);

  for (const node of Array.from(clone.querySelectorAll(STRIPPED_SELECTORS))) {
    node.remove();
  }

  const base = assetBaseUri.replace(/\/$/, '');
  const assets = new Map<string, ExportedAsset>();

  for (const img of Array.from(clone.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!base || !src.startsWith(`${base}/`)) continue;
    const rest = src.slice(base.length + 1);
    let clean: string;
    try {
      // Webview URIs percent-encode workspace filenames. The exported path and
      // the host-side filesystem lookup must use the real filename, otherwise
      // `a b.png` turns into a request for the non-existent `a%20b.png`.
      clean = decodeURIComponent(rest.split(/[?#]/)[0]);
    } catch {
      clean = '';
    }
    if (!clean || clean.split('/').some((s) => !s || s === '..')) {
      // Never let a webview-internal URL survive into a portable file: it
      // would be a guaranteed dead link outside VS Code. Neutralise instead.
      img.removeAttribute('src');
      img.setAttribute('data-export-unresolved', '');
      continue;
    }
    const path = `assets/${clean}`;
    img.setAttribute('src', path);
    img.setAttribute('loading', 'lazy');
    if (!assets.has(path)) assets.set(path, { path, sourceUrl: src });
  }

  return { html: clone.innerHTML, assets: [...assets.values()] };
}
