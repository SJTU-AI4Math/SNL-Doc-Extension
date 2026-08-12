import * as vscode from 'vscode';
import { createEntryPackage } from './snlDoc';
import { validatePackageId } from './packageIdValidation';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage, webviewLocalResourceRoots } from './panelUtil';
import { bind_preferences_panel_title } from './preferencesHost';
import { extension_preferences_runtime } from './preferences';

const MESSAGES = defineHostMessages({
  title: 'SNL Create Entry Package',
  noWorkspace: 'SNL Entry Package editor requires an open folder / workspace.',
  created: 'Entry Package “{id}” created.',
  duplicate: 'Entry Package “{id}” already exists.',
  failed: 'Could not create Entry Package: {error}'
}, {
  title: 'SNL 创建条目包',
  noWorkspace: 'SNL 条目包编辑器需要打开文件夹或工作区。',
  created: '条目包“{id}”已创建。',
  duplicate: '条目包“{id}”已存在。',
  failed: '无法创建条目包：{error}'
});

export function createEntryPackageEditorHostTranslator(language: string) {
  return createHostTranslator(language, MESSAGES);
}

function t() {
  return createEntryPackageEditorHostTranslator(
    extension_preferences_runtime.query_environment().language
  );
}

/** Dedicated creator for the shared Package manifest from the Entry workflow. */
export class CreateEntryPackagePanel {
  private static instance: CreateEntryPackagePanel | undefined;
  private static readonly viewType = 'snlCreateEntryPackage';
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private generation = 0;

  public static createOrShow(extensionUri: vscode.Uri): void {
    if (this.instance) {
      this.instance.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      this.viewType,
      t()('title'),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: webviewLocalResourceRoots(extensionUri)
      }
    );
    bind_preferences_panel_title(panel, () => t()('title'));
    this.instance = new CreateEntryPackagePanel(panel, extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    panel.webview.html = buildPanelHtml(
      extensionUri,
      panel.webview,
      'createEntryPackage',
      t()('title'),
      this.disposables
    );
    panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );
    panel.onDidDispose(() => this.dispose(false), null, this.disposables);
  }

  private async handleMessage(message: unknown): Promise<void> {
    const generation = this.generation;
    if (await handlePanelNavMessage(message, undefined)) return;
    if (this.disposed || generation !== this.generation) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'ready') {
      void this.panel.webview.postMessage({ type: 'context' });
      return;
    }
    if (msg.type !== 'create') return;

    const id = typeof msg.id === 'string' ? msg.id.trim() : '';
    const name = typeof msg.name === 'string' ? msg.name.trim() : '';
    const description = typeof msg.description === 'string' ? msg.description.trim() : '';
    const idValidationError = validatePackageId(id);
    if (idValidationError) {
      if (this.disposed || generation !== this.generation) return;
      void this.panel.webview.postMessage({ type: 'invalid', code: idValidationError });
      return;
    }
    if (!name) {
      void this.panel.webview.postMessage({ type: 'invalid', code: 'name-required' });
      return;
    }
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: t()('noWorkspace') });
      return;
    }

    try {
      const result = await createEntryPackage(root, id, name, description);
      if (this.disposed || generation !== this.generation) return;
      if (result.status === 'ok') {
        void vscode.window.showInformationMessage(t()('created', { id }));
        await this.panel.webview.postMessage({ type: 'created', packageId: id });
        if (this.disposed || generation !== this.generation) return;
        await vscode.commands.executeCommand('snlDoc.openEntryPackage', id);
        if (this.disposed || generation !== this.generation) return;
        return;
      }
      if (result.status === 'duplicate') {
        const messageText = t()('duplicate', { id });
        void vscode.window.showWarningMessage(messageText);
        void this.panel.webview.postMessage({ type: 'duplicate', message: messageText });
        return;
      }
      if (result.status === 'invalid') {
        void this.panel.webview.postMessage({ type: 'invalid', code: 'invalid-format' });
        return;
      }
      if (result.status === 'noSnlDoc') {
        void this.panel.webview.postMessage({ type: 'noWorkspace', message: t()('noWorkspace') });
        return;
      }
      void this.panel.webview.postMessage({
        type: 'error',
        message: t()('failed', { error: result.message })
      });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      void this.panel.webview.postMessage({
        type: 'error',
        message: t()('failed', { error: error instanceof Error ? error.message : String(error) })
      });
    }
  }

  public dispose(disposePanel = true): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    CreateEntryPackagePanel.instance = undefined;
    if (disposePanel) this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
