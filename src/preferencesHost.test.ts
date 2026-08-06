import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  language: 'en',
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
      language: mocks.language,
      language_preference: 'en',
      color_scheme: 'dark',
      motion: 'full'
    })
  }
}));

import { bind_preferences_panel_title, PreferencesHost } from './preferencesHost';

describe('PreferencesHost language writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.language = 'en';
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

  it('writes Auto so the selector can restore VS Code following mode', async () => {
    const host = new PreferencesHost();
    const { receive } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'auto' });
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith('locale', 'auto', 1);
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

  it('reports a rejected language write in the effective Chinese locale', async () => {
    mocks.language = 'zh-CN';
    mocks.update.mockRejectedValue(new Error('read only'));
    const host = new PreferencesHost();
    const { receive, postMessage } = register(host);

    receive({ type: 'snl.preferences/set-language', language: 'en' });
    await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      '无法更改 SNL 界面语言：read only'
    ));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'snl.preferences/error',
      message: '无法更改 SNL 界面语言：read only'
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
