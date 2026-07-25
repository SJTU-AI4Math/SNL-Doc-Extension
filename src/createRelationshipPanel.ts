import * as vscode from 'vscode';
import {
  addRelationship,
  readEntries,
  readRelationships,
  updateRelationship,
  type RelationshipData
} from './snlDoc';
import {
  buildPanelHtml,
  firstWorkspaceFolder,
  handlePanelNavMessage,
  installSnlDocWatcher
} from './panelUtil';

/**
 * Per-mode-and-identity singleton manager for the SNL Relationship editor
 * panel (cat 2026-07-10). Mirrors {@link CreateEntryPanel}'s shape:
 *
 *  - `snlDoc.createRelationship` → create-mode (no identity).
 *  - `snlDoc.editRelationship`   → edit-mode keyed by relationship id.
 *
 * Message protocol with the webview (`createRelationship.js`):
 *  - in  : `{ type: 'ready' }` (asks for context)
 *        | `{ type: 'create', relationship: RelationshipData }`
 *        | `{ type: 'update', relationship: Omit<RelationshipData,'id'> }`
 *  - out : `{ type: 'context', mode, id?, existing?, entryPool[] }`
 *        | `{ type: 'created' | 'updated' | 'duplicate'
 *            | 'unknownEndpoint' | 'notFound' | 'invalid'
 *            | 'noSnlDoc' | 'noWorkspace' | 'error', ... }`
 */
export class CreateRelationshipPanel {
  private static readonly instances = new Map<string, CreateRelationshipPanel>();

  private static readonly viewType = 'snlCreateRelationship';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  private readonly id: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateRelationshipPanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, id: string): void {
    if (!id) return;
    CreateRelationshipPanel.open(extensionUri, 'edit', id);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${id}`;

    const existing = CreateRelationshipPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit'
        ? `SNL Edit Relationship — ${id}`
        : 'SNL Create Relationship';
    const panel = vscode.window.createWebviewPanel(
      CreateRelationshipPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateRelationshipPanel.instances.set(
      key,
      new CreateRelationshipPanel(panel, extensionUri, mode, id)
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
      'createRelationship',
      mode === 'edit'
        ? `SNL Edit Relationship — ${id}`
        : 'SNL Create Relationship'
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
    const root = firstWorkspaceFolder();
    let existing: RelationshipData | null = null;
    let entryPool: Array<{ id: string; title: string }> = [];
    let existingIds: string[] = [];
    if (root) {
      try {
        const entries = await readEntries(root);
        entryPool = entries.map((e) => ({
          id: e.id,
          title: e.title ?? ''
        }));
      } catch {
        entryPool = [];
      }
      try {
        const rels = await readRelationships(root);
        existingIds = rels.map((r) => r.id);
        if (this.mode === 'edit') {
          existing = rels.find((r) => r.id === this.id) ?? null;
        }
      } catch {
        existingIds = [];
      }
    }
    void this.panel.webview.postMessage({
      type: 'context',
      mode: this.mode,
      id: this.id || undefined,
      existing,
      entryPool,
      existingIds
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.pushContext())) return;
    const msg = message as
      | { type?: string; relationship?: RelationshipData }
      | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') return;

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = 'SNL Relationship editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: text });
      return;
    }

    const rel = msg.relationship;
    if (!rel || typeof rel !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: 'no relationship payload'
      });
      return;
    }

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateRelationship(root, this.id, {
          from: rel.from,
          to: rel.to,
          label: rel.label,
          metadata: rel.metadata
        });
        switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Relationship "${result.id}" updated.`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              id: result.id
            });
            return;
          case 'notFound': {
            const text = `Relationship "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              id: result.id,
              message: text
            });
            return;
          }
          case 'unknownEndpoint': {
            const text = `Unknown ${result.endpoint} entry: "${result.id}".`;
            vscode.window.showWarningMessage(text);
            void this.panel.webview.postMessage({
              type: 'unknownEndpoint',
              endpoint: result.endpoint,
              id: result.id,
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
          case 'error':
            void this.panel.webview.postMessage({
              type: 'error',
              message: result.message
            });
            return;
        }
        return;
      }
      // Create path.
      const result = await addRelationship(root, rel);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Relationship "${result.id}" created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            id: result.id
          });
          return;
        case 'duplicate': {
          const text = `Relationship id "${result.id}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            id: result.id,
            message: text
          });
          return;
        }
        case 'unknownEndpoint': {
          const text = `Unknown ${result.endpoint} entry: "${result.id}".`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'unknownEndpoint',
            endpoint: result.endpoint,
            id: result.id,
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
        case 'noSnlDoc': {
          const text = '.SNL_Doc does not exist yet. Run "SNL: Init" first.';
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'noSnlDoc',
            message: text
          });
          return;
        }
        case 'error':
          void this.panel.webview.postMessage({
            type: 'error',
            message: result.message
          });
          return;
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`SNL Relationship editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.id}`;
    CreateRelationshipPanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}
