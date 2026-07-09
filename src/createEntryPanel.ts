import * as vscode from 'vscode';
import {
  addEntry,
  listEntryKinds,
  readAllMacros,
  readEntries,
  updateEntry,
  type EntryData
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder } from './panelUtil';

/**
 * Per-mode-and-identity singleton manager for the SNL Entry editor panel.
 *
 * Two entry points share this class:
 *  - `snlDoc.createEntry` → create-mode panel (no identity).
 *  - `snlDoc.editEntry`   → edit-mode panel keyed by entry id.
 *
 * Message protocol with the webview (`createEntry.js`):
 *  - in  : `{ type: 'ready' }` (asks for context)
 *        | `{ type: 'create', entry: EntryData }`
 *        | `{ type: 'update', entry: Omit<EntryData,'id'> }` (id is the panel key)
 *  - out : `{ type: 'context', mode, kinds, existing? }`
 *        | `{ type: 'kinds', kinds }` (legacy path kept for `ready` without context)
 *        | `{ type: 'created' | 'updated' | 'duplicate' | 'unknownKind'
 *            | 'notFound' | 'invalid' | 'noSnlDoc' | 'noWorkspace'
 *            | 'error', ... }`
 */
export class CreateEntryPanel {
  private static readonly instances = new Map<string, CreateEntryPanel>();

  private static readonly viewType = 'snlCreateEntry';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly mode: 'create' | 'edit';
  private readonly id: string;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    CreateEntryPanel.open(extensionUri, 'create', '');
  }

  public static editOrShow(extensionUri: vscode.Uri, id: string): void {
    if (!id) {
      return;
    }
    CreateEntryPanel.open(extensionUri, 'edit', id);
  }

  private static open(
    extensionUri: vscode.Uri,
    mode: 'create' | 'edit',
    id: string
  ): void {
    const column = vscode.ViewColumn.Active;
    const key = `${mode}:${id}`;

    const existing = CreateEntryPanel.instances.get(key);
    if (existing) {
      existing.panel.reveal(column);
      return;
    }

    const title =
      mode === 'edit' ? `SNL Edit Entry — ${id}` : 'SNL Create Entry';
    const panel = vscode.window.createWebviewPanel(
      CreateEntryPanel.viewType,
      title,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    CreateEntryPanel.instances.set(
      key,
      new CreateEntryPanel(panel, extensionUri, mode, id)
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
      'createEntry',
      mode === 'edit' ? `SNL Edit Entry — ${id}` : 'SNL Create Entry'
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
    const kinds = root ? await listEntryKinds(root) : [];
    // Snapshot every macro from every package in the workspace so the
    // Entry editor's SNL parser/renderer can dispatch on real user macros
    // — not just the bundled fixture DB from @snl-basics. Merged into the
    // webview's macroDb over bundledMacroDb (user macros win on collision).
    const macros = root ? await readAllMacros(root) : {};
    let existing: EntryData | null = null;
    // Full entry pool (id + title) for the id picker's dedupe check in
    // create mode. Cat 2026-07-09: same widget, requireUnique rule. In
    // edit mode we still send it — the webview uses it to know "everyone
    // else's id" (excluding self) for warnings.
    let allEntries: EntryData[] = [];
    if (root) {
      try {
        allEntries = await readEntries(root);
      } catch {
        allEntries = [];
      }
      if (this.mode === 'edit') {
        existing = allEntries.find((e) => e && e.id === this.id) ?? null;
      }
    }
    // Legacy `kinds` payload for backward compat with the current webview code;
    // `context` carries the same info plus mode + existing entry + macros.
    void this.panel.webview.postMessage({ type: 'kinds', kinds });
    void this.panel.webview.postMessage({
      type: 'context',
      mode: this.mode,
      id: this.id || undefined,
      kinds,
      macros,
      existing,
      existingIds: allEntries.map((e) => ({
        id: e.id,
        title: e.title ?? '',
        hasContent:
          typeof e.content?.snl === 'string' && e.content.snl.trim().length > 0
      }))
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; entry?: EntryData }
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
      const text = 'SNL Entry editor requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const entry = msg.entry;
    if (!entry || typeof entry !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: 'no entry payload'
      });
      return;
    }

    try {
      if (msg.type === 'update' || this.mode === 'edit') {
        const result = await updateEntry(root, this.id, {
          kind: entry.kind,
          title: entry.title,
          content: entry.content,
          contribution_info: entry.contribution_info,
          pointer: entry.pointer
        });
        switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              `Entry "${entry.title}" (${result.id}) updated.`
            );
            void this.panel.webview.postMessage({
              type: 'updated',
              id: result.id
            });
            return;
          case 'notFound': {
            const text = `Entry "${result.id}" no longer exists.`;
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              id: result.id,
              message: text
            });
            return;
          }
          case 'unknownKind': {
            const text = `Unknown entry kind: "${result.kind}".`;
            vscode.window.showWarningMessage(text);
            void this.panel.webview.postMessage({
              type: 'unknownKind',
              kind: result.kind,
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
      }
      // Create path.
      const result = await addEntry(root, entry);
      switch (result.status) {
        case 'ok':
          vscode.window.showInformationMessage(
            `Entry "${entry.title}" (${result.id}) created.`
          );
          void this.panel.webview.postMessage({
            type: 'created',
            id: result.id
          });
          return;
        case 'duplicate': {
          const text = `Entry id "${result.id}" already exists.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'duplicate',
            id: result.id,
            message: text
          });
          return;
        }
        case 'unknownKind': {
          const text = `Unknown entry kind: "${result.kind}".`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'unknownKind',
            kind: result.kind,
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
      vscode.window.showErrorMessage(`SNL Entry editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    const key = `${this.mode}:${this.id}`;
    CreateEntryPanel.instances.delete(key);

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
