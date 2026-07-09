import * as vscode from 'vscode';
import { createMacroKind, readMacroKinds, updateMacroKind } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Per-mode-and-identity singleton manager for the SNL Macro Kind editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createMacroKind` → create-mode panel (no identity).
 *  - `snlDoc.editMacroKind`   → edit-mode panel keyed by kind id.
 *
 * Message protocol with the webview (`createMacroKind.js`):
 *  - in  : `{ type: 'ready' }` (asks for context)
 *        | `{ type: 'create', payload: { id, name, description, stroke, background } }`
 *        | `{ type: 'update', payload: { name, description, stroke, background } }`
 *  - out : `{ type: 'context', mode, existing? }`
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'notFound'
 *            | 'invalid' | 'noSnlDoc' | 'noWorkspace' | 'error', ... }`
 */
export class CreateMacroKindPanel {
  private static readonly instances = new Map<string, CreateMacroKindPanel>();

  private static readonly viewType = 'snlCreateMacroKind';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  private readonly id: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateMacroKindPanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, id: string): void {
    if (!id) {
      return;
    }
    CreateMacroKindPanel.open(extensionUri, 'edit', id);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${id}`;

    const existing = CreateMacroKindPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit' ? `SNL Edit Macro Kind — ${id}` : 'SNL Create Macro Kind';
    const panel = vscode.window.createWebviewPanel(
      CreateMacroKindPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateMacroKindPanel.instances.set(
      key,
      new CreateMacroKindPanel(panel, extensionUri, mode, id)
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.mode = mode;
    this.id = id;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'createMacroKind',
      mode === 'edit'
        ? `SNL Edit Macro Kind — ${id}`
        : 'SNL Create Macro Kind'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    // For BOTH create + edit modes we send the full `existingIds` list so
    // the webview's EntityIdSearchBox can dedupe against already-taken
    // kind ids. Cat 2026-07-09. Failures reading the config fall back to
    // an empty list — the picker degrades to "no dedupe check" rather
    // than blocking the whole panel.
    const root = firstWorkspaceFolder();
    let kinds = root ? await readMacroKinds(root).catch(() => []) : [];
    const existingIds = kinds.map((k) => ({
      id: k.id,
      title: k.name ?? '',
      // hasContent doesn't apply to kinds — set true so the picker's
      // "stub" badge stays hidden. Cat 2026-07-09.
      hasContent: true
    }));
    if (this.mode === 'create') {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'create',
        existingIds
      });
      return;
    }
    if (!root) {
      void this.panel.webview.postMessage({
        type: 'context',
        mode: 'edit',
        id: this.id,
        existing: null,
        existingIds
      });
      return;
    }
    const existing = kinds.find((k) => k.id === this.id) ?? null;
    void this.panel.webview.postMessage({
      type: 'context',
      mode: 'edit',
      id: this.id,
      existing,
      existingIds
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | {
          type?: string;
          payload?: {
            id?: string;
            name?: string;
            description?: string;
            stroke?: string;
            background?: string;
          };
        }
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
      const text = 'SNL Macro Kind editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const p = msg.payload ?? {};
    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateMacroKind(root, this.id, {
          name: p.name ?? '',
          description: p.description ?? '',
          coloring: {
            stroke: p.stroke ?? '',
            background: p.background ?? ''
          }
        });
        switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Macro kind "${result.kind.name}" (${result.kind.id}) updated.`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              kind: result.kind
            });
            return;
          case 'notFound': {
            const text = `Macro kind "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              id: result.id,
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
              message: result.message
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
      const result = await createMacroKind(root, {
        id: p.id ?? '',
        name: p.name ?? '',
        description: p.description ?? '',
        coloring: {
          stroke: p.stroke ?? '',
          background: p.background ?? ''
        }
      });
      switch (result.status) {
        case 'created':
          vscode.window.showInformationMessage(
            `Macro kind "${result.kind.name}" (${result.kind.id}) created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            kind: result.kind
          });
          return;
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
        case 'duplicate': {
          const text = `Macro kind id "${result.id}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            id: result.id,
            message: text
          });
          return;
        }
        case 'invalid':
          void this.panel.webview.postMessage({
            type: 'invalid',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Macro Kind editor failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.id}`;
    CreateMacroKindPanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
