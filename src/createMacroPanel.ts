import * as vscode from 'vscode';
import {
  addMacro,
  readEntries,
  readMacroKinds,
  readMacroPackage,
  updateMacro,
  type EntryData,
  type MacroKind,
  type MacroPackageEntry
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';

/**
 * Compact projection of {@link EntryData} sent to the webview's entry
 * picker. Mirrors the `EntryOption` shape exported from
 * `webview/src/render/EntryRender.tsx` — kept as a plain object literal here
 * to avoid pulling the webview module into the host bundle.
 */
interface EntryOption {
  id: string;
  title: string;
  hasContent: boolean;
}

/** Convert an EntryData record into the picker projection. Empty title is
 *  legal (per snlDoc.ts spec); the picker renders it as "(untitled)". */
function toEntryOption(e: EntryData): EntryOption {
  const content = e.content ?? {};
  const hasContent =
    typeof content.snl === 'string' && content.snl.trim().length > 0;
  return { id: e.id, title: e.title ?? '', hasContent };
}

/** Strip a trailing `.json` (case-insensitive) from a package file argument. */
function stripJsonExt(file: string): string {
  return file.replace(/\.json$/i, '');
}

/**
 * Per-mode-and-identity singleton manager for the SNL Macro editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createMacro`(file)                → create-mode panel keyed by
 *                                                package file (per-file editor).
 *  - `snlDoc.editMacro`(file, macroName)       → edit-mode panel keyed by
 *                                                package file + macro name.
 *
 * Message protocol with the webview (`createMacro.js`):
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'create', macro: MacroPackageEntry }`
 *        | `{ type: 'update', macro: MacroPackageEntry }` (name = panel key)
 *  - out : `{ type: 'context', mode, file, packageName, existingNames,
 *            macroKinds, existing? }`
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'notFound'
 *            | 'invalid' | 'noFile' | 'error' | 'noWorkspace', ... }`
 */
export class CreateMacroPanel {
  private static readonly instances = new Map<string, CreateMacroPanel>();

  private static readonly viewType = 'snlCreateMacro';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  /** Bare filename (no `.json`) of the target package. */
  private readonly file: string;
  /** Macro name being edited (mode === 'edit' only). */
  private readonly macroName: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, file: string): void {
    const bare = stripJsonExt(file);
    if (!bare) {
      return;
    }
    CreateMacroPanel.open(extensionUri, 'create', bare, '');
  }

  public static editOrShow(
    extensionUri: vscode.Uri,
    file: string,
    macroName: string
  ): void {
    const bare = stripJsonExt(file);
    if (!bare || !macroName) {
      return;
    }
    CreateMacroPanel.open(extensionUri, 'edit', bare, macroName);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    file: string,
    macroName: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${file}:${macroName}`;

    const existing = CreateMacroPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit'
        ? `SNL Edit Macro — ${macroName} (${file})`
        : `SNL Create Macro — ${file}`;

    const panel = vscode.window.createWebviewPanel(
      CreateMacroPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateMacroPanel.instances.set(
      key,
      new CreateMacroPanel(panel, extensionUri, mode, file, macroName)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    file: string,
    macroName: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.file = file;
    this.macroName = macroName;

    const title =
      mode === 'edit'
        ? `SNL Edit Macro — ${macroName} (${file})`
        : `SNL Create Macro — ${file}`;
    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createMacro',
      title
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: this.mode,
        file: `${this.file}.json`,
        packageName: this.file,
        existingNames: [],
        macroKinds: [],
        existing: null,
        entries: []
      });
      return;
    }
    const macroKinds: MacroKind[] = await readMacroKinds(root);
    // Fetch shared entry pool for the source.entries picker. Failures
    // (missing entries.json, parse error) are non-fatal — we surface an
    // empty pool and the picker falls back to "No matching entry".
    let entries: EntryOption[] = [];
    try {
      const rawEntries = await readEntries(root);
      entries = rawEntries.map(toEntryOption);
    } catch {
      entries = [];
    }
    const read = await readMacroPackage(root, this.file);
    if (read.status === 'ok') {
      const existing =
        this.mode === 'edit'
          ? read.macros.find((m) => m.name === this.macroName) ?? null
          : null;
      void this.panel.webview.postMessage({
        type: 'context',
        mode: this.mode,
        file: `${this.file}.json`,
        packageName: read.pkg.name,
        existingNames: read.macros.map((m) => m.name),
        macroKinds,
        existing,
        entries
      });
      return;
    }
    // noFile / error → still let the editor open, just with no existing names.
    void this.panel.webview.postMessage({
      type: 'context',
      mode: this.mode,
      file: `${this.file}.json`,
      packageName: this.file,
      existingNames: [],
      macroKinds,
      existing: null,
      entries
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; macro?: MacroPackageEntry }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Macro editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const macro = msg.macro;
    if (!macro || typeof macro !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: 'no macro payload'
      });
      return;
    }

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        // Force the identity — ignore any name in the payload.
        const patched: MacroPackageEntry = { ...macro, name: this.macroName };
        const result = await updateMacro(root, this.file, patched);
        if (await handlePanelNavMessage(message)) {
          return;
        }
                switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Macro "${result.name}" in ${this.file}.json updated.`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              name: result.name
            });
            await this.pushContext();
            return;
          case 'notFound': {
            const text = `Macro "${result.id}" no longer exists in ${this.file}.json.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              name: result.id,
              message: text
            });
            return;
          }
          case 'noSnlDoc': {
            const text =
              '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'noSnlDoc',
              message: text
            });
            return;
          }
          case 'invalid':
            void this.panel.webview.postMessage({
              type: 'invalid',
              reason: result.message
            });
            return;
          case 'error':
            void this.panel.webview.postMessage({
              type: 'error',
              message: result.message
            });
            return;
        }
      }
      // Create path.
      const result = await addMacro(root, this.file, macro);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Macro "${result.name}" added to ${this.file}.json.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            name: result.name
          });
          // Refresh the editor's existing-names list.
          await this.pushContext();
          return;
        case 'duplicate': {
          const text = `Macro "${result.name}" already exists in this package.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            name: result.name,
            message: text
          });
          return;
        }
        case 'noFile': {
          const text = `Package ${this.file}.json no longer exists.`;
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noFile',
            message: text
          });
          return;
        }
        case 'invalid':
          void this.panel.webview.postMessage({
            type: 'invalid',
            reason: result.reason
          });
          return;
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Macro editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.file}:${this.macroName}`;
    CreateMacroPanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
