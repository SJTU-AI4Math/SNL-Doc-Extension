import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { extension_preferences_runtime } from './preferences';
import {
  is_supported_language,
  language_configuration_target,
  type ExtensionPreferences,
  type LanguagePreference
} from './preferences-core';
import { createHostTranslator, defineHostMessages } from './hostI18n';
import { BUILT_IN_LANGUAGE_CATALOG } from './languageCatalog';
import type { SupportedLanguageDescriptor } from './workspaceLanguages';

const MESSAGES = defineHostMessages(
  {
    changeLanguageFailed: 'Could not change SNL interface language: {error}',
    addAuthoringLanguageFailed: 'Could not add SNL authoring language: {error}',
    readAuthoringLanguagesFailed: 'Could not read SNL authoring languages: {error}'
  },
  {
    changeLanguageFailed: '无法更改 SNL 界面语言：{error}',
    addAuthoringLanguageFailed: '无法添加 SNL 创作语言：{error}',
    readAuthoringLanguagesFailed: '无法读取 SNL 创作语言：{error}'
  }
);


function workspaceAssetRelativePath(assetRoot: vscode.Uri, uri: vscode.Uri): string | undefined {
  if (uri.scheme !== assetRoot.scheme || uri.authority !== assetRoot.authority) return undefined;
  const prefix = `${assetRoot.path.replace(/\/$/, '')}/`;
  if (!uri.path.startsWith(prefix)) return undefined;
  const path = uri.path.slice(prefix.length);
  if (!path || path.includes('\\') || path.startsWith('/') ||
      path.includes('?') || path.includes('#') ||
      path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return undefined;
  }
  return path;
}

export interface PreferencesSnapshotMessage {
  type: 'snl.preferences/snapshot';
  generation: string;
  revision: number;
  preferences: ExtensionPreferences;
  supported_languages: SupportedLanguageDescriptor[];
}

export interface WorkspaceLanguageService {
  read(): Promise<SupportedLanguageDescriptor[]>;
  add(input: unknown): Promise<unknown>;
}

export interface WorkspaceAssetService {
  resolve(path: string): Promise<string>;
  readSvgSource?(identity: {
    source: string;
    baseIdentity: string;
    revision: string;
  }): Promise<string>;
}

export class PreferencesHost implements vscode.Disposable {
  private readonly webviews = new Set<WeakRef<vscode.Webview>>();
  private readonly webviewRefs = new WeakMap<
    vscode.Webview,
    { ref: WeakRef<vscode.Webview>; listener: vscode.Disposable }
  >();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly languageServices = new Map<WeakRef<vscode.Webview>, WorkspaceLanguageService>();
  private readonly assetServices = new Map<WeakRef<vscode.Webview>, WorkspaceAssetService>();
  private readonly generation = randomUUID();
  private revision = 0;
  private assetRevision = 0;

  constructor(workspaceRoot?: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('snlDoc.locale') ||
            event.affectsConfiguration('snlDoc.appearance') ||
            event.affectsConfiguration('snlDoc.editor.formatter') ||
            event.affectsConfiguration('snlDoc.popovers')) {
          void this.broadcast();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        void this.broadcast();
      })
    );
    if (workspaceRoot) {
      const assetRoot = vscode.Uri.joinPath(workspaceRoot, '.SNL_Doc', 'assets');
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, '.SNL_Doc/assets/**')
      );
      const invalidate = (uri: vscode.Uri): void => {
        const path = workspaceAssetRelativePath(assetRoot, uri);
        if (path) void this.broadcastAssetInvalidation(path);
      };
      watcher.onDidCreate(invalidate, null, this.disposables);
      watcher.onDidChange(invalidate, null, this.disposables);
      watcher.onDidDelete(invalidate, null, this.disposables);
      this.disposables.push(watcher);
    }
  }

  register(
    webview: vscode.Webview,
    languageService?: WorkspaceLanguageService,
    assetService?: WorkspaceAssetService
  ): vscode.Disposable {
    const existing = this.webviewRefs.get(webview);
    if (existing) {
      this.webviews.add(existing.ref);
      if (languageService) this.languageServices.set(existing.ref, languageService);
      if (assetService) this.assetServices.set(existing.ref, assetService);
      return { dispose: () => undefined };
    }
    const ref = new WeakRef(webview);
    this.webviews.add(ref);
    if (languageService) this.languageServices.set(ref, languageService);
    if (assetService) this.assetServices.set(ref, assetService);
    const listener = webview.onDidReceiveMessage((message: unknown) => {
      const incoming = message as { type?: unknown; language?: unknown } | null;
      if (incoming?.type === 'snl.preferences/ready') {
        const target = ref.deref();
        if (target) void this.send(target, ref);
        return;
      }
      if (
        incoming?.type === 'snl.preferences/set-language' &&
        (incoming.language === 'auto' || is_supported_language(incoming.language))
      ) {
        void this.setLanguage(incoming.language);
        return;
      }
      const service = this.languageServices.get(ref);
      if (incoming?.type === 'snl.languages/add' && service) {
        void this.addSupportedLanguage(service, incoming.language);
        return;
      }
      const asset = message as {
        type?: unknown;
        request_id?: unknown;
        path?: unknown;
      } | null;
      const assetService = this.assetServices.get(ref);
      if (asset?.type === 'snl.assets/resolve' && assetService &&
          typeof asset.request_id === 'string' && asset.request_id.length <= 128 &&
          typeof asset.path === 'string') {
        const target = ref.deref();
        if (target) void this.resolveAsset(target, assetService, asset.request_id, asset.path);
      }
      const svg = message as {
        type?: unknown; request_id?: unknown; source?: unknown;
        base_identity?: unknown; revision?: unknown;
      } | null;
      if (svg?.type === 'snl.assets/read-svg-source' && assetService?.readSvgSource &&
          typeof svg.request_id === 'string' && svg.request_id.length <= 128 &&
          typeof svg.source === 'string' && typeof svg.base_identity === 'string' &&
          typeof svg.revision === 'string') {
        const target = ref.deref();
        if (target) void this.resolveSvgSource(target, assetService, {
          request_id: svg.request_id,
          source: svg.source,
          baseIdentity: svg.base_identity,
          revision: svg.revision
        });
      }
    });
    this.webviewRefs.set(webview, { ref, listener });
    return {
      dispose: () => {
        listener.dispose();
        this.webviews.delete(ref);
        this.languageServices.delete(ref);
        this.assetServices.delete(ref);
        this.webviewRefs.delete(webview);
      }
    };
  }

  private async resolveAsset(
    webview: vscode.Webview,
    service: WorkspaceAssetService,
    request_id: string,
    path: string
  ): Promise<void> {
    try {
      const url = await service.resolve(path);
      await webview.postMessage({
        type: 'snl.assets/resolved', request_id, path, url
      });
    } catch (error) {
      await webview.postMessage({
        type: 'snl.assets/resolved',
        request_id,
        path,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async resolveSvgSource(
    webview: vscode.Webview,
    service: WorkspaceAssetService,
    request: { request_id: string; source: string; baseIdentity: string; revision: string }
  ): Promise<void> {
    const envelope = {
      type: 'snl.assets/svg-source-result' as const,
      request_id: request.request_id,
      source: request.source,
      base_identity: request.baseIdentity,
      revision: request.revision
    };
    try {
      const svg_source = await service.readSvgSource!(request);
      await webview.postMessage({ ...envelope, svg_source });
    } catch (error) {
      await webview.postMessage({
        ...envelope,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async addSupportedLanguage(
    service: WorkspaceLanguageService,
    language: unknown
  ): Promise<void> {
    try {
      await service.add(language);
      await this.broadcast();
    } catch (error) {
      const t = createHostTranslator(
        extension_preferences_runtime.query_environment().language,
        MESSAGES
      );
      void vscode.window.showErrorMessage(t('addAuthoringLanguageFailed', {
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  private async setLanguage(language: LanguagePreference): Promise<void> {
    const config = vscode.workspace.getConfiguration('snlDoc');
    const target = language_configuration_target(config.inspect<string>('locale')) === 'workspace'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    try {
      await config.update('locale', language, target);
    } catch (error) {
      const t = createHostTranslator(
        extension_preferences_runtime.query_environment().language,
        MESSAGES
      );
      const message = t('changeLanguageFailed', {
        error: error instanceof Error ? error.message : String(error)
      });
      void vscode.window.showErrorMessage(message);
    }
  }

  private async snapshot(ref: WeakRef<vscode.Webview>): Promise<PreferencesSnapshotMessage> {
    const service = this.languageServices.get(ref);
    let supported_languages: SupportedLanguageDescriptor[] = BUILT_IN_LANGUAGE_CATALOG.map(
      (language) => ({ ...language })
    );
    if (service) {
      try {
        supported_languages = await service.read();
      } catch (error) {
        const t = createHostTranslator(
          extension_preferences_runtime.query_environment().language,
          MESSAGES
        );
        void vscode.window.showErrorMessage(t('readAuthoringLanguagesFailed', {
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return {
      type: 'snl.preferences/snapshot',
      generation: this.generation,
      revision: ++this.revision,
      preferences: extension_preferences_runtime.query_environment(),
      supported_languages
    };
  }

  private async broadcastAssetInvalidation(path: string): Promise<void> {
    const message = {
      type: 'snl.assets/invalidate' as const,
      path,
      revision: ++this.assetRevision
    };
    const deliveries = [...this.webviews].map(async (ref) => {
      const webview = ref.deref();
      if (!webview) {
        this.webviews.delete(ref);
        this.languageServices.delete(ref);
        this.assetServices.delete(ref);
        return;
      }
      try {
        const delivered = await webview.postMessage(message);
        if (!delivered) this.webviews.delete(ref);
      } catch {
        this.webviews.delete(ref);
      }
    });
    await Promise.all(deliveries);
  }

  private async broadcast(): Promise<void> {
    const deliveries = [...this.webviews].map(async (ref) => {
      const webview = ref.deref();
      if (!webview) {
        this.webviews.delete(ref);
        this.languageServices.delete(ref);
        this.assetServices.delete(ref);
        return;
      }
      await this.send(webview, ref);
    });
    await Promise.all(deliveries);
  }

  private async send(webview: vscode.Webview, ref: WeakRef<vscode.Webview>): Promise<void> {
    await this.deliver(webview, ref, await this.snapshot(ref));
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
    this.languageServices.clear();
    this.assetServices.clear();
  }
}

let host: PreferencesHost | undefined;
let assetCacheRoot: vscode.Uri | undefined;

export function initialize_preferences_host(
  context: vscode.ExtensionContext,
  workspaceRoot: vscode.Uri | undefined = vscode.workspace.workspaceFolders?.[0]?.uri
): void {
  host?.dispose();
  host = new PreferencesHost(workspaceRoot);
  assetCacheRoot = context.globalStorageUri;
  context.subscriptions.push(host);
}

export function get_preferences_asset_cache_root(): vscode.Uri | undefined {
  return assetCacheRoot;
}

export function register_preferences_webview(
  webview: vscode.Webview,
  languageService?: WorkspaceLanguageService,
  assetService?: WorkspaceAssetService
): vscode.Disposable {
  return host?.register(webview, languageService, assetService) ?? { dispose: () => undefined };
}

/** Run a callback while a panel is alive whenever the interface locale changes. */
export function bind_preferences_panel_locale_change(
  panel: vscode.WebviewPanel,
  update: () => void
): vscode.Disposable {
  const configuration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('snlDoc.locale')) update();
  });
  const disposed = panel.onDidDispose(() => {
    configuration.dispose();
    disposed.dispose();
  });
  return { dispose: () => { configuration.dispose(); disposed.dispose(); } };
}

/** Keep a VS Code tab title in sync with live interface-locale changes. */
export function bind_preferences_panel_title(
  panel: vscode.WebviewPanel,
  title: () => string
): vscode.Disposable {
  return bind_preferences_panel_locale_change(panel, () => { panel.title = title(); });
}
