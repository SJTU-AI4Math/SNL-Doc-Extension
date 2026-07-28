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
 * The page carries no script: a static SNL document is a reading artifact, and
 * shipping zero JavaScript keeps it viewable from `file://`, embeddable, and
 * safe to host anywhere.
 */
export function buildExportDocument(options: DocumentOptions): string {
  const { title, css, body, subtitle } = options;
  const heading = subtitle
    ? `<h1>${escapeHtml(title)}</h1>\n<p class="snl-export-subtitle">${escapeHtml(subtitle)}</p>`
    : `<h1>${escapeHtml(title)}</h1>`;

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
</body>
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
