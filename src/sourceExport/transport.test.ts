import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { buildSourceAssets } from './transport';
import type { SourcePreview } from './types';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function preview(): SourcePreview {
  const bytes = Buffer.from('</script><!--<script>globalThis.pwned=true</script>\u2028\u2029');
  const fileId = sha('__proto__'), digest = sha(bytes);
  return { manifest: { schemaVersion: 'snl.export.sources/v2', exportId: 'export', renderSnapshotId: 'render', workspaceName: '</script>',
    snapshot: { mode: 'disk' }, options: { scope: 'project', keep: [], exclude: [], companionFiles: [] }, directories: [],
    files: [{ fileId, displayPath: '__proto__', kind: 'text', language: 'javascript', byteLength: bytes.length, sha256: digest, bom: false, eol: 'none', chunkId: `source-${fileId}.js` }],
    pointers: [], entryRoutes: [] }, chunks: [{ fileId, sha256: digest, base64: bytes.toString('base64') }], totalBytes: bytes.length, estimatedBytes: 1000,
    exclusions: [], warnings: [], externalRoots: ['/private/host'], confirmationId: 'private' };
}
describe('source artifact scripts', () => {
  it.each([false, true])('roundtrips inert hostile source through classic scripts (inline=%s)', inline => {
    const p = preview(); const assets = buildSourceAssets(p, inline).texts;
    expect(assets[0].path).toBe('sources.js');
    expect(assets.every(a => !a.source.includes('<') && !a.source.includes('/private/host'))).toBe(true);
    const context: Record<string, any> = {};
    for (const asset of assets) runInNewContext(asset.source, context);
    expect(context.__snlSources).toEqual(p.manifest);
    expect(context.__snlSourceChunks.get(p.chunks[0].fileId)).toEqual(p.chunks[0]);
    expect(context.pwned).toBeUndefined();
    if (!inline) expect(assets[1].path).toMatch(/^source-[a-f0-9]{64}\.js$/);
  });
  it('preserves nested prototype-shaped keys without executing source or special object-literal semantics', () => {
    const p = preview();
    p.manifest.pointers.push({ entryId: '__proto__', pointer: null, title: JSON.parse('{"__proto__":"own","constructor":"ordinary"}'), status: 'unresolved' });
    p.manifest.workspaceName += '\u2028\u2029<!--';
    const context: Record<string, any> = {};
    const asset = buildSourceAssets(p, true).texts[0]; runInNewContext(asset.source, context);
    expect(Object.keys(context.__snlSources.pointers[0].title)).toEqual(['__proto__', 'constructor']);
    expect(context.__snlSources.pointers[0].title.__proto__).toBe('own');
    expect(asset.source).not.toMatch(/[<\u2028\u2029]/);
  });
  it('rejects malformed ids, missing/extra chunks, corrupt hashes and mismatched mapping before generating', () => {
    for (const mutate of [
      (p: SourcePreview) => { p.manifest.files[0].fileId = '../index'; },
      (p: SourcePreview) => { p.chunks = []; },
      (p: SourcePreview) => { p.chunks.push(p.chunks[0]); },
      (p: SourcePreview) => { p.chunks[0].base64 = 'AAAA'; },
      (p: SourcePreview) => { p.manifest.files[0].chunkId = 'index.html'; },
      (p: SourcePreview) => { p.manifest.pointers.push({ entryId: 'e', pointer: null, fileId: sha('absent'), status: 'ok' }); }
    ]) { const p = preview(); mutate(p); expect(() => buildSourceAssets(p, false)).toThrow(); }
  });
});
