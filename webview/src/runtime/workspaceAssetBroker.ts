import type { VsCodeApi } from '../vscodeApi';

interface PendingAsset {
  path: string;
  request_id: string;
}

type AssetResolution =
  | { status: 'pending'; request_id: string }
  | { status: 'ready'; url: string }
  | { status: 'missing' };

let nextRequest = 0;

function decodeWorkspacePath(src: string, base: string): string | undefined {
  const prefix = `${base.replace(/\/$/, '')}/`;
  if (!src.startsWith(prefix)) return undefined;
  try {
    const path = decodeURIComponent(src.slice(prefix.length).split(/[?#]/)[0]);
    if (!path || path.includes('\\') || path.startsWith('/') ||
        path.includes('?') || path.includes('#') ||
        path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      return undefined;
    }
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Convert legacy Markdown workspace-image URLs into host-brokered trusted-cache
 * URLs. The workspace assets directory itself is deliberately not a Webview
 * localResourceRoot.
 */
export function installWorkspaceAssetBroker(api: Pick<VsCodeApi, 'postMessage'>): {
  dispose(): void;
} {
  const base = document.documentElement.dataset.snlAssetBaseUri?.replace(/\/$/, '') ?? '';
  const current = new WeakMap<HTMLImageElement, PendingAsset>();
  const resolutions = new Map<string, AssetResolution>();
  let disposed = false;

  const applyResolution = (
    image: HTMLImageElement,
    path: string,
    resolution: Exclude<AssetResolution, { status: 'pending' }>
  ): void => {
    current.delete(image);
    image.dataset.snlAssetPath = path;
    if (resolution.status === 'ready') {
      delete image.dataset.snlAssetError;
      if (image.getAttribute('src') !== resolution.url) image.src = resolution.url;
    } else {
      image.removeAttribute('src');
      image.dataset.snlAssetError = '';
    }
  };

  const requestPath = (image: HTMLImageElement, path: string): void => {
    image.dataset.snlAssetPath = path;
    const existing = resolutions.get(path);
    if (existing?.status === 'ready' || existing?.status === 'missing') {
      applyResolution(image, path, existing);
      return;
    }

    const request_id = existing?.request_id ?? `snl-markdown-asset-${++nextRequest}`;
    current.set(image, { path, request_id });
    delete image.dataset.snlAssetError;
    image.removeAttribute('src');
    if (existing) return;
    resolutions.set(path, { status: 'pending', request_id });
    api.postMessage({ type: 'snl.assets/resolve', request_id, path });
  };

  const broker = (image: HTMLImageElement): void => {
    if (disposed || !base) return;
    const src = image.getAttribute('src') ?? '';
    const path = decodeWorkspacePath(src, base);
    if (path) requestPath(image, path);
  };

  const retryMissing = (): void => {
    const missingPaths = new Set(
      [...resolutions.entries()]
        .filter(([, resolution]) => resolution.status === 'missing')
        .map(([path]) => path)
    );
    if (!missingPaths.size) return;
    for (const path of missingPaths) resolutions.delete(path);
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-snl-asset-path]')) {
      const path = image.dataset.snlAssetPath;
      if (path && missingPaths.has(path)) requestPath(image, path);
    }
  };

  const scan = (root: ParentNode): void => {
    if (root instanceof HTMLImageElement) broker(root);
    for (const image of root.querySelectorAll?.('img') ?? []) {
      broker(image as HTMLImageElement);
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        broker(record.target);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) scan(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src']
  });
  scan(document);

  const receive = (event: MessageEvent): void => {
    const message = event.data as {
      type?: unknown; request_id?: unknown; path?: unknown; url?: unknown;
    } | null;
    // Host context payloads are workspace refresh boundaries. A missing asset is
    // terminal between boundaries, but must be retried after the workspace may
    // have changed. The explicit invalidation message supports non-context hosts.
    if (message?.type === 'context' || message?.type === 'entryDetails' ||
        message?.type === 'snl.assets/invalidate') {
      retryMissing();
      return;
    }
    if (message?.type !== 'snl.assets/resolved' ||
        typeof message.request_id !== 'string' || typeof message.path !== 'string') return;
    const pending = resolutions.get(message.path);
    if (pending?.status !== 'pending' || pending.request_id !== message.request_id) return;
    const resolution: Exclude<AssetResolution, { status: 'pending' }> =
      typeof message.url === 'string' && message.url
        ? { status: 'ready', url: message.url }
        : { status: 'missing' };
    resolutions.set(message.path, resolution);
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-snl-asset-path]')) {
      const imagePending = current.get(image);
      if (imagePending?.request_id === message.request_id && imagePending.path === message.path) {
        applyResolution(image, message.path, resolution);
      }
    }
  };
  window.addEventListener('message', receive);

  return {
    dispose: () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('message', receive);
      resolutions.clear();
    }
  };
}
