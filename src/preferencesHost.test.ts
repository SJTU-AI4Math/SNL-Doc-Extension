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
  } {
    let receive = (_message: unknown): void => undefined;
    const postMessage = vi.fn().mockResolvedValue(true);
    host.register({
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receive = listener;
        return { dispose: vi.fn() };
      },
      postMessage
    } as never);
    return { receive: (message) => receive(message), postMessage };
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

  it('reports a rejected configuration write to VS Code and the source Webview', async () => {
    mocks.update.mockRejectedValue(new Error('read only'));
    const host = new PreferencesHost();
    const { receive, postMessage } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'en' });
    await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalled());
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'snl.preferences/error',
      message: expect.stringContaining('read only')
    }));
    host.dispose();
  });
});
