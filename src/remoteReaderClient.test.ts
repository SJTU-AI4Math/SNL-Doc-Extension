import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteReader, remoteReaderOrigin } from './remoteReaderClient';

const origin = 'https://localhost:4912';
const token = 'a'.repeat(43);
const catalog = { id: 'remote', name: 'Algebra', libraries: [], capabilities: { edit: false } };
const snapshot = {
  version: 1, renderSnapshotId: 'algebra', library: { slug: 'A & B', title: 'Algebra', outline: [], warnings: [] },
  entries: [], entryKinds: [], entryPackages: {}, macroKinds: [], macros: {}, relationships: [], languages: [],
  preferences: {}, contentLanguage: 'en', resources: {},
};

describe('remote Reader transport', () => {
  it('only accepts HTTPS origins without credentials, a route, or a query', () => {
    expect(remoteReaderOrigin(' https://EXAMPLE.com/ ')).toBe('https://example.com');
    for (const unsafe of ['bad', 'http://127.0.0.1', 'https://a:b@example.com', 'https://example.com/api', 'https://example.com/?token=a', 'https://example.com/#x']) {
      expect(() => remoteReaderOrigin(unsafe)).toThrow(/HTTPS origin/);
    }
  });

  it('sends the credential in a header and forbids redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog));
    await expect(fetchRemoteReader(origin, token, undefined, new AbortController().signal, request)).resolves.toEqual(catalog);
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe(origin + '/__snl/api/workspace');
    expect(options).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer ' + token } });
  });

  it('encodes Library names and rejects a mismatched snapshot or a non-frozen asset', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json({ ...snapshot, resources: { 'probe.svg': { url: 'https://outside.invalid/probe.svg', revision: 'x' } } }));
    const signal = new AbortController().signal;
    await expect(fetchRemoteReader(origin, token, 'A & B', signal, request)).resolves.toEqual(snapshot);
    expect(String(request.mock.calls[0][0])).toContain('?library=A+%26+B');
    await expect(fetchRemoteReader(origin, token, 'Other', signal, request)).rejects.toThrow(/Library data/);
    await expect(fetchRemoteReader(origin, token, 'A & B', signal, request)).rejects.toThrow(/frozen Reader asset/);
  });

  it('rejects authentication failures and oversized responses before parsing', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private details', { status: 401 }))
      .mockResolvedValueOnce(Response.json(catalog, { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }));
    const signal = new AbortController().signal;
    await expect(fetchRemoteReader(origin, token, undefined, signal, request)).rejects.toThrow('HTTP 401');
    await expect(fetchRemoteReader(origin, token, undefined, signal, request)).rejects.toThrow(/oversized/);
  });
});
