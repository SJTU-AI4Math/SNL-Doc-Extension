import { createHash } from 'node:crypto';
import { compilePointerScope, isCompiledPointerScope } from '../pointerSync/scope';
import { isStructuralPointer } from '../pointerSync/schema';
import type { TextAsset } from '../exportDocument';
import type { SourcePreview } from './types';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = (value: string) => /^[a-f0-9]{64}$/.test(value);
function safePath(value: string): boolean {
  return typeof value === 'string' && !!value && !/[\u0000-\u001f\u007f-\u009f\\:]/u.test(value) &&
    !value.split('/').some(s => !s || s === '.' || s === '..');
}
/** JSON.parse avoids JavaScript object-literal __proto__ semantics, including nested author maps.
 * Escaping every '<' also covers HTML comments and case-insensitive script terminators. */
function data(value: unknown): string {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')})`;
}

/** Directory: include only sources.js in HTML; load hashed chunk scripts on demand.
 * Inline: sources.js contains the manifest FIRST, followed by every chunk registration.
 * Neither shape exposes source files under active HTML/SVG/JS project paths. */
export function buildSourceAssets(preview: SourcePreview, inline: boolean): { texts: TextAsset[] } {
  const { manifest, chunks } = preview;
  const fail = (): never => { throw new Error('Invalid source manifest/chunk closure'); };
  if (manifest.schemaVersion !== 'snl.export.sources/v2' || !manifest.renderSnapshotId) fail();
  const files = new Map(manifest.files.map(f => [f.fileId, f]));
  if (files.size !== manifest.files.length || chunks.length !== files.size) fail();
  const paths = new Set<string>();
  for (const name of [...manifest.directories, ...manifest.files.map(f => f.displayPath)]) {
    if (!safePath(name)) fail();
    const key = name.normalize('NFC').toLowerCase(); if (paths.has(key)) fail(); paths.add(key);
  }
  const payloads = new Map<string, typeof chunks[number]>();
  for (const chunk of chunks) {
    const file = files.get(chunk.fileId);
    if (!file || !id(chunk.fileId) || !id(chunk.sha256) || payloads.has(chunk.fileId) || file.sha256 !== chunk.sha256 ||
      file.chunkId !== `source-${chunk.fileId}.js` || file.fileId !== digest(file.displayPath) ||
      !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || !['text', 'binary', 'unsupported'].includes(file.kind)) fail();
    if (typeof chunk.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.base64)) fail();
    const bytes = Buffer.from(chunk.base64, 'base64');
    if (bytes.toString('base64') !== chunk.base64 || bytes.length !== file!.byteLength || digest(bytes) !== chunk.sha256) fail();
    payloads.set(chunk.fileId, chunk);
  }
  for (const pointer of manifest.pointers) {
    const file = pointer.fileId ? files.get(pointer.fileId) : undefined;
    if (pointer.fileId && (!file || pointer.sourceSha256 !== file.sha256 ||
      !pointer.pointer || typeof pointer.pointer !== 'object' || !('file' in pointer.pointer) || pointer.pointer.file !== file.displayPath)) fail();
    if (pointer.status === 'ok') {
      const r = pointer.range;
      if (!file || file.kind !== 'text' || !r || !isCompiledPointerScope(pointer.inverseScope) || !isStructuralPointer(pointer.pointer) || Object.values(r).some(n => !Number.isSafeInteger(n) || n < 1) ||
        r.endLine < r.startLine || (r.endLine === r.startLine && r.endColumn < r.startColumn) ||
        r.coveredEndLine < r.startLine || r.coveredEndLine > r.endLine) fail();
      if (file && r && isStructuralPointer(pointer.pointer)) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(payloads.get(file.fileId)!.base64, 'base64'));
        const rows = text.split(/\r?\n/);
        if (r.startLine > rows.length || r.endLine > rows.length || r.startColumn > rows[r.startLine - 1].length + 1 || r.endColumn > rows[r.endLine - 1].length + 1) fail();
        const expected = compilePointerScope(pointer.pointer, r, text);
        if (!isCompiledPointerScope(expected) || Object.keys(expected).some(k => expected[k as keyof typeof expected] !== pointer.inverseScope?.[k as keyof typeof expected])) fail();
      }
    }
  }
  const scripts: TextAsset[] = manifest.files.map(file => ({ path: file.chunkId,
    source: `globalThis.__snlSourceChunks.set(${JSON.stringify(file.fileId)},${data(payloads.get(file.fileId))});` }));
  const source = `globalThis.__snlSources=${data(manifest)};\nglobalThis.__snlSourceChunks=new Map();`;
  return { texts: inline ? [{ path: 'sources.js', source: [source, ...scripts.map(s => s.source)].join('\n') }] : [{ path: 'sources.js', source }, ...scripts] };
}
