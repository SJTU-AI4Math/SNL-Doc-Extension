import * as vscode from 'vscode';
import {
  applyEntryKindsPreset,
  applyMacroKindsPreset,
  ENTRY_KIND_PRESETS,
  MACRO_KIND_PRESETS,
  readEntryKinds,
  readMacroKinds
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';
import { initKindsPanelDescriptor, type KindsDomain } from './initKindsPanelDescriptor';

const panels = new Map<KindsDomain, InitKindsPanelController>();

export class InitKindsPanelController {
  static createOrShow(domain: KindsDomain, extensionUri: vscode.Uri): void {
    const current = panels.get(domain);
    if (current) {
      current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const descriptor = initKindsPanelDescriptor(domain);
    const panel = vscode.window.createWebviewPanel(
      descriptor.viewType,
      descriptor.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );
    panels.set(domain, new InitKindsPanelController(domain, panel, extensionUri));
  }

  private readonly disposables: vscode.Disposable[] = [];
  private constructor(
    private readonly domain: KindsDomain,
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri
  ) {
    const descriptor = initKindsPanelDescriptor(domain);
    panel.webview.html = buildPanelHtml(extensionUri, panel.webview, descriptor.entry, descriptor.title);
    panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushInit(): Promise<void> {
    const root = firstWorkspaceFolder();
    const existing = root
      ? this.domain === 'entry'
        ? (await readEntryKinds(root)).length
        : (await readMacroKinds(root)).length
      : 0;
    const source = this.domain === 'entry' ? ENTRY_KIND_PRESETS : MACRO_KIND_PRESETS;
    const presets = source.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      count: preset.kinds.length
    }));
    void this.panel.webview.postMessage({ type: 'init', presets, existing });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (await handlePanelNavMessage(message, () => this.pushInit())) return;
    const msg = message as { type?: string; presetId?: unknown } | undefined;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'ready') {
      await this.pushInit();
      return;
    }
    if (msg.type !== 'apply') return;
    const root = firstWorkspaceFolder();
    const descriptor = initKindsPanelDescriptor(this.domain);
    if (!root) {
      const text = `${descriptor.title} requires an open folder / workspace.`;
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({ type: 'noWorkspace', message: text });
      return;
    }
    const presetId = typeof msg.presetId === 'string' ? msg.presetId : '';
    if (!presetId) {
      void this.panel.webview.postMessage({ type: 'error', message: 'No preset selected.' });
      return;
    }
    try {
      const result = this.domain === 'entry'
        ? await applyEntryKindsPreset(root, presetId)
        : await applyMacroKindsPreset(root, presetId);
      if (result.status === 'applied') {
        const text = `Applied preset “${presetId}” — ${result.count} ${result.count === 1 ? descriptor.singular : `${descriptor.singular}s`} added.`;
        vscode.window.showInformationMessage(text);
        void this.panel.webview.postMessage({ type: 'applied', presetId, count: result.count });
      } else if (result.status === 'nonEmpty') {
        const text = `${descriptor.configKey} already has ${result.existing} entries. Presets can only initialize an empty catalog.`;
        vscode.window.showWarningMessage(text);
        void this.panel.webview.postMessage({ type: 'nonEmpty', existing: result.existing, message: text });
      } else if (result.status === 'noSnlDoc') {
        const text = '.SNL_Doc does not exist yet. Run “SNL: Init” first.';
        vscode.window.showErrorMessage(text);
        void this.panel.webview.postMessage({ type: 'noSnlDoc', message: text });
      } else {
        const text = `Unknown preset id: ${result.presetId}`;
        vscode.window.showErrorMessage(text);
        void this.panel.webview.postMessage({ type: 'unknownPreset', message: text });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`${descriptor.title} failed: ${text}`);
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  private dispose(): void {
    panels.delete(this.domain);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
