import type { VsCodeApi } from '../vscodeApi';

interface AssetIdentity {
  key: string;
  path: string;
  authoredSource: string;
  suffix: string;
}

interface AssetAssociation extends AssetIdentity {
  request_id?: string;
  renderedSource: string | null;
}

type AssetResolution =
  | { status: 'pending'; identity: AssetIdentity; request_id: string }
  | { status: 'ready'; identity: AssetIdentity; url: string }
  | { status: 'missing'; identity: AssetIdentity };

export interface WorkspaceAssetBrokerStateSnapshot {
  resolutions: number;
  pendingResolutions: number;
  requests: number;
  epochs: number;
  consumers: number;
  pendingConsumers: number;
}

export interface WorkspaceAssetBrokerTestHooks {
  exposeSnapshot(read: () => WorkspaceAssetBrokerStateSnapshot): void;
}

const SETTLED_CACHE_LIMIT = 128;
const PENDING_SOURCE =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
let nextRequest = 0;

function decodeWorkspaceSource(
  src: string,
  base: string,
  epoch: number
): AssetIdentity | undefined {
  try {
    const normalizedBase = new URL(base).href.replace(/\/$/, '');
    const normalizedSource = new URL(src).href;
    const prefix = `${normalizedBase}/`;
    if (!normalizedSource.startsWith(prefix)) return undefined;
    const remainder = normalizedSource.slice(prefix.length);
    const encodedPath = remainder.split(/[?#]/, 1)[0];
    const path = decodeURIComponent(encodedPath);
    if (!path || path.includes('\\') || path.startsWith('/') ||
        path.includes('?') || path.includes('#') ||
        path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      return undefined;
    }
    const parsed = new URL(normalizedSource);
    return {
      key: `${normalizedBase}\u0000${normalizedSource}\u0000${epoch}`,
      path,
      authoredSource: normalizedSource,
      suffix: `${parsed.search}${parsed.hash}`
    };
  } catch {
    return undefined;
  }
}

function withAuthoredSuffix(url: string, suffix: string): string {
  if (!suffix) return url;
  try {
    const source = new URL(`snl-authored://asset/${suffix}`);
    const trusted = new URL(url);
    trusted.search = source.search;
    trusted.hash = source.hash;
    return trusted.href;
  } catch {
    return url;
  }
}

/**
 * Convert legacy Markdown workspace-image URLs into host-brokered trusted-cache
 * URLs. The workspace assets directory itself is deliberately not a Webview
 * localResourceRoot.
 */
export function installWorkspaceAssetBroker(
  api: Pick<VsCodeApi, 'postMessage'>,
  testHooks?: WorkspaceAssetBrokerTestHooks
): {
  dispose(): void;
} {
  const base = document.documentElement.dataset.snlAssetBaseUri?.replace(/\/$/, '') ?? '';
  const associations = new WeakMap<HTMLImageElement, AssetAssociation>();
  const suppressedMutations = new WeakMap<HTMLImageElement, number>();
  const resolutions = new Map<string, AssetResolution>();
  const requests = new Map<string, string>();
  const epochs = new Map<string, number>();
  const consumers = new Map<string, Set<HTMLImageElement>>();
  const consumerPaths = new Map<string, string>();
  let disposed = false;

  testHooks?.exposeSnapshot(() => ({
    resolutions: resolutions.size,
    pendingResolutions: [...resolutions.values()].filter(
      (resolution) => resolution.status === 'pending'
    ).length,
    requests: requests.size,
    epochs: epochs.size,
    consumers: [...consumers.values()].reduce((total, images) => total + images.size, 0),
    pendingConsumers: [...consumers].reduce((total, [key, images]) =>
      total + (resolutions.get(key)?.status === 'pending' ? images.size : 0), 0)
  }));

  const mutateSource = (image: HTMLImageElement, source: string | null): void => {
    if (image.getAttribute('src') === source) return;
    suppressedMutations.set(image, (suppressedMutations.get(image) ?? 0) + 1);
    if (source === null) image.removeAttribute('src');
    else image.setAttribute('src', source);
  };

  const hasPathState = (path: string): boolean => {
    for (const resolution of resolutions.values()) {
      if (resolution.identity.path === path) return true;
    }
    for (const [key, consumerPath] of consumerPaths) {
      if (consumerPath === path && consumers.get(key)?.size) return true;
    }
    return false;
  };

  const cleanupEpoch = (path: string): void => {
    if (!hasPathState(path)) epochs.delete(path);
  };

  const releaseAssociation = (
    image: HTMLImageElement,
    cleanEpoch = true
  ): AssetAssociation | undefined => {
    const associated = associations.get(image);
    if (!associated) return undefined;
    associations.delete(image);
    const expected = consumers.get(associated.key);
    expected?.delete(image);
    if (expected?.size) return associated;
    consumers.delete(associated.key);
    consumerPaths.delete(associated.key);
    const pending = resolutions.get(associated.key);
    if (pending?.status === 'pending') {
      resolutions.delete(associated.key);
      requests.delete(pending.request_id);
    }
    if (cleanEpoch) cleanupEpoch(associated.path);
    return associated;
  };

  const associate = (image: HTMLImageElement, association: AssetAssociation): void => {
    const previous = associations.get(image);
    if (previous && previous.key !== association.key) releaseAssociation(image, false);
    associations.set(image, association);
    const expected = consumers.get(association.key) ?? new Set<HTMLImageElement>();
    expected.add(image);
    consumers.set(association.key, expected);
    consumerPaths.set(association.key, association.path);
    if (previous && previous.key !== association.key) cleanupEpoch(previous.path);
  };

  const clearAssociation = (image: HTMLImageElement): void => {
    releaseAssociation(image);
    delete image.dataset.snlAssetPath;
    delete image.dataset.snlAssetError;
  };

  const touch = (key: string, resolution: AssetResolution): void => {
    resolutions.delete(key);
    resolutions.set(key, resolution);
  };

  const trimSettled = (): void => {
    let settled = 0;
    for (const resolution of resolutions.values()) {
      if (resolution.status !== 'pending') settled += 1;
    }
    if (settled <= SETTLED_CACHE_LIMIT) return;
    for (const [key, resolution] of resolutions) {
      if (resolution.status === 'pending') continue;
      resolutions.delete(key);
      cleanupEpoch(resolution.identity.path);
      settled -= 1;
      if (settled <= SETTLED_CACHE_LIMIT) break;
    }
  };

  const applyResolution = (
    image: HTMLImageElement,
    identity: AssetIdentity,
    resolution: Exclude<AssetResolution, { status: 'pending' }>
  ): void => {
    const expected = associations.get(image);
    if (!expected || expected.key !== identity.key) return;
    image.dataset.snlAssetPath = identity.path;
    if (resolution.status === 'ready') {
      delete image.dataset.snlAssetError;
      const renderedSource = withAuthoredSuffix(resolution.url, identity.suffix);
      associate(image, { ...identity, renderedSource });
      mutateSource(image, renderedSource);
    } else {
      image.dataset.snlAssetError = '';
      associate(image, { ...identity, renderedSource: null });
      mutateSource(image, null);
    }
  };

  const requestIdentity = (image: HTMLImageElement, identity: AssetIdentity): void => {
    image.dataset.snlAssetPath = identity.path;
    const existing = resolutions.get(identity.key);
    if (existing?.status === 'ready' || existing?.status === 'missing') {
      touch(identity.key, existing);
      associate(image, { ...identity, renderedSource: image.getAttribute('src') });
      applyResolution(image, identity, existing);
      return;
    }

    const request_id = existing?.request_id ?? `snl-markdown-asset-${++nextRequest}`;
    associate(image, {
      ...identity,
      request_id,
      renderedSource: PENDING_SOURCE
    });
    delete image.dataset.snlAssetError;
    mutateSource(image, PENDING_SOURCE);
    if (existing) return;
    const pending: AssetResolution = { status: 'pending', identity, request_id };
    resolutions.set(identity.key, pending);
    requests.set(request_id, identity.key);
    api.postMessage({ type: 'snl.assets/resolve', request_id, path: identity.path });
  };

  const broker = (image: HTMLImageElement): void => {
    if (disposed || !base) return;
    const src = image.getAttribute('src');
    const associated = associations.get(image);
    if (associated && src === associated.renderedSource) return;
    const pathHint = associated?.path;
    const identity = src === null
      ? undefined
      : decodeWorkspaceSource(src, base, epochs.get(pathHint ?? '') ?? 0);
    if (!identity) {
      clearAssociation(image);
      return;
    }
    const currentEpoch = epochs.get(identity.path) ?? 0;
    const currentIdentity = currentEpoch === (epochs.get(pathHint ?? '') ?? 0)
      ? identity
      : decodeWorkspaceSource(src!, base, currentEpoch);
    if (currentIdentity) requestIdentity(image, currentIdentity);
  };

  const invalidate = (path: string): void => {
    if (!path || path.includes('\\') || path.startsWith('/') ||
        path.includes('?') || path.includes('#') ||
        path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return;
    if (!hasPathState(path)) return;
    epochs.set(path, (epochs.get(path) ?? 0) + 1);
    for (const [key, resolution] of resolutions) {
      if (resolution.identity.path !== path) continue;
      resolutions.delete(key);
      if (resolution.status === 'pending') requests.delete(resolution.request_id);
    }
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-snl-asset-path]')) {
      const associated = associations.get(image);
      if (!associated || associated.path !== path) continue;
      const identity = decodeWorkspaceSource(
        associated.authoredSource,
        base,
        epochs.get(path) ?? 0
      );
      if (identity) requestIdentity(image, identity);
    }
    cleanupEpoch(path);
  };

  const scan = (root: ParentNode): void => {
    if (root instanceof HTMLImageElement) broker(root);
    for (const image of root.querySelectorAll?.('img') ?? []) {
      broker(image as HTMLImageElement);
    }
  };

  const observer = new MutationObserver((records) => {
    const removedImages = new Set<HTMLImageElement>();
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
        const suppressed = suppressedMutations.get(record.target) ?? 0;
        if (suppressed > 0) {
          if (suppressed === 1) suppressedMutations.delete(record.target);
          else suppressedMutations.set(record.target, suppressed - 1);
        } else {
          broker(record.target);
        }
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) scan(node);
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLImageElement) removedImages.add(node);
        for (const image of node.querySelectorAll<HTMLImageElement>('img')) {
          removedImages.add(image);
        }
      }
    }
    if (removedImages.size) queueMicrotask(() => {
      for (const image of removedImages) {
        if (document.documentElement.contains(image)) continue;
        clearAssociation(image);
      }
    });
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
      revision?: unknown;
    } | null;
    if (message?.type === 'snl.assets/invalidate' &&
        typeof message.path === 'string' &&
        typeof message.revision === 'number') {
      invalidate(message.path);
      return;
    }
    if (message?.type !== 'snl.assets/resolved' ||
        typeof message.request_id !== 'string' || typeof message.path !== 'string') return;
    const key = requests.get(message.request_id);
    if (!key) return;
    const pending = resolutions.get(key);
    if (pending?.status !== 'pending' ||
        pending.request_id !== message.request_id ||
        pending.identity.path !== message.path) return;
    requests.delete(message.request_id);
    const resolution: Exclude<AssetResolution, { status: 'pending' }> =
      typeof message.url === 'string' && message.url
        ? { status: 'ready', identity: pending.identity, url: message.url }
        : { status: 'missing', identity: pending.identity };
    touch(key, resolution);
    trimSettled();
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-snl-asset-path]')) {
      const expected = associations.get(image);
      if (expected?.key === key && expected.request_id === message.request_id) {
        applyResolution(image, pending.identity, resolution);
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
      requests.clear();
      epochs.clear();
      consumers.clear();
      consumerPaths.clear();
    }
  };
}
