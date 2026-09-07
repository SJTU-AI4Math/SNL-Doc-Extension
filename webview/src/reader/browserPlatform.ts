import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
export type ReaderRoute = { kind: 'library' } | { kind: 'node'; nodeId: string } | { kind: 'entry'; entryId: string; returnHash?: string };
export function encodeReaderRoute(route: ReaderRoute): string {
  if (route.kind === 'library') return '#/library';
  if (route.kind === 'node') return '#/node/' + encodeURIComponent(route.nodeId);
  return '#/entry/' + encodeURIComponent(route.entryId) + (route.returnHash ? '?return=' + encodeURIComponent(route.returnHash) : '');
}
export function decodeReaderRoute(hash: string): ReaderRoute {
  try {
    const [path, query] = hash.split('?');
    if (path.startsWith('#/node/')) return { kind: 'node', nodeId: decodeURIComponent(path.slice('#/node/'.length)) };
    if (path.startsWith('#/entry/')) {
      const returnHash = new URLSearchParams(query).get('return') || undefined;
      return { kind: 'entry', entryId: decodeURIComponent(path.slice('#/entry/'.length)), ...(returnHash ? { returnHash } : {}) };
    }
  } catch { /* Malformed deep links return to the library without crashing. */ }
  return { kind: 'library' };
}
export function frozenAssetReply(resources: FrozenReaderSnapshot['resources'], request: Record<string, unknown>): Record<string, unknown> | undefined {
  const svg = request.type === 'snl.assets/read-svg';
  if (!svg && request.type !== 'snl.assets/resolve') return undefined;
  const raw = svg ? request.source : request.path;
  const path = typeof raw === 'string' ? raw.replace(/^assets\//, '') : '';
  const valid = !!path && !/[:\\]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');
  const asset = valid && Object.hasOwn(resources, path) ? resources[path] : undefined;
  if (svg) return {
    type: 'snl.assets/svg-source', request_id: request.request_id, source: request.source,
    base_identity: request.base_identity, revision: request.revision,
    ...(asset?.text !== undefined && asset.revision === request.revision
      ? { value: asset.text } : { error: 'SVG asset unavailable or frozen revision mismatch' })
  };
  return { type: 'snl.assets/resolved', request_id: request.request_id, path: request.path,
    ...(asset ? { url: asset.url } : { error: 'Asset not included in frozen snapshot' }) };
}
