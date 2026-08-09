// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { installWorkspaceAssetBroker } from './workspaceAssetBroker';

const disposables: Array<{ dispose(): void }> = [];
afterEach(() => {
  while (disposables.length) disposables.pop()?.dispose();
  document.body.replaceChildren();
  delete document.documentElement.dataset.snlAssetBaseUri;
});

describe('workspace asset broker', () => {
  it('replaces a legacy workspace image URI only after a correlated host reply', async () => {
    const postMessage = vi.fn();
    document.documentElement.dataset.snlAssetBaseUri = 'vscode-webview://panel/workspace/assets';
    disposables.push(installWorkspaceAssetBroker({ postMessage }));

    const image = document.createElement('img');
    image.src = 'vscode-webview://panel/workspace/assets/figures/a%20b.png';
    document.body.append(image);

    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const request = postMessage.mock.calls[0][0] as {
      type: string; request_id: string; path: string;
    };
    expect(request).toMatchObject({
      type: 'snl.assets/resolve', path: 'figures/a b.png'
    });
    expect(image.hasAttribute('src')).toBe(false);
    expect(image.dataset.snlAssetPath).toBe('figures/a b.png');

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: 'wrong', path: request.path,
      url: 'vscode-webview://trusted/wrong.png'
    } }));
    expect(image.hasAttribute('src')).toBe(false);

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: request.request_id, path: request.path,
      url: 'vscode-webview://trusted/right.png'
    } }));
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/right.png'
    ));
  });

  it('ignores a late response after the image path has been replaced', async () => {
    const postMessage = vi.fn();
    document.documentElement.dataset.snlAssetBaseUri = 'vscode-webview://panel/workspace/assets';
    disposables.push(installWorkspaceAssetBroker({ postMessage }));
    const image = document.createElement('img');
    image.src = 'vscode-webview://panel/workspace/assets/old.png';
    document.body.append(image);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const oldRequest = postMessage.mock.calls[0][0] as { request_id: string; path: string };

    image.src = 'vscode-webview://panel/workspace/assets/new.png';
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const newRequest = postMessage.mock.calls[1][0] as { request_id: string; path: string };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: oldRequest.request_id,
      path: oldRequest.path, url: 'vscode-webview://trusted/old.png'
    } }));
    expect(image.hasAttribute('src')).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: newRequest.request_id,
      path: newRequest.path, url: 'vscode-webview://trusted/new.png'
    } }));
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/new.png'
    ));
  });
});
