import * as vscode from 'vscode';
import { createEntryKind, readEntryKinds, updateEntryKind } from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage,
  installSnlDocWatcher
} from './panelUtil';

/**
 * Per-mode-and-identity singleton manager for the SNL Entry Kind editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createEntryKind` → create-mode panel (no identity).
 *  - `snlDoc.editEntryKind`   → edit-mode panel keyed by kind id.
 *
 * Message protocol with the webview (`createEntryKind.js`):
 *  - in  : `{ type: 'ready' }` (asks for context)
 *        | `{ type: 'create', payload: { id, name, stroke, background, numbering, style } }`
 *        | `{ type: 'update', payload: { name, stroke, background, numbering, style } }`
 *  - out : `{ type: 'context', mode, existing? }`
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'notFound'
 *            | 'invalid' | 'noSnlDoc' | 'noWorkspace' | 'error', ... }`
 */
export class CreateEntryKindPanel {
  private static readonly instances = new Map<string, CreateEntryKindPanel>();

  private static readonly viewType = 'snlCreateEntryKind';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  private readonly id: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateEntryKindPanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, id: string): void {
    if (!id) {
      return;
    }
    CreateEntryKindPanel.open(extensionUri, 'edit', id);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${id}`;

    const existing = CreateEntryKindPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit' ? `SNL Edit Entry Kind — ${id}` : 'SNL Create Entry Kind';
    const panel = vscode.window.createWebviewPanel(
      CreateEntryKindPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateEntryKindPanel.instances.set(
      key,
      new CreateEntryKindPanel(panel, extensionUri, mode, id)
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
      'createEntryKind',
      mode === 'edit'
        ? `SNL Edit Entry Kind — ${id}`
        : 'SNL Create Entry Kind'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    installSnlDocWatcher(this.disposables, () => this.pushContext());

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    // For BOTH create + edit modes we send the full `existingIds` list so
    // the webview's EntityIdSearchBox can dedupe against already-taken
    // kind ids. Cat 2026-07-09. Failures reading the config fall back to
    // an empty list — the picker degrades to "no dedupe check" rather
    // than blocking the whole panel.
    const root = firstWorkspaceFolder();
    let kinds = root ? await readEntryKinds(root).catch(() => []) : [];
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
    // Nav messages (back to Dashboard / Infoview) MUST be intercepted
    // before any type-filter early-return below drops them silently.
    // Cat 2026-07-10 caught this on Edit Library; every save-oriented
    // panel had the same shape.
    if (await handlePanelNavMessage(message, () => this.pushContext())) {
      return;
    }
    const msg = message as
      | {
          type?: string;
          payload?: {
            id?: string;
            name?: string;
            stroke?: string;
            background?: string;
            numbering?: string;
            style?: string;
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
      const text = 'SNL Entry Kind editor requires an open folder / workspace.';
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
        const result = await updateEntryKind(root, this.id, {
          name: p.name ?? '',
          stroke: p.stroke ?? '',
          background: p.background ?? '',
          numbering: p.numbering ?? '',
          style: p.style ?? ''
        });
                switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Entry kind "${result.kind.name}" (${result.kind.id}) updated.`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              kind: result.kind
            });
            return;
          case 'notFound': {
            const text = `Entry kind "${result.id}" no longer exists.`;
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
      const result = await createEntryKind(root, {
        id: p.id ?? '',
        name: p.name ?? '',
        stroke: p.stroke ?? '',
        background: p.background ?? '',
        numbering: p.numbering ?? '',
        style: p.style ?? ''
      });
      switch (result.status) {
        case 'created':
          vscode.window.showInformationMessage(
            `Entry kind "${result.kind.name}" (${result.kind.id}) created.`
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
          const text = `Entry kind id "${result.id}" already exists.`;
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
        `SNL Entry Kind editor failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.id}`;
    CreateEntryKindPanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
