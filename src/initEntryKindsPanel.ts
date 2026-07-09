import * as vscode from 'vscode';
import {
  applyEntryKindsPreset,
  ENTRY_KIND_PRESETS,
  readEntryKinds
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';

/**
 * Singleton manager for the `SNL: Initialize Entry Kinds` webview panel.
 *
 * The panel lets the user seed `config.json#entry_kinds` from a preset
 * (currently 4: Fulcrum's Math Notes, Lean 4, TypeScript, Python). Only
 * offered when the catalog is still empty — clobbering an existing catalog
 * needs a diff/confirm UI we haven't built yet, so `applyEntryKindsPreset`
 * refuses in that case and the webview surfaces the reason.
 *
 * Message protocol with the webview (`initEntryKinds.js`):
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'apply', presetId: string }`
 *  - out : `{ type: 'init', presets: PresetOption[], existing: number }`
 *        | `{ type: 'applied', presetId, count }`
 *        | `{ type: 'nonEmpty', existing }`
 *        | `{ type: 'noSnlDoc' | 'noWorkspace' | 'unknownPreset' | 'error', message }`
 */
export class InitEntryKindsPanel {
  public static currentPanel: InitEntryKindsPanel | undefined;

  private static readonly viewType = 'snlInitEntryKinds';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (InitEntryKindsPanel.currentPanel) {
      InitEntryKindsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InitEntryKindsPanel.viewType,
      'SNL Initialize Entry Kinds',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InitEntryKindsPanel.currentPanel = new InitEntryKindsPanel(
      panel,
      extensionUri
    );
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.webview.html = buildPanelHtml(
      this.extensionUri,
      this.panel.webview,
      'initEntryKinds',
      'SNL Initialize Entry Kinds'
    );

    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async pushInit(): Promise<void> {
    const root = firstWorkspaceFolder();
    const existing = root ? (await readEntryKinds(root)).length : 0;
    const presets = ENTRY_KIND_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      count: p.kinds.length
    }));
    void this.panel.webview.postMessage({
      type: 'init',
      presets,
      existing
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const msg = message as
      | { type?: string; presetId?: string }
      | undefined;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'ready') {
      await this.pushInit();
      return;
    }
    if (msg.type !== 'apply') {
      return;
    }

    const root = firstWorkspaceFolder();
    if (!root) {
      const text =
        'SNL Initialize Entry Kinds requires an open folder / workspace.';
      vscode.window.showErrorMessage(text);
      void this.panel.webview.postMessage({
        type: 'noWorkspace',
        message: text
      });
      return;
    }

    const presetId = typeof msg.presetId === 'string' ? msg.presetId : '';
    if (!presetId) {
      const text = 'No preset selected.';
      void this.panel.webview.postMessage({ type: 'error', message: text });
      return;
    }

    try {
      const result = await applyEntryKindsPreset(root, presetId);
      if (await handlePanelNavMessage(message)) {
        return;
      }
            switch (result.status) {
        case 'applied':
          vscode.window.showInformationMessage(
            `Applied preset "${presetId}" — ${result.count} entry kind${
              result.count === 1 ? '' : 's'
            } added.`
          );
          void this.panel.webview.postMessage({
            type: 'applied',
            presetId,
            count: result.count
          });
          return;
        case 'nonEmpty': {
          const text = `entry_kinds already has ${result.existing} entr${
            result.existing === 1 ? 'y' : 'ies'
          }. Presets can only initialize an empty catalog.`;
          vscode.window.showWarningMessage(text);
          void this.panel.webview.postMessage({
            type: 'nonEmpty',
            existing: result.existing,
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
        case 'unknownPreset': {
          const text = `Unknown preset id: ${result.presetId}`;
          vscode.window.showErrorMessage(text);
          void this.panel.webview.postMessage({
            type: 'unknownPreset',
            message: text
          });
          return;
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(
        `SNL Initialize Entry Kinds failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    InitEntryKindsPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
