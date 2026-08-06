import * as vscode from 'vscode';
import { bind_preferences_panel_title } from './preferencesHost';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { read_extension_preferences } from './preferences';

const MESSAGES = defineHostMessages(
  { createEntryTitle: 'SNL Create Entry Kind', editEntryTitle: 'SNL Edit Entry Kind — {id}', createMacroTitle: 'SNL Create Macro Kind', editMacroTitle: 'SNL Edit Macro Kind — {id}', loadFailed: 'Could not load Kind editor data: {error}', noWorkspace: 'Kind editor requires an open folder / workspace.', editorFailed: 'SNL kind editor failed: {error}', saved: '{domain} kind “{name}” ({id}) {status}.', duplicate: '{domain} kind id “{id}” already exists.', notFound: '{domain} kind “{id}” no longer exists.', conflict: '{domain} kind “{id}” changed after this editor opened. Reload before saving.', initFirst: '.SNL_Doc does not exist yet. Run “SNL: Init” first.', unable: 'Unable to save {domain} kind.', entry: 'Entry', macro: 'Macro', created: 'created', updated: 'updated' },
  { createEntryTitle: 'SNL 创建条目类型', editEntryTitle: 'SNL 编辑条目类型 — {id}', createMacroTitle: 'SNL 创建宏类型', editMacroTitle: 'SNL 编辑宏类型 — {id}', loadFailed: '无法加载类型编辑器数据：{error}', noWorkspace: '类型编辑器需要打开文件夹或工作区。', editorFailed: 'SNL 类型编辑器失败：{error}', saved: '{domain}类型“{name}”（{id}）已{status}。', duplicate: '{domain}类型 ID“{id}”已存在。', notFound: '{domain}类型“{id}”已不存在。', conflict: '{domain}类型“{id}”在此编辑器打开后发生了变化。请重新加载后再保存。', initFirst: '.SNL_Doc 尚不存在。请先运行“SNL：初始化”。', unable: '无法保存{domain}类型。', entry: '条目', macro: '宏', created: '创建', updated: '更新' }
);
const hostText = () => createHostTranslator(read_extension_preferences().language, MESSAGES);
import {
  createEntryKind,
  createMacroKind,
  entityRevision,
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
    const t = hostText();
    const title = domain === 'entry'
      ? mode === 'edit' ? t('editEntryTitle', { id }) : t('createEntryTitle')
      : mode === 'edit' ? t('editMacroTitle', { id }) : t('createMacroTitle');
    const panel = vscode.window.createWebviewPanel(descriptor.viewType, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    });
    bind_preferences_panel_title(panel, () => {
      const next = hostText();
      return domain === 'entry'
        ? mode === 'edit' ? next('editEntryTitle', { id }) : next('createEntryTitle')
        : mode === 'edit' ? next('editMacroTitle', { id }) : next('createMacroTitle');
    });
    instances.set(key, new KindPanelController(domain, mode, id, key, panel, extensionUri, title));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private contextGeneration = 0;
  private constructor(
    private readonly domain: KindPanelDomain,
    private readonly mode: Mode,
    private readonly id: string,
    private readonly key: string,
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    title: string
  ) {
    panel.webview.html = buildPanelHtml(extensionUri, panel.webview, kindPanelDescriptor(domain).entry, title, this.disposables);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    installSnlDocWatcher(this.disposables, () => this.pushContext());
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushContext(): Promise<void> {
    const generation = ++this.contextGeneration;
    const root = firstWorkspaceFolder();
    try {
      const kinds = root
        ? this.domain === 'entry'
          ? await readEntryKinds(root)
          : await readMacroKinds(root)
        : [];
      if (generation !== this.contextGeneration) return;
      const existingIds = kinds.map((kind) => ({ id: kind.id, title: kind.name ?? '', hasContent: true }));
      const existing = this.mode === 'edit' ? kinds.find((kind) => kind.id === this.id) ?? null : undefined;
      void this.panel.webview.postMessage({
        type: 'context',
        mode: this.mode,
        targetState: existing ? 'found' : this.mode === 'edit' ? 'notFound' : 'found',
        id: this.id || undefined,
        existing,
        kindRevision: existing ? entityRevision(existing) : undefined,
        existingIds
      });
    } catch (error) {
      if (generation !== this.contextGeneration) return;
      void this.panel.webview.postMessage({
        type: 'error',
        message: hostText()('loadFailed', { error: error instanceof Error ? error.message : String(error) })
      });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.pushContext())) return;
    const msg = message as { type?: string; payload?: Record<string, unknown>; expectedRevision?: string } | undefined;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      await this.pushContext();
      return;
    }
    if (msg.type !== 'create' && msg.type !== 'update') return;
    const root = firstWorkspaceFolder();
    if (!root) {
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: hostText()('noWorkspace') });
      return;
    }
    try {
      if (this.domain === 'entry') await this.saveEntry(root, msg.type, msg.payload ?? {}, msg.expectedRevision);
      else await this.saveMacro(root, msg.type, msg.payload ?? {}, msg.expectedRevision);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(hostText()('editorFailed', { error: text }));
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private async saveEntry(root: vscode.Uri, action: string, payload: Record<string, unknown>, expectedRevision?: string): Promise<void> {
    const input = {
      name: stringValue(payload.name),
      stroke: stringValue(payload.stroke),
      background: stringValue(payload.background),
      defaultCounterName: stringValue(payload.defaultCounterName),
      style: stringValue(payload.style)
    };
    const result = action === 'update' || this.mode === 'edit'
      ? await updateEntryKind(root, this.id, input, expectedRevision)
      : await createEntryKind(root, { id: stringValue(payload.id), ...input });
    this.publishResult(result, 'entry');
  }

  private async saveMacro(root: vscode.Uri, action: string, payload: Record<string, unknown>, expectedRevision?: string): Promise<void> {
    const fields = {
      name: stringValue(payload.name),
      description: stringValue(payload.description),
      coloring: { stroke: stringValue(payload.stroke), background: stringValue(payload.background) }
    };
    const result = action === 'update' || this.mode === 'edit'
      ? await updateMacroKind(root, this.id, fields, expectedRevision)
      : await createMacroKind(root, { id: stringValue(payload.id), ...fields });
    this.publishResult(result, 'macro');
  }

  private publishResult(result: { status: string; [key: string]: unknown }, domain: 'entry' | 'macro'): void {
    const t = hostText();
    const domainText = t(domain);
    if ((result.status === 'created' || result.status === 'updated') && result.kind) {
      const kind = result.kind as { id: string; name: string };
      vscode.window.showInformationMessage(t('saved', { domain: domainText, name: kind.name, id: kind.id, status: t(result.status) }));
      void this.panel.webview.postMessage({ type: result.status, kind })
        .then(() => this.pushContext());
      return;
    }
    const id = typeof result.id === 'string' ? result.id : this.id;
    const message = typeof result.message === 'string'
      ? result.message
      : result.status === 'duplicate'
        ? t('duplicate', { domain: domainText, id })
        : result.status === 'notFound'
          ? t('notFound', { domain: domainText, id })
          : result.status === 'conflict'
            ? t('conflict', { domain: domainText, id })
          : result.status === 'noSnlDoc'
            ? t('initFirst')
            : t('unable', { domain: domainText });
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
