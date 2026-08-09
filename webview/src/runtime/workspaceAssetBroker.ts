import type { VsCodeApi } from '../vscodeApi';

interface PendingAsset {
  image: HTMLImageElement;
  path: string;
  request_id: string;
}

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
  let disposed = false;

  const broker = (image: HTMLImageElement): void => {
    if (disposed || !base) return;
    const src = image.getAttribute('src') ?? '';
    const path = decodeWorkspacePath(src, base);
    if (!path) return;
    const request_id = `snl-markdown-asset-${++nextRequest}`;
    const pending = { image, path, request_id };
    current.set(image, pending);
    image.dataset.snlAssetPath = path;
    image.removeAttribute('src');
    api.postMessage({ type: 'snl.assets/resolve', request_id, path });
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
    if (message?.type !== 'snl.assets/resolved' ||
        typeof message.request_id !== 'string' || typeof message.path !== 'string') return;
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-snl-asset-path]')) {
      const pending = current.get(image);
      if (!pending || pending.request_id !== message.request_id || pending.path !== message.path) {
        continue;
      }
      current.delete(image);
      if (typeof message.url === 'string' && message.url) {
        image.src = message.url;
      } else {
        image.dataset.snlAssetError = '';
      }
      break;
    }
  };
  window.addEventListener('message', receive);

  return {
    dispose: () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('message', receive);
    }
  };
}
