import * as vscode from 'vscode';
import {
  applyMacroKindsPreset,
  MACRO_KIND_PRESETS,
  readMacroKinds
} from './snlDoc';
import { buildPanelHtml, firstWorkspaceFolder, handlePanelNavMessage } from './panelUtil';

/**
 * Singleton manager for the `SNL: Initialize Macro Kinds` webview panel.
 *
 * The panel lets the user seed `config.json#macro_kinds` from a preset
 * (currently one: SNL-Basics defaults). Only offered when the catalog is
 * still empty — clobbering an existing catalog needs a diff/confirm UI we
 * haven't built yet, so `applyMacroKindsPreset` refuses in that case and the
 * webview surfaces the reason.
 *
 * Message protocol with the webview (`initMacroKinds.js`):
 *  - in  : `{ type: 'ready' }`
 *        | `{ type: 'apply', presetId: string }`
 *  - out : `{ type: 'init', presets: PresetOption[], existing: number }`
 *        | `{ type: 'applied', presetId, count }`
 *        | `{ type: 'nonEmpty', existing }`
 *        | `{ type: 'noSnlDoc' | 'noWorkspace' | 'unknownPreset' | 'error', message }`
 */
export class InitMacroKindsPanel {
  public static currentPanel: InitMacroKindsPanel | undefined;

  private static readonly viewType = 'snlInitMacroKinds';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.ViewColumn.Active;

    if (InitMacroKindsPanel.currentPanel) {
      InitMacroKindsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      InitMacroKindsPanel.viewType,
      'SNL Initialize Macro Kinds',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    InitMacroKindsPanel.currentPanel = new InitMacroKindsPanel(
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
      'initMacroKinds',
      'SNL Initialize Macro Kinds'
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
    const existing = root ? (await readMacroKinds(root)).length : 0;
    const presets = MACRO_KIND_PRESETS.map((p) => ({
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
    // Nav messages (back to Dashboard / Infoview) MUST be intercepted
    // before any type-filter early-return below drops them silently.
    // Cat 2026-07-10 caught this on Edit Library; every save-oriented
    // panel had the same shape.
    if (await handlePanelNavMessage(message)) {
      return;
    }
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
        'SNL Initialize Macro Kinds requires an open folder / workspace.';
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
      const result = await applyMacroKindsPreset(root, presetId);
            switch (result.status) {
        case 'applied':
          vscode.window.showInformationMessage(
            `Applied preset "${presetId}" — ${result.count} macro kind${
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
          const text = `macro_kinds already has ${result.existing} entr${
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
        `SNL Initialize Macro Kinds failed: ${text}`
      );
      void this.panel.webview.postMessage({ type: 'error', message: text });
    }
  }

  public dispose(): void {
    InitMacroKindsPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
