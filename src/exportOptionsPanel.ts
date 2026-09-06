import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import { realpath } from 'node:fs/promises';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';
import { buildExportDocument, EXPORT_BASE_CSS } from './exportHtmlDocument';
import { EXPORT_RUNTIME_CSS } from './exportRuntime';
import { defaultExportName, writeExport, type ExportRequest } from './exportWriter';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';
import { bind_preferences_panel_locale_change } from './preferencesHost';
import type { RenderSourceContext } from './sourceExport/renderSnapshot';
import { parseSourceOptions, sourceRequestKey } from './sourceExport/options';
import { assertOwnedExportDestination } from './sourceExport/destination';
import { captureSourceSnapshot, revalidateSourceSnapshot, SourcePreflightError } from './sourceExport/archive';
import type { SourcePreview, SourceExportOptions } from './sourceExport/types';

const MESSAGES = defineHostMessages(
  {
    panelTitle: 'SNL Export HTML', saveDialogTitle: 'Export SNL document',
    folderDialogTitle: 'Choose a folder for the exported document', exportHere: 'Export here',
    noWorkspace: 'No workspace folder is open.', chooseDestination: 'Choose a destination first.',
    runtimeMissing: 'Interactive runtime not found (run `npm run build:export-runtime`); exporting a static document instead.',
    done: 'Exported {count} file(s) to {path}'
  },
  {
    panelTitle: 'SNL 导出 HTML', saveDialogTitle: '导出 SNL 文档',
    folderDialogTitle: '选择导出文档的文件夹', exportHere: '导出到此处',
    noWorkspace: '没有打开的工作区文件夹。', chooseDestination: '请先选择导出位置。',
    runtimeMissing: '未找到交互运行时（请运行 `npm run build:export-runtime`）；将改为导出静态文档。',
    done: '已将 {count} 个文件导出到 {path}'
  }
);

/** Harvested payload handed over by the Infoview, held until the user commits. */
export interface ExportPayload {
  renderSnapshotId?: string;
  slug: string;
  locale?: string;
  title: string;
  subtitle?: string;
  body: string;
  assets: { path: string; sourceUrl: string }[];
  /** entryId → pre-rendered popover markup (see the webview's prerender). */
  popovers?: Record<string, string>;
  /** Locale/theme variants used by the standalone top-right controls. */
  variants?: import('./exportPopoverPayload').ExportDocumentVariants;
}

/**
 * Settings surface for a static HTML export.
 *
 * Cat 2026-07-28 asked for a Panel rather than the QuickPick + save-dialog
 * chain: shape, destination, and options are all visible at once and can be
 * revised before committing, which a sequence of modal dialogs cannot do.
 *
 * The panel is a singleton — exporting a second Library retargets the existing
 * panel instead of stacking tabs, matching how the Entry editor behaves.
 */
export class ExportOptionsPanel {
  private static readonly viewType = 'snlExportOptions';
  private static current: ExportOptionsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private payload: ExportPayload;
  private sourceContext: RenderSourceContext | undefined;
  private sourcePreview: { preview: SourcePreview; key: string; options: SourceExportOptions } | undefined;
  private previewAbort: AbortController | undefined;
  private previewGeneration = 0;
  private exporting = false;
  private lastTarget: vscode.Uri | undefined;
  private disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, payload: ExportPayload, sourceContext?: RenderSourceContext): void {
    // Layout intent shared by every editor-side panel: take over the active
    // group. Only the Infoview opens Beside (see panelViewColumn.test.ts).
    const column = vscode.ViewColumn.Active;

    if (ExportOptionsPanel.current) {
      ExportOptionsPanel.current.cancelSourcePreview();
      ExportOptionsPanel.current.payload = payload;
      ExportOptionsPanel.current.sourceContext = sourceContext;
      ExportOptionsPanel.current.panel.title = createHostTranslator(
        payload.locale ?? read_extension_preferences().language,
        MESSAGES
      )('panelTitle');
      ExportOptionsPanel.current.panel.reveal(column);
      void ExportOptionsPanel.current.pushContext();
      return;
    }

    const t = createHostTranslator(payload.locale ?? read_extension_preferences().language, MESSAGES);
    const panel = vscode.window.createWebviewPanel(
      ExportOptionsPanel.viewType,
      t('panelTitle'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    const instance = new ExportOptionsPanel(panel, extensionUri, payload);
    instance.sourceContext = sourceContext;
    ExportOptionsPanel.current = instance;
    bind_preferences_panel_locale_change(panel, () => {
      const locale = read_extension_preferences().language;
      instance.payload = { ...instance.payload, locale };
      panel.title = createHostTranslator(locale, MESSAGES)('panelTitle');
      void instance.pushContext();
    });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    payload: ExportPayload
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.payload = payload;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'exportOptions',
      createHostTranslator(
        this.payload.locale ?? read_extension_preferences().language,
        MESSAGES
      )('panelTitle'), this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private defaultDestination(shape: 'single' | 'directory'): vscode.Uri | undefined {
    const root = firstWorkspaceFolder();
    if (!root) return undefined;
    return vscode.Uri.joinPath(root, defaultExportName(this.payload.slug, shape === 'single'));
  }

  private async pushContext(): Promise<void> {
    const destination = this.defaultDestination('directory');
    await this.panel.webview.postMessage({
      type: 'exportContext',
      context: {
        slug: this.payload.slug,
        title: this.payload.title,
        entryCount: (this.payload.body.match(/data-entry-id=/g) ?? []).length,
        assetCount: this.payload.assets.length,
        defaultDestination: destination?.fsPath ?? '',
        sourceAvailable: !!this.sourceContext,
        sourceRoot: this.sourceContext?.rootPath ?? ''
      }
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as
      | {
          type?: string;
          shape?: 'single' | 'directory';
          destination?: string;
          interactive?: boolean;
          sources?: unknown;
          confirmationId?: string;
          diskAcknowledged?: boolean;
          requestId?: number;
        }
      | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ready':
        await this.pushContext();
        return;

      case 'openInfoview':
        void vscode.commands.executeCommand('snlDoc.openInfoview');
        return;
      case 'pickDestination':
        await this.pickDestination(msg.shape === 'single' ? 'single' : 'directory');
        return;
      case 'previewSources':
        await this.previewSources(msg.sources, typeof msg.destination === 'string' ? msg.destination : '', msg.shape === 'single' ? 'single' : 'directory', msg.requestId);
        return;
      case 'cancelSourcePreview':
        this.cancelSourcePreview();
        return;
      case 'saveSourceBuffers': {
        const paths = this.sourcePreview ? await this.dirtySourceFiles(this.sourcePreview.preview) : [];
        this.cancelSourcePreview();
        try {
          for (const doc of vscode.workspace.textDocuments) {
            if (paths.includes(doc.uri.fsPath) && !await doc.save()) throw new Error('Source save was cancelled or failed.');
          }
          await this.panel.webview.postMessage({ type: 'sourcePreviewInvalidated' });
        } catch (error) {
          await this.panel.webview.postMessage({ type: 'exportFailed', message: String(error) });
        }
        return;
      }
      case 'runExport':
        await this.runExport(
          msg.shape === 'single' ? 'single' : 'directory',
          typeof msg.destination === 'string' ? msg.destination : '',
          msg.interactive !== false, msg.sources, msg.confirmationId, msg.diskAcknowledged === true
        );
        return;
      case 'revealExport':
        if (this.lastTarget) {
          void vscode.commands.executeCommand('revealFileInOS', this.lastTarget);
        }
        return;
      default:
        return;
    }
  }

  private async pickDestination(shape: 'single' | 'directory'): Promise<void> {
    const fallback = this.defaultDestination(shape);
    const t = createHostTranslator(
      this.payload.locale ?? read_extension_preferences().language,
      MESSAGES
    );
    const picked =
      shape === 'single'
        ? await vscode.window.showSaveDialog({
            title: t('saveDialogTitle'),
            defaultUri: fallback,
            filters: { HTML: ['html'] }
          })
        : await vscode.window
            .showOpenDialog({
              title: t('folderDialogTitle'),
              canSelectFiles: false,
              canSelectFolders: true,
              canSelectMany: false,
              defaultUri: firstWorkspaceFolder(),
              openLabel: t('exportHere')
            })
            .then((dirs) =>
              dirs?.[0]
                ? vscode.Uri.joinPath(
                    dirs[0],
                    defaultExportName(this.payload.slug, false)
                  )
                : undefined
            );

    if (picked) {
      await this.panel.webview.postMessage({
        type: 'destinationPicked',
        path: picked.fsPath
      });
    }
  }

  private cancelSourcePreview(): void {
    this.previewGeneration++;
    this.previewAbort?.abort();
    this.previewAbort = undefined;
    this.sourcePreview = undefined;
  }

  private sourceCaptureInput(context: RenderSourceContext, options: SourceExportOptions, destination: string, shape: 'single' | 'directory') {
    const root = firstWorkspaceFolder();
    if (vscode.workspace.workspaceFolders?.length !== 1 || root?.scheme !== 'file' || root.fsPath !== context.rootPath) {
      throw new Error('Source export requires one unchanged local workspace root; recapture the document in a single-root workspace.');
    }
    const destinationPath = shape === 'single' && !/\.html$/i.test(destination) ? destination + '.html' : destination;
    return { rootPath: context.rootPath, destinationPath, inline: shape === 'single',
      entries: context.entries, entryRoutes: context.entryRoutes, renderSnapshotId: context.renderSnapshotId, options };
  }

  private async dirtySourceFiles(preview: SourcePreview): Promise<string[]> {
    const root = this.sourceContext?.rootPath;
    if (!root) return [];
    const files = new Set<string>();
    for (const file of preview.manifest.files) {
      const path = nodePath.resolve(root, file.displayPath); files.add(path);
      try { files.add(await realpath(path)); } catch { /* snapshot revalidation reports missing files */ }
    }
    const dirty: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || doc.uri.scheme !== 'file') continue;
      let path = doc.uri.fsPath;
      try { path = await realpath(path); } catch { /* unsaved file may have no disk path */ }
      if (files.has(path) || files.has(doc.uri.fsPath)) dirty.push(doc.uri.fsPath);
    }
    return dirty;
  }

  private async previewSources(raw: unknown, destination: string, shape: 'single' | 'directory', requestId?: number): Promise<void> {
    this.cancelSourcePreview();
    const generation = this.previewGeneration;
    const controller = new AbortController();
    this.previewAbort = controller;
    try {
      const context = this.sourceContext;
      const options = parseSourceOptions(raw);
      if (firstWorkspaceFolder()?.scheme !== 'file') throw new Error('Source export currently requires a local file workspace.');
      if (!context || !options.enabled || !destination.trim()) throw new Error('Choose a destination and enable sources before preview.');
      await context.revalidate();
      const input = this.sourceCaptureInput(context, options, destination, shape);
      await assertOwnedExportDestination(input.destinationPath, input.inline);
      const preview = await captureSourceSnapshot({ ...input, signal: controller.signal });
      await context.revalidate();
      if (generation !== this.previewGeneration || context !== this.sourceContext || controller.signal.aborted) return;
      this.sourcePreview = { preview, options, key: sourceRequestKey(options, destination, shape, context.renderSnapshotId) };
      await this.postSourcePreview(preview, requestId, false);
    } catch (error) {
      if (generation !== this.previewGeneration || controller.signal.aborted) return;
      if (error instanceof SourcePreflightError && error.preview) {
        await this.postSourcePreview(error.preview, requestId, true);
      }
      await this.panel.webview.postMessage({ type: 'exportFailed', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async postSourcePreview(preview: SourcePreview, requestId: number | undefined, blocked: boolean): Promise<void> {
    await this.panel.webview.postMessage({ type: 'sourcePreview', requestId, preview: {
      blocked, confirmationId: preview.confirmationId,
      files: preview.manifest.files.map(({ displayPath, kind, byteLength }) => ({ displayPath, kind, byteLength })),
      directories: preview.manifest.directories, totalBytes: preview.totalBytes, estimatedBytes: preview.estimatedBytes,
      exclusions: preview.exclusions, warnings: preview.warnings, externalRoots: preview.externalRoots,
      unresolved: preview.manifest.pointers.filter(pointer => pointer.status !== 'ok').map(pointer => ({ entryId: pointer.entryId, status: pointer.status, reason: pointer.reason })),
      dirtyFiles: await this.dirtySourceFiles(preview)
    } });
  }

  private async runExport(
    shape: 'single' | 'directory',
    destinationPath: string,
    interactive: boolean, rawSources?: unknown, confirmationId?: string, diskAcknowledged = false
  ): Promise<void> {
    if (this.exporting) return;
    this.exporting = true;
    try { await this.runExportOwned(shape, destinationPath, interactive, rawSources, confirmationId, diskAcknowledged); }
    catch (error) { await this.panel.webview.postMessage({ type: 'exportFailed', message: error instanceof Error ? error.message : String(error) }); }
    finally { this.exporting = false; }
  }

  private async runExportOwned(shape: 'single' | 'directory', destinationPath: string, interactive: boolean, rawSources?: unknown, confirmationId?: string, diskAcknowledged = false): Promise<void> {
    const t = createHostTranslator(read_extension_preferences().language, MESSAGES);
    const root = firstWorkspaceFolder();
    if (!root) {
      await this.panel.webview.postMessage({
        type: 'exportFailed',
        message: t('noWorkspace')
      });
      return;
    }
    if (!destinationPath.trim()) {
      await this.panel.webview.postMessage({
        type: 'exportFailed',
        message: t('chooseDestination')
      });
      return;
    }

    const destination = vscode.Uri.file(destinationPath);
    const options = parseSourceOptions(rawSources);
    const sourceContext = this.sourceContext;
    const confirmed = this.sourcePreview;
    if (options.enabled) {
      if (!interactive || !sourceContext || !confirmed) throw new Error('Source export requires interaction and a confirmed preview.');
      if (confirmed.key !== sourceRequestKey(options, destinationPath, shape, sourceContext.renderSnapshotId) || confirmationId !== confirmed.preview.confirmationId) throw new Error('Source options changed; preview and confirm again.');
      if (!options.allowMissing && confirmed.preview.manifest.pointers.some(pointer => pointer.status !== 'ok')) throw new Error('Pointer targets unavailable: explicitly accept missing sources or revise filters.');
      if ((await this.dirtySourceFiles(confirmed.preview)).length && !diskAcknowledged) throw new Error('Unsaved source files: explicitly choose disk snapshot or save and preview again.');
      await sourceContext.revalidate();
      await revalidateSourceSnapshot(confirmed.preview, this.sourceCaptureInput(sourceContext, options, destinationPath, shape));
      if (confirmed !== this.sourcePreview || sourceContext !== this.sourceContext) throw new Error('Export context changed; preview again.');
    }
    const payload = structuredClone(this.payload);
    const request: ExportRequest = {
      ...payload,
      sourcePreview: options.enabled ? confirmed!.preview : undefined,
      inline: shape === 'single',
      // A static export promises no JavaScript. Do not merely hide the tag:
      // otherwise directory mode still writes an orphan popovers.js and counts
      // it as an exported file even though nothing can load it.
      popovers: interactive ? payload.popovers : undefined,
      variants: interactive ? payload.variants : undefined
    };

    // The interactive runtime is generated at build time (see
    // scripts/build-export-runtime.mjs) because it bundles SNL-Basics's own
    // hover implementation and a packaged extension has no bundler to run.
    let runtimeJs: string | undefined;
    if (interactive) {
      try {
        const uri = vscode.Uri.joinPath(this.extensionUri, 'media', 'exportRuntime.js');
        runtimeJs = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      } catch {
        if (options.enabled) throw new Error('Source export runtime is missing. Rebuild before exporting.');
        // Degrade to a strictly static document rather than failing the export:
        // the reader still gets correct, readable content, just without hover
        // and collapse.
        void vscode.window.showWarningMessage(
          t('runtimeMissing')
        );
        runtimeJs = undefined;
      }
    }

    try {
      const outcome = await writeExport(request, {
        extensionUri: this.extensionUri,
        workspaceRoot: root,
        destination,
        beforePublish: options.enabled ? async () => {
          if (sourceContext !== this.sourceContext || confirmed !== this.sourcePreview) throw new Error('Export preview changed before publication.');
          await sourceContext!.revalidate();
          await revalidateSourceSnapshot(confirmed!.preview, this.sourceCaptureInput(sourceContext!, options, destinationPath, shape));
        } : undefined,
        buildDocument: (input) =>
          buildExportDocument({
            ...input,
            locale: payload.locale,
            // Dropped when the reader asked for a static document: without the
            // runtime nothing would read the payload anyway.
            scriptSources: runtimeJs ? input.scriptSources : [],
            css: [EXPORT_BASE_CSS, runtimeJs ? EXPORT_RUNTIME_CSS : '', input.css]
              .filter(Boolean)
              .join('\n'),
            script: runtimeJs
          })
      });

      this.lastTarget = outcome.target;
      await this.panel.webview.postMessage({
        type: 'exportDone',
        message: t('done', { count: outcome.fileCount, path: outcome.target.fsPath }),
        warnings: outcome.warnings
      });
    } catch (err) {
      await this.panel.webview.postMessage({
        type: 'exportFailed',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private dispose(): void {
    this.cancelSourcePreview();
    ExportOptionsPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.panel.dispose();
  }
}
