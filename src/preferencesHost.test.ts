import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  inspect: vi.fn(),
  showErrorMessage: vi.fn(),
  configListener: vi.fn(),
  themeListener: vi.fn()
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
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
      language: 'en',
      language_preference: 'en',
      color_scheme: 'dark',
      motion: 'full'
    })
  }
}));

import { PreferencesHost } from './preferencesHost';

describe('PreferencesHost language writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspect.mockReturnValue(undefined);
    mocks.update.mockResolvedValue(undefined);
  });

  function register(host: PreferencesHost): {
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
    } as never);
    return {
      receive: (message) => receive(message),
      postMessage,
      listenerDispose,
      disposeRegistration: () => registration.dispose()
    };
  }

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
});
