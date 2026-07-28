// Host-side assembly of an exported SNL document.
//
// The webview harvests markup (see `webview/src/export/htmlExport.ts`); this
// module turns that into files on disk. Two shapes, per cat's request:
//
//   directory : index.html + assets/ + fonts/   (small, hostable)
//   inline    : one self-contained .html         (mailable, file:// safe)
//
// Both share one pipeline. "Inline" is not a second implementation — it is the
// same plan with every external reference folded into a data: URL at the last
// step, so the two shapes cannot drift apart.

/** A binary file the export must carry (image or web font). */
export interface BinaryAsset {
  /** Path relative to the export root, e.g. `assets/x.png`, `fonts/y.woff2`. */
  path: string;
  bytes: Uint8Array;
}

/** Everything to be written, resolved and ready. */
export interface ExportPlan {
  /** `index.html` for a directory export, or the single file when inlined. */
  html: string;
  /** Empty when inlined — every byte lives inside `html` instead. */
  binaries: BinaryAsset[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

export function mimeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot < 0 ? '' : path.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function toDataUrl(path: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString('base64');
  return `data:${mimeForPath(path)};base64,${base64}`;
}

/**
 * Rewrite the built webview stylesheet so its `url(./main-KaTeX_*.woff2)`
 * references point at the export's own `fonts/` directory.
 *
 * KaTeX ships each face three times (woff2, woff, truetype) as a fallback
 * chain for old browsers. Carrying all three would triple the export for no
 * practical gain — woff2 has been universally supported for years — so the
 * legacy `woff`/`ttf` sources are dropped from the `src:` list and never
 * collected. A face with no woff2 keeps whatever it has.
 *
 * Returns the rewritten CSS plus the bundle-relative filenames to copy, so an
 * export never ships the whole `media/webview` directory.
 */
export function rewriteBundledCss(css: string): {
  css: string;
  fontFiles: { bundleName: string; exportPath: string }[];
} {
  const fonts = new Map<string, string>();

  const withoutLegacy = css.replace(
    /src:([^;}]+)/g,
    (match, list: string) => {
      const sources = list.split(/,(?=\s*url\()/);
      const woff2 = sources.filter((s) => /\.woff2\)/.test(s));
      return woff2.length > 0 ? `src:${woff2.join(',')}` : match;
    }
  );

  const rewritten = withoutLegacy.replace(
    /url\(\.\/([^)'"]+\.(?:woff2|woff|ttf))\)/g,
    (_match, name: string) => {
      // Bundle names are `<entry>-KaTeX_Main-Regular-<hash>.woff2`; drop the
      // entry prefix so the export is not tied to which webview built it.
      const exportName = name.replace(/^[a-zA-Z]+-(?=KaTeX_)/, '');
      const exportPath = `fonts/${exportName}`;
      fonts.set(name, exportPath);
      return `url(./${exportPath})`;
    }
  );
  return {
    css: rewritten,
    fontFiles: [...fonts.entries()].map(([bundleName, exportPath]) => ({
      bundleName,
      exportPath
    }))
  };
}

/**
 * Fold every binary into the document itself.
 *
 * Both `src="assets/x.png"` in the markup and `url(./fonts/y.woff2)` in the
 * inlined stylesheet are replaced by data: URLs, after which the document has
 * no outbound references at all.
 */
export function inlineBinaries(html: string, binaries: BinaryAsset[]): string {
  let out = html;
  for (const { path, bytes } of binaries) {
    const dataUrl = toDataUrl(path, bytes);
    out = out
      .split(`"${path}"`).join(`"${dataUrl}"`)
      .split(`(./${path})`).join(`(${dataUrl})`);
  }
  return out;
}

export interface PlanInput {
  html: string;
  binaries: BinaryAsset[];
  inline: boolean;
}

export function buildExportPlan({ html, binaries, inline }: PlanInput): ExportPlan {
  if (!inline) return { html, binaries };
  return { html: inlineBinaries(html, binaries), binaries: [] };
}

/** Filesystem-safe stem for an exported document. */
export function exportFileStem(slug: string): string {
  const cleaned = slug
    .split(/[/\\]+/)
    // Drop path-traversal segments outright rather than mangling them into a
    // literal `..-..-` filename.
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || 'snl-document';
}
