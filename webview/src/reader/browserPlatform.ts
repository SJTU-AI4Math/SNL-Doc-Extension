import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
import type { FrozenSearchQuery } from './browserDiscovery';
export type ReaderRoute = { kind: 'library' } | { kind: 'node'; nodeId: string }
  | { kind: 'entry'; entryId: string; returnHash?: string }
  | ({ kind: 'search'; returnHash?: string } & FrozenSearchQuery)
  | { kind: 'graph'; returnHash?: string }
  | { kind: 'macro'; name: string; returnHash?: string }
  | { kind: 'unavailable' };
export function encodeReaderRoute(route: ReaderRoute): string {
  if (route.kind === 'library') return '#/library';
  if (route.kind === 'unavailable') return '#/unavailable';
  if (route.kind === 'node') return '#/node/' + encodeURIComponent(route.nodeId);
  const params = new URLSearchParams();
  if (route.kind === 'search') {
    if (route.q) params.set('q', route.q);
    if (route.mode !== 'entry') params.set('mode', route.mode);
    if (route.filters.kindId) params.set('kind', route.filters.kindId);
    if (route.filters.counterpartId) params.set('counterpart', route.filters.counterpartId);
  }
  if (route.returnHash) params.set('return', route.returnHash);
  const path = route.kind === 'entry' ? 'entry/' + encodeURIComponent(route.entryId)
    : route.kind === 'macro' ? 'macro/' + encodeURIComponent(route.name) : route.kind;
  return '#/' + path + (params.size ? '?' + params.toString() : '');
}
export function decodeReaderRoute(hash: string): ReaderRoute {
  try {
    const separator = hash.indexOf('?');
    const path = separator < 0 ? hash : hash.slice(0, separator);
    const params = new URLSearchParams(separator < 0 ? '' : hash.slice(separator + 1));
    const returnHash = params.get('return') || undefined;
    const back = returnHash ? { returnHash } : {};
    if (!hash || path === '#/library') return { kind: 'library' };
    if (path.startsWith('#/node/')) return { kind: 'node', nodeId: decodeURIComponent(path.slice('#/node/'.length)) };
    if (path.startsWith('#/entry/')) return { kind: 'entry', entryId: decodeURIComponent(path.slice('#/entry/'.length)), ...back };
    if (path.startsWith('#/macro/')) return { kind: 'macro', name: decodeURIComponent(path.slice('#/macro/'.length)), ...back };
    if (path === '#/graph') return { kind: 'graph', ...back };
    if (path === '#/search' && (!params.has('mode') || ['entry', 'macro'].includes(params.get('mode')!))) return {
      kind: 'search', q: params.get('q') ?? '', mode: params.get('mode') === 'macro' ? 'macro' : 'entry',
      filters: { ...(params.get('kind') ? { kindId: params.get('kind')! } : {}), ...(params.get('counterpart') ? { counterpartId: params.get('counterpart')! } : {}) }, ...back
    };
  } catch { /* A malformed route must not silently open a different reading destination. */ }
  return { kind: 'unavailable' };
}
/** Resolve before DOM insertion: an offline reader must never attempt a remote image request. */
export function frozenImageUrl(resources: FrozenReaderSnapshot['resources'], source: string): string {
  if (/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i.test(source)) return source;
  const unavailable = 'data:,';
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/') || source.startsWith('#')) return unavailable;
  try {
    const path = decodeURIComponent(source.split(/[?#]/, 1)[0]).replace(/^\.\//, '').replace(/^\.SNL_Doc\/assets\//, '').replace(/^assets\//, '');
    if (!path || /[:\\\u0000-\u001f\u007f-\u009f]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || decodeURIComponent(path) !== path) return unavailable;
    const asset = Object.hasOwn(resources, path) ? resources[path] : undefined;
    if (!asset) return unavailable;
    const hash = source.indexOf('#');
    return asset.url + (hash >= 0 ? source.slice(hash) : '');
  } catch { return unavailable; }
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
