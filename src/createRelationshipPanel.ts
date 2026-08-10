import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  { createTitle: 'SNL Create Relationship', editTitle: 'SNL Edit Relationship — {id}', loadFailed: 'Could not load Relationship editor data: {error}', noWorkspace: 'SNL Relationship editor requires an open folder / workspace.', noPayload: 'No relationship payload was provided.', updated: 'Relationship “{id}” updated.', conflict: 'Relationship “{id}” changed after this editor opened. Reload before saving.', notFound: 'Relationship “{id}” no longer exists.', unknownEndpoint: 'Unknown {endpoint} entry: “{id}”.', initFirst: '.SNL_Doc does not exist yet. Run “SNL: Init” first.', created: 'Relationship “{id}” created.', duplicate: 'Relationship id “{id}” already exists.', editorFailed: 'SNL Relationship editor failed: {error}' },
  { createTitle: 'SNL 创建关系', editTitle: 'SNL 编辑关系 — {id}', loadFailed: '无法加载关系编辑器数据：{error}', noWorkspace: 'SNL 关系编辑器需要打开文件夹或工作区。', noPayload: '未提供关系数据。', updated: '关系“{id}”已更新。', conflict: '关系“{id}”在此编辑器打开后发生了变化。请重新加载后再保存。', notFound: '关系“{id}”已不存在。', unknownEndpoint: '未知的{endpoint}条目：“{id}”。', initFirst: '.SNL_Doc 尚不存在。请先运行“SNL：初始化”。', created: '关系“{id}”已创建。', duplicate: '关系 ID“{id}”已存在。', editorFailed: 'SNL 关系编辑器失败：{error}' }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
import {
  addRelationship,
  entityRevision,
  readEntries,
  readRelationships,
  updateRelationship,
  type EntryData,
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
  private contextGeneration = 0;

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

    const title = mode === 'edit' ? hostText()('editTitle', { id }) : hostText()('createTitle');
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
    bind_preferences_panel_title(panel, () => mode === 'edit'
      ? hostText()('editTitle', { id })
      : hostText()('createTitle'));

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
      mode === 'edit' ? hostText()('editTitle', { id }) : hostText()('createTitle'), this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    installSnlDocWatcher(this.disposables, () => this.pushContext());

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const generation = ++this.contextGeneration;
    const root = firstWorkspaceFolder();
    let existing: RelationshipData | null = null;
    let relationshipRevision: string | undefined;
    let entryPool: Array<{ id: string; title: EntryData['title'] }> = [];
    let existingIds: string[] = [];
    if (root) {
      try {
        const [entries, rels] = await Promise.all([
          readEntries(root),
          readRelationships(root)
        ]);
        if (generation !== this.contextGeneration) return;
        entryPool = entries.map((e) => ({ id: e.id, title: e.title ?? '' }));
        existingIds = rels.map((r) => r.id);
        if (this.mode === 'edit') {
          existing = rels.find((r) => r.id === this.id) ?? null;
          relationshipRevision = existing ? entityRevision(existing) : undefined;
        }
      } catch (error) {
        if (generation !== this.contextGeneration) return;
        void this.panel.webview.postMessage({
          type: 'error',
          message: hostText()('loadFailed', { error: error instanceof Error ? error.message : String(error) })
        });
        return;
      }
    }
    if (generation !== this.contextGeneration) return;
    void this.panel.webview.postMessage({
      type: 'context',
      mode: this.mode,
      targetState: existing ? 'found' : this.mode === 'edit' ? 'notFound' : 'found',
      id: this.id || undefined,
      existing,
      relationshipRevision,
      entryPool,
      existingIds
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.pushContext())) return;
    const msg = message as
      | { type?: string; relationship?: RelationshipData; expectedRevision?: string }
      | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') return;

    const root = firstWorkspaceFolder();
    if (!root) {
      const text = hostText()('noWorkspace');
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: text });
      return;
    }

    const rel = msg.relationship;
    if (!rel || typeof rel !== 'object') {
      void this.panel.webview.postMessage({
        type: 'invalid',
        reason: hostText()('noPayload')
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
        }, msg.expectedRevision);
        switch (result.status) {
          case 'updated':
            vscode.window.showInformationMessage(
              hostText()('updated', { id: result.id })
            );
            await this.panel.webview.postMessage({
              type: 'updated',
              id: result.id
            });
            await this.pushContext();
            return;
          case 'conflict': {
            const text = hostText()('conflict', { id: result.id });
            vscode.window.showWarningMessage(text);
            void this.panel.webview.postMessage({ type: 'conflict', id: result.id, message: text });
            return;
          }
          case 'notFound': {
            const text = hostText()('notFound', { id: result.id });
            vscode.window.showErrorMessage(text);
            void this.panel.webview.postMessage({
              type: 'notFound',
              id: result.id,
              message: text
            });
            return;
          }
          case 'unknownEndpoint': {
            const text = hostText()('unknownEndpoint', { endpoint: result.endpoint, id: result.id });
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
            const text = hostText()('initFirst');
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
            hostText()('created', { id: result.id })
          );
          void this.panel.webview.postMessage({
            type: 'created',
            id: result.id
          });
          return;
        case 'duplicate': {
          const text = hostText()('duplicate', { id: result.id });
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
          const text = hostText()('initFirst');
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
      vscode.window.showErrorMessage(hostText()('editorFailed', { error: text }));
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
