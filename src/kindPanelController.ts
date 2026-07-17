import * as vscode from 'vscode';
import {
  createEntryKind,
  createMacroKind,
  readEntryKinds,
  readMacroKinds,
  updateEntryKind,
  updateMacroKind
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage, installSnlDocWatcher } from './panelUtil';
import { kindPanelDescriptor, type KindPanelDomain } from './kindPanelDescriptor';

type Mode = 'create' | 'edit';
const instances = new Map<string, KindPanelController>();

export class KindPanelController {
  static createOrShow(domain: KindPanelDomain, extensionUri: vscode.Uri): void {
    this.open(domain, extensionUri, 'create', '');
  }
  static editOrShow(domain: KindPanelDomain, extensionUri: vscode.Uri, id: string): void {
    if (id) this.open(domain, extensionUri, 'edit', id);
  }
  private static open(domain: KindPanelDomain, extensionUri: vscode.Uri, mode: Mode, id: string): void {
    const key = `${domain}:${mode}:${id}`;
    const current = instances.get(key);
    if (current) {
      current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const descriptor = kindPanelDescriptor(domain);
    const title = mode === 'edit' ? `SNL Edit ${descriptor.cap} Kind — ${id}` : `SNL Create ${descriptor.cap} Kind`;
    const panel = vscode.window.createWebviewPanel(descriptor.viewType, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    });
    instances.set(key, new KindPanelController(domain, mode, id, key, panel, extensionUri, title));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private constructor(
    private readonly domain: KindPanelDomain,
    private readonly mode: Mode,
    private readonly id: string,
    private readonly key: string,
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    title: string
  ) {
    panel.webview.html = buildPanelHtml(extensionUri, panel.webview, kindPanelDescriptor(domain).entry, title);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    installSnlDocWatcher(this.disposables, () => this.pushContext());
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const root = firstWorkspaceFolder();
    const kinds = root
      ? this.domain === 'entry'
        ? await readEntryKinds(root).catch(() => [])
        : await readMacroKinds(root).catch(() => [])
      : [];
    const existingIds = kinds.map((kind) => ({ id: kind.id, title: kind.name ?? '', hasContent: true }));
    const existing = this.mode === 'edit' ? kinds.find((kind) => kind.id === this.id) ?? null : undefined;
    void this.panel.webview.postMessage({ type: 'context', mode: this.mode, id: this.id || undefined, existing, existingIds });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.pushContext())) return;
    const msg = message as { type?: string; payload?: Record<string, unknown> } | undefined;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') return;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: 'Kind editor requires an open folder / workspace.' });
      return;
    }
    try {
      if (this.domain === 'entry') await this.saveEntry(root, msg.type, msg.payload ?? {});
      else await this.saveMacro(root, msg.type, msg.payload ?? {});
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`SNL kind editor failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private async saveEntry(root: vscode.Uri, action: string, payload: Record<string, unknown>): Promise<void> {
    const input = {
      name: stringValue(payload.name),
      stroke: stringValue(payload.stroke),
      background: stringValue(payload.background),
      defaultCounterName: stringValue(payload.defaultCounterName),
      style: stringValue(payload.style)
    };
    const result = action === 'update' || this.mode === 'edit'
      ? await updateEntryKind(root, this.id, input)
      : await createEntryKind(root, { id: stringValue(payload.id), ...input });
    this.publishResult(result, 'Entry');
  }

  private async saveMacro(root: vscode.Uri, action: string, payload: Record<string, unknown>): Promise<void> {
    const fields = {
      name: stringValue(payload.name),
      description: stringValue(payload.description),
      coloring: { stroke: stringValue(payload.stroke), background: stringValue(payload.background) }
    };
    const result = action === 'update' || this.mode === 'edit'
      ? await updateMacroKind(root, this.id, fields)
      : await createMacroKind(root, { id: stringValue(payload.id), ...fields });
    this.publishResult(result, 'Macro');
  }

  private publishResult(result: { status: string; [key: string]: unknown }, cap: string): void {
    if ((result.status === 'created' || result.status === 'updated') && result.kind) {
      const kind = result.kind as { id: string; name: string };
      vscode.window.showInformationMessage(`${cap} kind “${kind.name}” (${kind.id}) ${result.status}.`);
      void this.panel.webview.postMessage({ type: result.status, kind });
      return;
    }
    const id = typeof result.id === 'string' ? result.id : this.id;
    const message = typeof result.message === 'string'
      ? result.message
      : result.status === 'duplicate'
        ? `${cap} kind id “${id}” already exists.`
        : result.status === 'notFound'
          ? `${cap} kind “${id}” no longer exists.`
          : result.status === 'noSnlDoc'
            ? '.SNL_Doc does not exist yet. Run “SNL: Init” first.'
            : `Unable to save ${cap.toLowerCase()} kind.`;
    void this.panel.webview.postMessage({ type: result.status, id, message });
  }

  private dispose(): void {
    instances.delete(this.key);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
