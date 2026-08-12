// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import {
  installWorkspaceAssetBroker,
  type WorkspaceAssetBrokerStateSnapshot
} from './workspaceAssetBroker';

const disposables: Array<{ dispose(): void }> = [];

function installWithSnapshot(postMessage: ReturnType<typeof vi.fn>):
  () => WorkspaceAssetBrokerStateSnapshot {
  let read = (): WorkspaceAssetBrokerStateSnapshot => {
    throw new Error('workspace asset broker snapshot was not exposed');
  };
  disposables.push(installWorkspaceAssetBroker({ postMessage }, {
    exposeSnapshot: (snapshot) => { read = snapshot; }
  }));
  return () => read();
}
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
    expect(image.getAttribute('src')).toMatch(/^data:image\/gif/);
    expect(image.dataset.snlAssetPath).toBe('figures/a b.png');

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: 'wrong', path: request.path,
      url: 'vscode-webview://trusted/wrong.png'
    } }));
    expect(image.getAttribute('src')).toMatch(/^data:image\/gif/);

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

  it('retries a formerly missing image after a scoped host invalidation', async () => {
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
      type: 'snl.assets/invalidate', path: 'created-later.png', revision: 1
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
    expect(first.getAttribute('src')).toMatch(/^data:image\/gif/);
    expect(second.getAttribute('src')).toMatch(/^data:image\/gif/);
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
    expect(image.getAttribute('src')).toMatch(/^data:image\/gif/);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: newRequest.request_id,
      path: newRequest.path, url: 'vscode-webview://trusted/new.png'
    } }));
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/new.png'
    ));
  });

  it.each(['https://example.com/external.png', ''])(
    'detaches a pending request when authored src becomes %j',
    async (replacement) => {
      const postMessage = vi.fn();
      const base = 'vscode-webview://panel/workspace/assets';
      document.documentElement.dataset.snlAssetBaseUri = base;
      disposables.push(installWorkspaceAssetBroker({ postMessage }));
      const image = document.createElement('img');
      image.src = `${base}/pending.png`;
      document.body.append(image);
      await waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
      const request = postMessage.mock.calls[0][0] as { request_id: string; path: string };

      if (replacement) image.src = replacement;
      else image.removeAttribute('src');
      await waitFor(() => expect(image.dataset.snlAssetPath).toBeUndefined());
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/resolved', request_id: request.request_id, path: request.path,
        url: 'vscode-webview://trusted/late.png'
      } }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(image.getAttribute('src')).toBe(replacement || null);
    }
  );

  it('releases 1000 pending requests when their only consumers become external', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    const snapshot = installWithSnapshot(postMessage);
    const images = Array.from({ length: 1000 }, (_, index) => {
      const image = document.createElement('img');
      image.src = `${base}/pending-${index}.png`;
      return image;
    });
    document.body.append(...images);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1000));
    images.forEach((_image, index) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/invalidate', path: `pending-${index}.png`, revision: index + 1
      } }));
    });
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2000));
    expect(snapshot()).toMatchObject({
      resolutions: 1000, pendingResolutions: 1000, requests: 1000, epochs: 1000,
      consumers: 1000, pendingConsumers: 1000
    });

    images.forEach((image, index) => {
      image.src = `https://example.com/external-${index}.png`;
    });
    await waitFor(() => expect(snapshot()).toEqual({
      resolutions: 0, pendingResolutions: 0, requests: 0, epochs: 0,
      consumers: 0, pendingConsumers: 0
    }));
  });

  it('keeps a shared pending request until its final consumer leaves', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    const snapshot = installWithSnapshot(postMessage);
    const first = document.createElement('img');
    const second = document.createElement('img');
    first.src = `${base}/shared-pending.png`;
    second.src = `${base}/shared-pending.png`;
    document.body.append(first, second);
    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce());

    first.src = 'https://example.com/first.png';
    await waitFor(() => expect(first.dataset.snlAssetPath).toBeUndefined());
    expect(snapshot()).toMatchObject({
      resolutions: 1, pendingResolutions: 1, requests: 1,
      consumers: 1, pendingConsumers: 1
    });

    second.removeAttribute('src');
    await waitFor(() => expect(snapshot()).toEqual({
      resolutions: 0, pendingResolutions: 0, requests: 0, epochs: 0,
      consumers: 0, pendingConsumers: 0
    }));
  });

  it('drops an orphaned pending path after unmount and ignores its late reply', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));
    const image = document.createElement('img');
    image.src = `${base}/orphan.png`;
    document.body.append(image);
    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const oldRequest = postMessage.mock.calls[0][0] as { request_id: string; path: string };

    image.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: oldRequest.request_id, path: oldRequest.path,
      url: 'vscode-webview://trusted/orphan-old.png'
    } }));
    const remounted = document.createElement('img');
    remounted.src = `${base}/orphan.png`;
    document.body.append(remounted);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(postMessage.mock.calls[1][0]).toMatchObject({ path: 'orphan.png' });
    expect((postMessage.mock.calls[1][0] as { request_id: string }).request_id)
      .not.toBe(oldRequest.request_id);
  });

  it('separates query identities and preserves their semantics on trusted URLs', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));
    const first = document.createElement('img');
    first.src = `${base}/same.png?revision=one`;
    const second = document.createElement('img');
    second.src = `${base}/same.png?revision=two`;
    document.body.append(first, second);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const requests = postMessage.mock.calls.map(([request]) => request as {
      request_id: string; path: string;
    });
    expect(requests.map(({ path }) => path)).toEqual(['same.png', 'same.png']);
    for (const request of requests) {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/resolved', request_id: request.request_id, path: request.path,
        url: 'vscode-webview://trusted/same.png'
      } }));
    }
    await waitFor(() => expect(first.getAttribute('src')).toBe(
      'vscode-webview://trusted/same.png?revision=one'
    ));
    expect(second.getAttribute('src')).toBe(
      'vscode-webview://trusted/same.png?revision=two'
    );
  });

  it('ignores 1000 invalidations for unknown paths without retaining epochs', () => {
    const postMessage = vi.fn();
    document.documentElement.dataset.snlAssetBaseUri =
      'vscode-webview://panel/workspace/assets';
    const snapshot = installWithSnapshot(postMessage);

    for (let index = 0; index < 1000; index += 1) {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/invalidate', path: `unknown-${index}.png`, revision: index + 1
      } }));
    }

    expect(snapshot()).toEqual({
      resolutions: 0, pendingResolutions: 0, requests: 0, epochs: 0,
      consumers: 0, pendingConsumers: 0
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores an old pending reply after invalidation and applies the refresh', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    const snapshot = installWithSnapshot(postMessage);
    const image = document.createElement('img');
    image.src = `${base}/racing.png`;
    document.body.append(image);
    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const oldRequest = postMessage.mock.calls[0][0] as { request_id: string; path: string };

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/invalidate', path: oldRequest.path, revision: 1
    } }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const refresh = postMessage.mock.calls[1][0] as { request_id: string; path: string };
    expect(refresh.request_id).not.toBe(oldRequest.request_id);
    expect(snapshot()).toMatchObject({ pendingResolutions: 1, requests: 1, epochs: 1, pendingConsumers: 1 });

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: oldRequest.request_id, path: oldRequest.path,
      url: 'vscode-webview://trusted/stale.png'
    } }));
    expect(image.getAttribute('src')).toMatch(/^data:image\/gif/);
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: refresh.request_id, path: refresh.path,
      url: 'vscode-webview://trusted/fresh-racing.png'
    } }));
    await waitFor(() => expect(image.getAttribute('src')).toBe(
      'vscode-webview://trusted/fresh-racing.png'
    ));
  });

  it('invalidates only the scoped path and refreshes ready and missing nodes', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));
    const ready = document.createElement('img');
    ready.src = `${base}/changed.png`;
    const missing = document.createElement('img');
    missing.src = `${base}/missing.png`;
    document.body.append(ready, missing);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    const [readyRequest, missingRequest] = postMessage.mock.calls.map(([request]) => request as {
      request_id: string; path: string;
    });
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: readyRequest.request_id, path: readyRequest.path,
      url: 'vscode-webview://trusted/old.png'
    } }));
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: missingRequest.request_id, path: missingRequest.path
    } }));
    await waitFor(() => expect(ready.getAttribute('src')).toBe('vscode-webview://trusted/old.png'));

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'popoverEntryDetails', entryId: 'unrelated'
    } }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(postMessage).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/invalidate', path: 'changed.png', revision: 7
    } }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(3));
    const refresh = postMessage.mock.calls[2][0] as { request_id: string; path: string };
    expect(refresh.path).toBe('changed.png');
    expect(ready.getAttribute('src')).toMatch(/^data:image\/gif/);
    expect(missing.dataset.snlAssetError).toBe('');
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: refresh.request_id, path: refresh.path,
      url: 'vscode-webview://trusted/fresh.png'
    } }));
    await waitFor(() => expect(ready.getAttribute('src')).toBe('vscode-webview://trusted/fresh.png'));
  });

  it('bounds settled resolutions while keeping pending requests correlated', async () => {
    const postMessage = vi.fn();
    const base = 'vscode-webview://panel/workspace/assets';
    document.documentElement.dataset.snlAssetBaseUri = base;
    disposables.push(installWorkspaceAssetBroker({ postMessage }));
    const images = Array.from({ length: 130 }, (_, index) => {
      const image = document.createElement('img');
      image.src = `${base}/cache-${index}.png`;
      return image;
    });
    document.body.append(...images);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(130));
    const requests = postMessage.mock.calls.map(([request]) => request as {
      request_id: string; path: string;
    });

    const oldest = requests[0];
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'snl.assets/resolved', request_id: oldest.request_id, path: oldest.path,
      url: 'vscode-webview://trusted/cache-0.png'
    } }));
    await waitFor(() => expect(images[0].getAttribute('src')).toBe(
      'vscode-webview://trusted/cache-0.png'
    ));
    for (const request of requests.slice(1)) {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.assets/resolved', request_id: request.request_id, path: request.path,
        url: `vscode-webview://trusted/${request.path}`
      } }));
    }
    await waitFor(() => expect(images.at(-1)?.getAttribute('src')).toBe(
      'vscode-webview://trusted/cache-129.png'
    ));

    const remounted = document.createElement('img');
    remounted.src = `${base}/cache-0.png`;
    document.body.append(remounted);
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(131));
    expect(postMessage.mock.calls[130][0]).toMatchObject({ path: 'cache-0.png' });
  });

});
