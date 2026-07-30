// Host-side document assembly: wrap harvested markup in a complete HTML page.
//
// Lives under `src/` rather than `webview/src/` because the extension host is
// what writes files, and `tsconfig` rootDir keeps the two trees separate. The
// webview's job ends at producing body markup (see
// `webview/src/export/htmlExport.ts`).

export interface DocumentOptions {
  title: string;
  /** Concatenated CSS. Always inlined — it is small and avoids a fetch. */
  css: string;
  /** Body markup harvested from the rendered Infoview. */
  body: string;
  /** Optional subtitle line under the document title. */
  subtitle?: string;
  /**
   * Inline script restoring hover highlighting and collapse. Omit for a
   * strictly static document (no JavaScript at all).
   */
  script?: string;
  /**
   * Sidecar scripts emitted as `<script src="...">` BEFORE {@link script}.
   *
   * Order is load-bearing: the runtime reads `window.__SNL_POPOVERS__` during
   * init, so the payload must already have executed. Referenced rather than
   * inlined here because the directory shape wants a separate file; the inline
   * shape folds these exact tags back in via `inlineScripts`, so one payload
   * serves both shapes.
   */
  scriptSources?: string[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wrap harvested markup in a complete, self-sufficient HTML document.
 *
 * When `script` is omitted the page carries no JavaScript at all. When it is
 * supplied the script is inlined at the end of `<body>`, so the document stays
 * a single self-sufficient file with no outbound requests either way.
 */
export function buildExportDocument(options: DocumentOptions): string {
  const { title, css, body, subtitle, script, scriptSources = [] } = options;
  const heading = subtitle
    ? `<h1>${escapeHtml(title)}</h1>\n<p class="snl-export-subtitle">${escapeHtml(subtitle)}</p>`
    : `<h1>${escapeHtml(title)}</h1>`;
  const sidecarTags = scriptSources
    .map((src) => `<script src="${escapeHtml(src)}"></script>\n`)
    .join('');
  // `</script>` inside the payload would close the tag early.
  const scriptTag = script
    ? `<script>\n${script.replace(/<\/script>/gi, '<\\/script>')}\n</script>\n`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="SNL-Doc-Extension">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main class="snl-export">
${heading}
${body}
</main>
${sidecarTags}${scriptTag}</body>
</html>
`;
}

/** Baseline page chrome. Entry cards bring their own inline styles. */
export const EXPORT_BASE_CSS = `
body {
  margin: 0;
  padding: 2rem 1rem;
  background: #ffffff;
  color: #111111;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.6;
}
.snl-export { max-width: 60rem; margin: 0 auto; }
.snl-export > h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
.snl-export-subtitle {
  margin: 0 0 2rem;
  opacity: 0.7;
  font-size: 0.9rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.snl-export img { max-width: 100%; height: auto; }
.snl-export section { margin-bottom: 1rem; }
`.trim();
