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

  it('loads a valid workspace image once across React-style src resets and remounts', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    const authoredSrc = `${base}/stable.png`;
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));

    const image = document.createElement('img');
    image.src = authoredSrc;
    document.body.append(image);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const request = postMessage.mock.calls[0][0] as { request_id: string; path: string };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: request.request_id, path: request.path,
      url: 'vscode-webview://trusted/stable.png'
    } }));
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/stable.png'
    ));

    // react-markdown can re-assert the authored URL on an existing node, and
    // its inline img renderer can replace the node when a hover parent rerenders.
    image.src = authoredSrc;
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/stable.png'
    ));
    image.remove();
    const remounted = document.createElement('img');
    remounted.src = authoredSrc;
    document.body.append(remounted);
    await waitFor(() => expect(remounted.getAttribute('src')).toBe(
      'vscode-webview://trusted/stable.png'
    ));
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a missing workspace image terminal across src resets and remounts', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    const authoredSrc = `${base}/missing.png`;
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));

    const image = document.createElement('img');
    image.src = authoredSrc;
    document.body.append(image);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const request = postMessage.mock.calls[0][0] as { request_id: string; path: string };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: request.request_id, path: request.path
    } }));
    await waitFor(() => expect(image.dataset.snlAssetError).toBe(''));
    expect(image.hasAttribute('src')).toBe(false);

    image.src = authoredSrc;
    await waitFor(() => expect(image.hasAttribute('src')).toBe(false));
    image.remove();
    const remounted = document.createElement('img');
    remounted.src = authoredSrc;
    document.body.append(remounted);
    await waitFor(() => expect(remounted.dataset.snlAssetError).toBe(''));
    expect(remounted.hasAttribute('src')).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('retries a formerly missing image after a host context refresh', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    const authoredSrc = `${base}/created-later.png`;
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));

    const image = document.createElement('img');
    image.src = authoredSrc;
    document.body.append(image);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const missingRequest = postMessage.mock.calls[0][0] as { request_id: string; path: string };
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: missingRequest.request_id,
      path: missingRequest.path
    } }));
    await waitFor(() => expect(image.dataset.snlAssetError).toBe(''));

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', targetGeneration: 1
    } }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const retry = postMessage.mock.calls[1][0] as { request_id: string; path: string };
    expect(retry.path).toBe('created-later.png');
    expect(retry.request_id).not.toBe(missingRequest.request_id);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: retry.request_id, path: retry.path,
      url: 'vscode-webview://trusted/created-later.png'
    } }));
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/created-later.png'
    ));
    expect(image.dataset.snlAssetError).toBeUndefined();
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a pending workspace image across rerenders', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    const authoredSrc = `${base}/pending.png`;
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));
    const first = document.createElement('img');
    first.src = authoredSrc;
    document.body.append(first);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));

    first.src = authoredSrc;
    const second = document.createElement('img');
    second.src = authoredSrc;
    document.body.append(second);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(first.hasAttribute('src')).toBe(false);
    expect(second.hasAttribute('src')).toBe(false);
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
