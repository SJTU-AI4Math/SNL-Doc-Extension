import type { FrozenSearchQuery } from './browserDiscovery';

/** One codec for HTML exports and the local workspace. Old unscoped hashes stay valid. */
export type ReaderRoute = { kind: 'workspace' } | ((
  { kind: 'library' } | { kind: 'node'; nodeId: string }
  | { kind: 'entry'; entryId: string; returnHash?: string }
  | ({ kind: 'search'; returnHash?: string } & FrozenSearchQuery)
  | { kind: 'graph'; returnHash?: string }
  | { kind: 'macro'; name: string; returnHash?: string }
  | { kind: 'unavailable' }
) & { librarySlug?: string });

export function encodeReaderRoute(route: ReaderRoute): string {
  if (route.kind === 'workspace') return '#/workspace';
  const params = new URLSearchParams();
  if (route.librarySlug !== undefined) params.set('library', route.librarySlug);
  if (route.kind === 'search') {
    if (route.q) params.set('q', route.q);
    if (route.mode !== 'entry') params.set('mode', route.mode);
    if (route.filters.kindId) params.set('kind', route.filters.kindId);
    if (route.filters.counterpartId) params.set('counterpart', route.filters.counterpartId);
  }
  if ('returnHash' in route && route.returnHash) params.set('return', route.returnHash);
  const path = route.kind === 'node' ? 'node/' + encodeURIComponent(route.nodeId)
    : route.kind === 'entry' ? 'entry/' + encodeURIComponent(route.entryId)
    : route.kind === 'macro' ? 'macro/' + encodeURIComponent(route.name) : route.kind;
  return '#/' + path + (params.size ? '?' + params.toString() : '');
}

export function decodeReaderRoute(hash: string): ReaderRoute {
  let context: { librarySlug?: string } = {};
  try {
    const separator = hash.indexOf('?');
    const path = separator < 0 ? hash : hash.slice(0, separator);
    const params = new URLSearchParams(separator < 0 ? '' : hash.slice(separator + 1));
    if (params.has('library')) context = { librarySlug: params.get('library')! };
    const returnHash = params.get('return') || undefined;
    const back = returnHash ? { returnHash } : {};
    if (path === '#/workspace') return { kind: 'workspace' };
    if (!hash || path === '#/library') return { kind: 'library', ...context };
    if (path.startsWith('#/node/')) return { kind: 'node', nodeId: decodeURIComponent(path.slice('#/node/'.length)), ...context };
    if (path.startsWith('#/entry/')) return { kind: 'entry', entryId: decodeURIComponent(path.slice('#/entry/'.length)), ...back, ...context };
    if (path.startsWith('#/macro/')) return { kind: 'macro', name: decodeURIComponent(path.slice('#/macro/'.length)), ...back, ...context };
    if (path === '#/graph') return { kind: 'graph', ...back, ...context };
    if (path === '#/search' && (!params.has('mode') || ['entry', 'macro'].includes(params.get('mode')!))) return {
      kind: 'search', q: params.get('q') ?? '', mode: params.get('mode') === 'macro' ? 'macro' : 'entry',
      filters: { ...(params.get('kind') ? { kindId: params.get('kind')! } : {}), ...(params.get('counterpart') ? { counterpartId: params.get('counterpart')! } : {}) }, ...back, ...context
    };
  } catch { /* Malformed routes must not silently open a different destination. */ }
  return { kind: 'unavailable', ...context };
}

/** Context applies even to legacy return hashes emitted by shared reading components. */
export function readerRouteInLibrary(route: ReaderRoute, librarySlug?: string): ReaderRoute {
  return route.kind === 'workspace' || librarySlug === undefined ? route : { ...route, librarySlug };
}
