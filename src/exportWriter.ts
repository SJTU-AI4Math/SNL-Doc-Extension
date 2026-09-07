import * as vscode from 'vscode';
import { frozenReaderScript, type FrozenReaderSnapshot } from './sharedReaderSnapshot';
import type { SourcePreview } from './sourceExport/types';
import { buildSourceAssets } from './sourceExport/transport';
import { publishSourceExport } from './sourceExport/publication';
import { assertOwnedExportDestination, SOURCE_EXPORT_RECEIPT, sourceExportReceipt } from './sourceExport/destination';
import {
  buildExportPlan,
  exportFileStem,
  rewriteBundledCss,
  type BinaryAsset,
  type TextAsset
} from './exportDocument';
import { EXPORT_WATERMARK_LOGO_PATH } from './exportHtmlDocument';
import {
  buildExportPayloadScript,
  type ExportDocumentVariants,
  POPOVER_SCRIPT_PATH
} from './exportPopoverPayload';
import {
  readWorkspaceAsset,
  type ReadWorkspaceAssetOptions
} from './workspaceAssets';

/** What the webview sends when the reader hits Export. */
export interface ExportRequest {
  readerSnapshot?: FrozenReaderSnapshot;
  /** Host-authorized frozen source preview; not accepted directly from webview. */
  sourcePreview?: SourcePreview;
  slug: string;
  title: string;
  subtitle?: string;
  /** Harvested body markup, image srcs already export-relative. */
  body: string;
  /** `assets/<name>` → the `vscode-webview:` URL it was harvested from. */
  assets: { path: string; sourceUrl: string }[];
  inline: boolean;
  /**
   * entryId → pre-rendered popover markup, harvested by the webview. Absent
   * or empty means the document ships without popovers, which is a valid
   * (merely poorer) export rather than an error.
   */
  popovers?: Record<string, string>;
  /** Alternate locale/theme renderings captured from the live reader. */
  variants?: ExportDocumentVariants;
}

const WEBVIEW_CSS = 'main.css';

/**
 * Read the CSS the Infoview itself uses, so an export is typographically
 * identical to what the reader was looking at. This is the built bundle
 * stylesheet (KaTeX + SNL-Basics), not a hand-maintained copy that could
 * silently drift from the live renderer.
 */
async function readBundledCss(
  extensionUri: vscode.Uri,
  fsApi: vscode.FileSystem
): Promise<string> {
  const uri = vscode.Uri.joinPath(extensionUri, 'media', 'webview', WEBVIEW_CSS);
  return Buffer.from(await fsApi.readFile(uri)).toString('utf8');
}

/**
 * Resolve every binary the document needs: workspace images plus the web fonts
 * the stylesheet references.
 *
 * Assets are read from the workspace by name rather than by fetching the
 * `vscode-webview:` URL — the host has no fetch for those, and going through
 * the filesystem keeps the export inside `.SNL_Doc/assets` by construction.
 */
async function collectBinaries(
  request: ExportRequest,
  workspaceRoot: vscode.Uri,
  extensionUri: vscode.Uri,
  fontFiles: { bundleName: string; exportPath: string }[],
  fsApi: vscode.FileSystem,
  assetReader: (options: ReadWorkspaceAssetOptions) => Promise<Uint8Array>,
  warnings: string[]
): Promise<BinaryAsset[]> {
  const binaries: BinaryAsset[] = [];

  for (const asset of request.assets) {
    const name = asset.path.replace(/^assets\//, '');
    if (!name || name.split('/').some((s) => !s || s === '..')) {
      warnings.push(`Skipped suspicious asset path: ${asset.path}`);
      continue;
    }
    try {
      const bytes = await assetReader({
        workspaceRoot,
        relativePath: name,
        fsApi
      });
      binaries.push({ path: asset.path, bytes });
    } catch (error) {
      warnings.push(error instanceof Error && /symbolic link/i.test(error.message)
        ? `Skipped symbolic-link asset: ${asset.path}`
        : `Missing asset, exported without it: ${asset.path}`);
    }
  }

  for (const font of fontFiles) {
    const uri = vscode.Uri.joinPath(
      extensionUri,
      'media',
      'webview',
      font.bundleName
    );
    try {
      binaries.push({ path: font.exportPath, bytes: await fsApi.readFile(uri) });
    } catch {
      warnings.push(`Missing web font: ${font.bundleName}`);
    }
  }

  return binaries;
}

export interface ExportOutcome {
  /** The file the user should be pointed at. */
  target: vscode.Uri;
  fileCount: number;
  warnings: string[];
}

export interface ExportDeps {
  extensionUri: vscode.Uri;
  workspaceRoot: vscode.Uri;
  destination: vscode.Uri;
  beforePublish?: () => Promise<void>;
  fsApi?: vscode.FileSystem;
  assetReader?: (options: ReadWorkspaceAssetOptions) => Promise<Uint8Array>;
  /** Injected so the pure assembly can be tested without a webview. */
  buildDocument: (input: {
    title: string;
    subtitle?: string;
    colorScheme?: 'light' | 'dark';
    css: string;
    body: string;
    scriptSources: string[];
  }) => string;
}

/**
 * Write an exported document to disk.
 *
 * Directory shape writes `index.html` plus `assets/` and `fonts/` under
 * `destination`. Inline shape writes `destination` itself as a single file.
 */
export async function writeExport(
  request: ExportRequest,
  deps: ExportDeps
): Promise<ExportOutcome> {
  const fsApi = deps.fsApi ?? vscode.workspace.fs;
  const warnings: string[] = [];

  const rawCss = await readBundledCss(deps.extensionUri, fsApi);
  const { css, fontFiles } = rewriteBundledCss(rawCss);

  const binaries = await collectBinaries(
    request,
    deps.workspaceRoot,
    deps.extensionUri,
    fontFiles,
    fsApi,
    deps.assetReader ?? readWorkspaceAsset,
    warnings
  );

  // Export pages are white, so carry the black logo. It is an ordinary binary
  // in the shared export plan: directory shape writes a sidecar SVG; integrated
  // shape folds the same bytes into a data URL.
  try {
    binaries.push({
      path: EXPORT_WATERMARK_LOGO_PATH,
      bytes: await fsApi.readFile(
        vscode.Uri.joinPath(deps.extensionUri, 'media', 'icons', 'logoCSS_black.svg')
      )
    });
  } catch {
    warnings.push('Missing SJTU AI4Math watermark logo.');
  }

  // One payload, two shapes: the document always references `popovers.js`,
  // and `buildExportPlan` folds that reference into an inline <script> for the
  // single-file shape. Never a fetch() — under file:// that is a blocked
  // cross-origin request.
  const texts: TextAsset[] =
    (request.popovers && Object.keys(request.popovers).length > 0) || request.variants
      ? [{
          path: POPOVER_SCRIPT_PATH,
          source: buildExportPayloadScript(request.popovers ?? {}, request.variants)
        }]
      : [];

  if (request.readerSnapshot) texts.push({ path: 'readerSnapshot.js', source: frozenReaderScript(request.readerSnapshot) });
  let sourceCss = "";
  if (request.readerSnapshot) {
    sourceCss += Buffer.from(await fsApi.readFile(vscode.Uri.joinPath(deps.extensionUri, 'media', 'exportRuntime.css'))).toString('utf8');
  }
  if (request.sourcePreview) {
    if (deps.workspaceRoot.scheme !== "file" || deps.destination.scheme !== "file") throw new Error("Source export currently supports local file workspaces only.");
    texts.push(...buildSourceAssets(request.sourcePreview, request.inline).texts);
    const [script, style] = await Promise.all([
      fsApi.readFile(vscode.Uri.joinPath(deps.extensionUri, "media", "sourceViewer.js")),
      fsApi.readFile(vscode.Uri.joinPath(deps.extensionUri, "media", "sourceViewer.css"))
    ]);
    texts.push({ path: "sourceViewer.js", source: Buffer.from(script).toString("utf8") });
    sourceCss += Buffer.from(style).toString("utf8");
  }
  const sourceChunkPaths = new Set(request.sourcePreview?.manifest.files.map(file => file.chunkId) ?? []);
  const html = deps.buildDocument({
    title: request.title,
    subtitle: request.subtitle,
    colorScheme: request.variants?.initialColorScheme,
    css: css + "\n" + sourceCss,
    body: request.readerSnapshot ? '<div id="snl-reader-root"></div>' : request.body,
    scriptSources: texts.filter(t => request.inline || !sourceChunkPaths.has(t.path)).map((t) => t.path)
  });

  const plan = buildExportPlan({ html, binaries, inline: request.inline, texts });
  const encoder = new TextEncoder();

  if (request.sourcePreview || request.readerSnapshot) {
    const destination = request.inline && !/\.html$/i.test(deps.destination.path)
      ? deps.destination.with({ path: `${deps.destination.path}.html` }) : deps.destination;
    const files = request.inline
      ? [{ path: 'index.html', bytes: encoder.encode(plan.html) }]
      : [{ path: 'index.html', bytes: encoder.encode(plan.html) }, ...plan.binaries,
          ...plan.texts.map(text => ({ path: text.path, bytes: encoder.encode(text.source) }))];
    if (!request.inline) files.push({ path: SOURCE_EXPORT_RECEIPT, bytes: sourceExportReceipt(files) });
    const beforeCommit = async () => {
      await assertOwnedExportDestination(destination.fsPath, request.inline);
      await deps.beforePublish?.();
    };
    await beforeCommit();
    await publishSourceExport(destination.fsPath, files, request.inline, beforeCommit);
    return { target: request.inline ? destination : vscode.Uri.joinPath(destination, 'index.html'), fileCount: files.length, warnings };
  }

  if (request.inline) {
    const destination = /\.html$/i.test(deps.destination.path)
      ? deps.destination
      : deps.destination.with({ path: `${deps.destination.path}.html` });
    await fsApi.writeFile(destination, encoder.encode(plan.html));
    return { target: destination, fileCount: 1, warnings };
  }

  await fsApi.createDirectory(deps.destination);
  const indexUri = vscode.Uri.joinPath(deps.destination, 'index.html');
  await fsApi.writeFile(indexUri, encoder.encode(plan.html));

  for (const binary of plan.binaries) {
    const parts = binary.path.split('/');
    const fileUri = vscode.Uri.joinPath(deps.destination, ...parts);
    await fsApi.createDirectory(
      vscode.Uri.joinPath(deps.destination, ...parts.slice(0, -1))
    );
    await fsApi.writeFile(fileUri, binary.bytes);
  }

  for (const text of plan.texts) {
    await fsApi.writeFile(
      vscode.Uri.joinPath(deps.destination, ...text.path.split('/')),
      encoder.encode(text.source)
    );
  }

  return {
    target: indexUri,
    fileCount: plan.binaries.length + plan.texts.length + 1,
    warnings
  };
}

/** Default on-disk name for an export, matching the chosen shape. */
export function defaultExportName(slug: string, inline: boolean): string {
  const stem = exportFileStem(slug);
  return inline ? `${stem}.html` : stem;
}
