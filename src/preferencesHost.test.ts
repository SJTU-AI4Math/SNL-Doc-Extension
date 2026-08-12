import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  language: 'en',
  update: vi.fn(),
  inspect: vi.fn(),
  showErrorMessage: vi.fn(),
  configListener: vi.fn(),
  themeListener: vi.fn(),
  assetCreate: vi.fn(),
  assetChange: vi.fn(),
  assetDelete: vi.fn(),
  watcherDispose: vi.fn()
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  Uri: {
    joinPath: (base: { path: string; scheme?: string; authority?: string }, ...segments: string[]) => ({
      ...base, path: [base.path.replace(/\/$/, ''), ...segments].join('/')
    })
  },
  workspace: {
    createFileSystemWatcher: () => ({
      onDidCreate: (listener: unknown) => { mocks.assetCreate(listener); return { dispose: vi.fn() }; },
      onDidChange: (listener: unknown) => { mocks.assetChange(listener); return { dispose: vi.fn() }; },
      onDidDelete: (listener: unknown) => { mocks.assetDelete(listener); return { dispose: vi.fn() }; },
      dispose: mocks.watcherDispose
    }),
    onDidChangeConfiguration: (listener: unknown) => {
      mocks.configListener(listener);
      return { dispose: vi.fn() };
    },
    getConfiguration: () => ({
      inspect: mocks.inspect,
      update: mocks.update
    })
  },
  window: {
    onDidChangeActiveColorTheme: (listener: unknown) => {
      mocks.themeListener(listener);
      return { dispose: vi.fn() };
    },
    showErrorMessage: mocks.showErrorMessage
  }
}));

vi.mock('./preferences', () => ({
  extension_preferences_runtime: {
    query_environment: () => ({
      language: mocks.language,
      language_preference: 'en',
      color_scheme: 'dark',
      motion: 'full',
      popover_hover_enabled: false
    })
  }
}));

import {
  bind_preferences_panel_title,
  get_preferences_asset_cache_root,
  initialize_preferences_host,
  register_preferences_webview,
  PreferencesHost
} from './preferencesHost';

describe('PreferencesHost language writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.language = 'en';
    mocks.inspect.mockReturnValue(undefined);
    mocks.update.mockResolvedValue(undefined);
  });

  function register(host: PreferencesHost, languageService?: {
    read(): Promise<Array<{ id: string; display_name: string }>>;
    add(input: unknown): Promise<unknown>;
  }, assetService?: {
    resolve(path: string): Promise<string>;
  }): {
    receive: (message: unknown) => void;
    postMessage: ReturnType<typeof vi.fn>;
    listenerDispose: ReturnType<typeof vi.fn>;
    disposeRegistration: () => void;
  } {
    let receive = (_message: unknown): void => undefined;
    const postMessage = vi.fn().mockResolvedValue(true);
    const listenerDispose = vi.fn();
    const registration = host.register({
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receive = listener;
        return { dispose: listenerDispose };
      },
      postMessage
    } as never, languageService, assetService);
    return {
      receive: (message) => receive(message),
      postMessage,
      listenerDispose,
      disposeRegistration: () => registration.dispose()
    };
  }

  it('exposes extension-owned storage as the only webview asset cache root', () => {
    const root = { path: '/trusted-cache' };
    const subscriptions: Array<{ dispose(): void }> = [];
    initialize_preferences_host({ globalStorageUri: root, subscriptions } as never);
    expect(get_preferences_asset_cache_root()).toBe(root);
    subscriptions.at(-1)?.dispose();
  });

  it('emits exact scoped asset invalidations from the workspace watcher', async () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    const root = { scheme: 'file', authority: '', path: '/workspace' };
    initialize_preferences_host({
      globalStorageUri: { path: '/trusted-cache' },
      subscriptions,
      extensionUri: root,
      workspaceState: {}, globalState: {}, secrets: {}, extension: {},
      storageUri: undefined, storagePath: undefined, globalStoragePath: '',
      logUri: root, logPath: '', extensionMode: 1,
      environmentVariableCollection: {}, asAbsolutePath: () => '',
      languageModelAccessInformation: undefined
    } as never, root as never);
    let receive = (_message: unknown): void => undefined;
    const postMessage = vi.fn().mockResolvedValue(true);
    const registration = register_preferences_webview({
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receive = listener;
        return { dispose: vi.fn() };
      },
      postMessage
    } as never, undefined, { resolve: vi.fn() });
    void receive;
    const changed = mocks.assetChange.mock.calls.at(-1)?.[0] as
      ((uri: { scheme: string; authority: string; path: string }) => void);

    changed({
      scheme: 'file', authority: '',
      path: '/workspace/.SNL_Doc/assets/figures/proof.png'
    });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'snl.assets/invalidate',
      path: 'figures/proof.png',
      revision: 1
    }));
    registration.dispose();
    subscriptions.at(-1)?.dispose();
  });

  it('returns only a host-validated trusted-cache URI for workspace image requests', async () => {
    const assetService = {
      resolve: vi.fn(async (path: string) => `vscode-webview://trusted/${path}`)
    };
    const host = new PreferencesHost();
    const webview = register(host, undefined, assetService);

    webview.receive({
      type: 'snl.assets/resolve',
      request_id: 'asset-1',
      path: 'figures/proof.png'
    });

    await vi.waitFor(() => expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'snl.assets/resolved',
      request_id: 'asset-1',
      path: 'figures/proof.png',
      url: 'vscode-webview://trusted/figures/proof.png'
    }));
    expect(assetService.resolve).toHaveBeenCalledWith('figures/proof.png');
    host.dispose();
  });

  it('writes at workspace scope when a workspace override is effective', async () => {
    mocks.inspect.mockReturnValue({ workspaceValue: 'auto' });
    const host = new PreferencesHost();
    const { receive } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'zh-CN' });
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith('locale', 'zh-CN', 2);
    host.dispose();
  });

  it('writes Auto so the selector can restore VS Code following mode', async () => {
    const host = new PreferencesHost();
    const { receive } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'auto' });
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith('locale', 'auto', 1);
    host.dispose();
  });

  it('lets the owning panel release its Webview preference listener', () => {
    const host = new PreferencesHost();
    const { listenerDispose, disposeRegistration } = register(host);

    disposeRegistration();
    expect(listenerDispose).toHaveBeenCalledOnce();
    host.dispose();
  });

  it('reports a rejected configuration write through the VS Code error UI', async () => {
    mocks.update.mockRejectedValue(new Error('read only'));
    const host = new PreferencesHost();
    const { receive, postMessage } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'en' });
    await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('read only')
    ));
    expect(postMessage).not.toHaveBeenCalled();
    host.dispose();
  });

  it('reports a rejected language write in the effective Chinese locale', async () => {
    mocks.language = 'zh-CN';
    mocks.update.mockRejectedValue(new Error('read only'));
    const host = new PreferencesHost();
    const { receive, postMessage } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'en' });
    await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      '无法更改 SNL 界面语言：read only'
    ));
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'snl.preferences/error'
    }));
    host.dispose();
  });

  it('uses a new generation when the host lifecycle restarts', async () => {
    const first = new PreferencesHost();
    const firstWebview = register(first);
    firstWebview.receive({ type: 'snl.preferences/ready' });
    await vi.waitFor(() => expect(firstWebview.postMessage).toHaveBeenCalled());
    const firstSnapshot = firstWebview.postMessage.mock.calls[0][0] as { generation: string };
    first.dispose();

    const second = new PreferencesHost();
    const secondWebview = register(second);
    secondWebview.receive({ type: 'snl.preferences/ready' });
    await vi.waitFor(() => expect(secondWebview.postMessage).toHaveBeenCalled());
    const secondSnapshot = secondWebview.postMessage.mock.calls[0][0] as { generation: string };
    expect(firstSnapshot.generation).toBeTruthy();
    expect(secondSnapshot.generation).not.toBe(firstSnapshot.generation);
    second.dispose();
  });

  it('includes the repo language catalog and broadcasts additions', async () => {
    const languages = [
      { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
      { id: 'en', display_name: 'English (US)' }
    ];
    const service = {
      read: vi.fn(async () => languages.slice()),
      add: vi.fn(async (input: unknown) => {
        languages.push(input as { id: string; display_name: string });
        return { status: 'added' };
      })
    };
    const host = new PreferencesHost();
    const webview = register(host, service);
    webview.receive({ type: 'snl.preferences/ready' });
    await vi.waitFor(() => expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ supported_languages: languages })
    ));

    webview.receive({
      type: 'snl.languages/add',
      language: { id: 'fr', display_name: 'Français' }
    });
    await vi.waitFor(() => expect(service.add).toHaveBeenCalledWith({
      id: 'fr', display_name: 'Français'
    }));
    await vi.waitFor(() => expect(webview.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        supported_languages: expect.arrayContaining([{ id: 'fr', display_name: 'Français' }])
      })
    ));
    host.dispose();
  });

  it('broadcasts hover-popover preference changes to live Webviews', async () => {
    const host = new PreferencesHost();
    const { postMessage } = register(host);
    const listener = mocks.configListener.mock.calls.at(-1)?.[0] as
      ((event: { affectsConfiguration: (key: string) => boolean }) => void);

    listener({ affectsConfiguration: (key) => key === 'snlDoc.popovers' });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'snl.preferences/snapshot',
        preferences: expect.objectContaining({ popover_hover_enabled: false })
      })
    ));
    host.dispose();
  });

  it('refreshes a live panel title when the interface locale changes', () => {
    let title = 'English title';
    let disposePanel = (): void => undefined;
    const panel = {
      title,
      onDidDispose: (listener: () => void) => {
        disposePanel = listener;
        return { dispose: vi.fn() };
      }
    } as never;
    bind_preferences_panel_title(panel, () => title);
    const listener = mocks.configListener.mock.calls.at(-1)?.[0] as
      ((event: { affectsConfiguration: (key: string) => boolean }) => void);

    title = '中文标题';
    listener({ affectsConfiguration: (key) => key === 'snlDoc.locale' });
    expect((panel as { title: string }).title).toBe('中文标题');
    disposePanel();
  });
});
