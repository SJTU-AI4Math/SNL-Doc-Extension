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
 * pass removes, and it renders collapse by *omitting* the subtree entirely.
 * The exporter therefore requires the caller to expand everything first (see
 * `exportHtml` in App.tsx) — a collapsed subtree is simply not in the DOM and
 * cannot be harvested. Here we only guarantee the annotations the runtime
 * needs, and drop any marker on a row whose subtree did not make it.
 */
function markCollapsibleRows(clone: HTMLElement): void {
  for (const host of Array.from(
    clone.querySelectorAll<HTMLElement>('[data-snl-collapsible]')
  )) {
    const subtree = Array.from(host.children).find(
      (child) => child instanceof HTMLElement && child.hasAttribute('data-snl-subtree')
    );
    if (!subtree) {
      host.removeAttribute('data-snl-collapsible');
      host.removeAttribute('data-snl-child-count');
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
  assetBaseUri: string
): HarvestResult {
  const clone = root.cloneNode(true) as HTMLElement;

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
    const clean = rest.split(/[?#]/)[0];
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
