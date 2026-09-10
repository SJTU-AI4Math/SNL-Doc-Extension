import { describe, it, expect } from 'vitest';
import { decodeReaderRoute, encodeReaderRoute, frozenAssetReply } from './browserPlatform';

describe('browser reader platform', () => {
  it('round trips occurrence identity and semantic return destination', () => {
    const route = { kind: 'entry' as const, entryId: 'A/字', returnHash: '#/node/Entry.Child.second' };
    expect(decodeReaderRoute(encodeReaderRoute(route))).toEqual(route);
    expect(decodeReaderRoute('#/node/Entry.Child.second')).toEqual({ kind: 'node', nodeId: 'Entry.Child.second' });
    expect(decodeReaderRoute('#/entry/%')).toEqual({ kind: 'unavailable' });
  });
  it('round trips workspace and library context on every reading destination while retaining legacy links', () => {
    expect(decodeReaderRoute('#/workspace')).toEqual({ kind: 'workspace' });
    const routes = [
      { kind: 'library' }, { kind: 'node', nodeId: 'same/occurrence' },
      { kind: 'entry', entryId: 'Shared', returnHash: '#/search?library=A&q=Shared' },
      { kind: 'search', q: 'Shared', mode: 'entry', filters: { kindId: 'lemma' } },
      { kind: 'graph' }, { kind: 'macro', name: 'symbol' }, { kind: 'unavailable' }
    ] as const;
    for (const destination of routes) {
      const route = { ...destination, librarySlug: 'A/字' };
      expect(decodeReaderRoute(encodeReaderRoute(route))).toEqual(route);
    }
    expect(encodeReaderRoute({ kind: 'library' })).toBe('#/library');
    expect(encodeReaderRoute({ kind: 'node', nodeId: 'same' })).toBe('#/node/same');
  });
  it('answers all three resource channels with exact correlated identities and fails closed on revision mismatch', () => {
    const resources = { 'slot.svg': { url: 'data:image/svg+xml;base64,PHN2Zy8+', text: '<svg/>', revision: 'sha256:abc' } };
    expect(frozenAssetReply(resources, { type: 'snl.assets/resolve', request_id: 'image', path: 'slot.svg' })).toMatchObject({ type: 'snl.assets/resolved', request_id: 'image', path: 'slot.svg', url: resources['slot.svg'].url });
    const request = { type: 'snl.assets/read-svg', request_id: 'svg', source: 'assets/slot.svg', base_identity: 'P', revision: 'sha256:abc' };
    expect(frozenAssetReply(resources, request)).toMatchObject({ ...request, type: 'snl.assets/svg-source', value: '<svg/>' });
    expect(frozenAssetReply(resources, { ...request, revision: 'sha256:stale' })).toHaveProperty('error');
    expect(frozenAssetReply(resources, { ...request, source: 'assets/../slot.svg' })).toHaveProperty('error');
  });
});
