// Host-side document assembly: wrap harvested markup in a complete HTML page.
//
// Lives under `src/` rather than `webview/src/` because the extension host is
// what writes files, and `tsconfig` rootDir keeps the two trees separate. The
// webview's job ends at producing body markup (see
// `webview/src/export/htmlExport.ts`).

export interface DocumentOptions {
  title: string;
  /** BCP-47 document/UI locale captured from the exporting Webview. */
  locale?: string;
  /** Initial standalone palette; interactive exports may switch it later. */
  colorScheme?: 'light' | 'dark';
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

export const EXPORT_WATERMARK_LOGO_PATH = 'assets/sjtu-ai4math-logo.svg';
export const SNL_BASICS_URL = 'https://github.com/SJTU-AI4Math/SNL-Basics';

/**
 * Wrap harvested markup in a complete, self-sufficient HTML document.
 *
 * When `script` is omitted the page carries no JavaScript at all. When it is
 * supplied the script is inlined at the end of `<body>`, so the document stays
 * a single self-sufficient file with no outbound requests either way.
 */
export function buildExportDocument(options: DocumentOptions): string {
  const { title, css, body, subtitle, script, scriptSources = [] } = options;
  const locale = options.locale?.trim() || 'en';
  const isZh = locale.toLowerCase().startsWith('zh');
  const colorScheme = options.colorScheme === 'dark' ? 'dark' : 'light';
  const watermarkLabel = isZh ? 'GitHub 上的 SNL-Basics' : 'SNL-Basics on GitHub';
  const watermarkCopy = isZh
    ? '由上海交通大学 AI4Math 团队 Fulcrum 的 SNL 提供交互式公式支持'
    : 'Interactive formulae powered by SNL by Fulcrum@SJTU AI4Math Team';
  const heading = subtitle
    ? `<h1 data-snl-export-title>${escapeHtml(title)}</h1>\n<p data-snl-export-subtitle class="snl-export-subtitle">${escapeHtml(subtitle)}</p>`
    : `<h1 data-snl-export-title>${escapeHtml(title)}</h1>`;
  const sidecarTags = scriptSources
    .map((src) => `<script src="${escapeHtml(src)}"></script>\n`)
    .join('');
  // `</script>` inside the payload would close the tag early.
  const scriptTag = script
    ? `<script>\n${script.replace(/<\/script>/gi, '<\\/script>')}\n</script>\n`
    : '';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}" data-snl-color-scheme="${colorScheme}">
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
<div data-snl-export-body>${body}</div>
</main>
<a class="snl-export-watermark" href="${SNL_BASICS_URL}" target="_blank" rel="noopener noreferrer" aria-label="${watermarkLabel}">
  <img src="${EXPORT_WATERMARK_LOGO_PATH}" alt="SJTU AI4Math" />
  <span>${watermarkCopy}</span>
</a>
${sidecarTags}${scriptTag}</body>
</html>
`;
}

/** Baseline page chrome. Entry cards bring their own inline styles. */
export const EXPORT_BASE_CSS = `
:root {
  color-scheme: light;
  --snl-export-background: #ffffff;
  --snl-export-foreground: #111111;
  --vscode-editor-background: #ffffff;
  --vscode-editor-foreground: #111111;
  --vscode-widget-border: rgba(31, 41, 55, 0.24);
  --vscode-focusBorder: #0969da;
  --vscode-toolbar-hoverBackground: rgba(127, 127, 127, 0.15);
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #111111;
  --vscode-menu-background: #ffffff;
  --vscode-menu-foreground: #111111;
}
:root[data-snl-color-scheme="dark"] {
  color-scheme: dark;
  --snl-export-background: #1e1e1e;
  --snl-export-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e;
  --vscode-editor-foreground: #cccccc;
  --vscode-widget-border: rgba(255, 255, 255, 0.2);
  --vscode-focusBorder: #007fd4;
  --vscode-toolbar-hoverBackground: rgba(255, 255, 255, 0.12);
  --vscode-input-background: #2a2a2a;
  --vscode-input-foreground: #dddddd;
  --vscode-menu-background: #252526;
  --vscode-menu-foreground: #dddddd;
}
body {
  margin: 0;
  padding: 2rem 1rem;
  background: var(--snl-export-background);
  color: var(--snl-export-foreground);
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
.snl-export-watermark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
  width: fit-content;
  max-width: calc(100% - 2rem);
  margin: 3rem auto 0;
  padding: 0.55rem 0.8rem;
  color: inherit;
  font-size: 0.78rem;
  line-height: 1.35;
  text-decoration: none;
  opacity: 0.48;
  transition: opacity 150ms ease;
}
.snl-export-watermark:hover,
.snl-export-watermark:focus-visible { opacity: 0.78; }
.snl-export-watermark img {
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
}
:root[data-snl-color-scheme="dark"] .snl-export-watermark img { filter: invert(1); }
`.trim();
