import * as vscode from 'vscode';
import { extension_preferences_runtime } from './preferences';
import type { ExtensionPreferences } from './preferences-core';

export interface PreferencesSnapshotMessage {
  type: 'snl.preferences/snapshot';
  revision: number;
  preferences: ExtensionPreferences;
}

class PreferencesHost implements vscode.Disposable {
  private readonly webviews = new Set<WeakRef<vscode.Webview>>();
  private readonly webviewRefs = new WeakMap<vscode.Webview, WeakRef<vscode.Webview>>();
  private readonly disposables: vscode.Disposable[] = [];
  private revision = 0;

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('snlDoc.locale') ||
            event.affectsConfiguration('snlDoc.appearance')) {
          void this.broadcast();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        void this.broadcast();
      })
    );
  }

  register(webview: vscode.Webview): void {
    const existing = this.webviewRefs.get(webview);
    if (existing) {
      this.webviews.add(existing);
      return;
    }
    const ref = new WeakRef(webview);
    this.webviewRefs.set(webview, ref);
    this.webviews.add(ref);
    this.disposables.push(webview.onDidReceiveMessage((message: unknown) => {
      if ((message as { type?: unknown } | null)?.type !== 'snl.preferences/ready') return;
      const target = ref.deref();
      if (target) void this.send(target, ref);
    }));
  }

  private snapshot(): PreferencesSnapshotMessage {
    return {
      type: 'snl.preferences/snapshot',
      revision: ++this.revision,
      preferences: extension_preferences_runtime.query_environment()
    };
  }

  private async broadcast(): Promise<void> {
    const message = this.snapshot();
    const deliveries = [...this.webviews].map(async (ref) => {
      const webview = ref.deref();
      if (!webview) {
        this.webviews.delete(ref);
        return;
      }
      await this.deliver(webview, ref, message);
    });
    await Promise.all(deliveries);
  }

  private async send(webview: vscode.Webview, ref: WeakRef<vscode.Webview>): Promise<void> {
    await this.deliver(webview, ref, this.snapshot());
  }

  private async deliver(
    webview: vscode.Webview,
    ref: WeakRef<vscode.Webview>,
    message: PreferencesSnapshotMessage
  ): Promise<void> {
    try {
      const delivered = await webview.postMessage(message);
      if (!delivered) this.webviews.delete(ref);
    } catch {
      this.webviews.delete(ref);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.webviews.clear();
  }
}

let host: PreferencesHost | undefined;

export function initialize_preferences_host(context: vscode.ExtensionContext): void {
  host?.dispose();
  host = new PreferencesHost();
  context.subscriptions.push(host);
}

export function register_preferences_webview(webview: vscode.Webview): void {
  host?.register(webview);
}
