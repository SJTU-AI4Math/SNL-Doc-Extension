import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePackageManifest, packageManifestPath } from './entityStorage';

interface MemUri { path: string; fsPath: string; scheme: string; toString(): string }
interface FileRecord { bytes: Uint8Array; ino: number; mode: number; mtime: number; ctime: number }
const enc = new TextEncoder();
const dec = new TextDecoder();
const files = new Map<string, FileRecord>();
const calls: Array<[string, string]> = [];
let nextIno = 1;
let rejectWrite: ((path: string, bytes: Uint8Array) => void) | undefined;
let unreadable: string | undefined;
function uri(path: string): MemUri {
  return { path, fsPath: path, scheme: 'mem', toString: () => `mem:${path}` };
}
function put(path: string, bytes: Uint8Array): FileRecord {
  const record = { bytes: new Uint8Array(bytes), ino: nextIno++, mode: 0o640, mtime: nextIno, ctime: nextIno };
  files.set(path, record);
  return record;
}
function missing() { return Object.assign(new Error('missing'), { code: 'FileNotFound' }); }
function json(path: string): any { return JSON.parse(dec.decode(files.get(path)!.bytes)); }

vi.mock('vscode', () => ({
  env: { language: 'en' }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: { joinPath: (base: MemUri, ...parts: string[]) => uri([base.path.replace(/\/$/u, ''), ...parts].join('/')) },
  workspace: {
    fs: {
      stat: vi.fn(async (target: MemUri) => {
        if (['/ws/.SNL_Doc/entries', '/ws/.SNL_Doc/macros', '/ws/.SNL_Doc/packages', '/ws/.SNL_Doc', '/ws/.SNL_Doc/libraries', '/ws/.SNL_Doc/libraries/lib'].includes(target.path)) return { type: 2 };
        const record = files.get(target.path);
        if (!record) throw missing();
        return { type: 1, ...record, size: record.bytes.length };
      }),
      readDirectory: vi.fn(async () => [[packageManifestPath('_unpackaged').slice('packages/'.length), 1]]),
      readFile: vi.fn(async (target: MemUri) => {
        if (target.path === unreadable) throw Object.assign(new Error('read denied'), { code: 'EACCES' });
        const record = files.get(target.path);
        if (!record) throw missing();
        return new Uint8Array(record.bytes);
      }),
      writeFile: vi.fn(async (target: MemUri, bytes: Uint8Array) => {
        calls.push(['write', target.path]);
        rejectWrite?.(target.path, bytes);
        put(target.path, bytes);
      }),
      delete: vi.fn(async (target: MemUri) => {
        calls.push(['delete', target.path]);
        files.delete(target.path);
      })
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) }))
  }
}));

// Same focused public-writer seam as libraryDraftSave: topology inspection is
// outside this failure-provenance oracle; write helpers and draft writer are real.
vi.mock('./workspaceDataMigration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspaceDataMigration')>()),
  inspectStoredWorkspaceData: vi.fn(async () => ({ status: 'current' }))
}));
import { entityRevision, updateLibraryDraft } from './snlDoc';
const root = uri('/ws') as never;
const meta = '/ws/.SNL_Doc/libraries/lib/meta.json';
const graph = '/ws/.SNL_Doc/libraries/lib/graph.json';
const counters = '/ws/.SNL_Doc/libraries/lib/counters.json';
const foreign = enc.encode('{ "foreign": "third party", "counters": [] }\r\n');

beforeEach(() => {
  files.clear(); calls.length = 0; nextIno = 1; rejectWrite = undefined; unreadable = undefined;
  put('/ws/.SNL_Doc/config.json', enc.encode(JSON.stringify({
    version: '0.1.0', entry_kinds: [], macro_kinds: [], active_macro_packages: [],
    entity_storage: { version: 1, legacy_backup_version: '0.0.5', entry_default_package: '_unpackaged',
      receipt: { legacy_backup_present: false, legacy_entries_present: false, entry_count: 0, macro_package_count: 0, macro_count: 0, entries_digest: '', macro_packages_digest: '' } }
  })));
  put('/ws/.SNL_Doc/' + packageManifestPath('_unpackaged'), enc.encode(JSON.stringify(makePackageManifest('_unpackaged', 'Unpackaged', '', []))));
  put(meta, enc.encode('{ "title": "Old", "extension": true }\r\n'));
  put(graph, enc.encode('{ "nodes": [], "relationships": [], "extension": 7 }\r\n'));
  put(counters, enc.encode('{ "counters": [] }\r\n'));
});
function payload() {
  return {
    title: 'New', graph: { nodes: [], relationships: [] },
    counters: [{ id: 'counter', name: 'theorem', numbering: 'I', children: [] }],
    expectedRevisions: {
      meta: entityRevision(json(meta)), graph: entityRevision(json(graph)),
      counters: entityRevision(files.has(counters) ? json(counters) : null)
    }
  };
}
function failAtCounters(effect: (bytes: Uint8Array) => void) {
  rejectWrite = (path, bytes) => {
    if (path !== counters) return;
    rejectWrite = undefined;
    effect(bytes);
    throw new Error('backend rejected counters');
  };
}

describe('failed Library write ownership', () => {
  it.each([true, false])('does not rewrite exact original bytes or original absence (present=%s)', async present => {
    if (!present) files.delete(counters);
    const original = files.get(counters);
    failAtCounters(() => undefined);
    const result = await updateLibraryDraft(root, 'lib', payload());
    expect(result).toEqual({ status: 'error', message: 'backend rejected counters' });
    expect(files.get(counters)).toBe(original);
    expect(calls.filter(([, path]) => path === counters)).toEqual([['write', counters]]);
  });

  it.each([true, false])('compensates confirmed intended bytes using raw originals (present=%s)', async present => {
    if (!present) files.delete(counters);
    const before = new Map([...files].map(([path, record]) => [path, record.bytes]));
    failAtCounters(bytes => { put(counters, bytes); });
    expect(await updateLibraryDraft(root, 'lib', payload())).toEqual({ status: 'error', message: 'backend rejected counters' });
    expect(new Map([...files].map(([path, record]) => [path, record.bytes]))).toEqual(before);
    expect(calls).toEqual([
      ['write', meta], ['write', graph], ['write', counters],
      [present ? 'write' : 'delete', counters], ['write', graph], ['write', meta]
    ]);
  });

  it.each(['partial', 'unreadable', 'missing', 'equal-json-different-bytes'] as const)(
    'preserves ambiguous %s residue and still compensates independent completed operations', async failure => {
      const beforeMeta = files.get(meta)!.bytes;
      const beforeGraph = files.get(graph)!.bytes;
      let residue: FileRecord | undefined;
      failAtCounters(bytes => {
        if (failure === 'missing') files.delete(counters);
        else residue = put(counters, failure === 'partial' ? bytes.slice(0, 11) :
          failure === 'equal-json-different-bytes' ? enc.encode(JSON.stringify(JSON.parse(dec.decode(bytes)))) : bytes);
        if (failure === 'unreadable') unreadable = counters;
      });
      const result = await updateLibraryDraft(root, 'lib', payload());
      expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/rollback was incomplete/) });
      expect(files.get(counters)).toBe(residue);
      expect(calls).toEqual([
        ['write', meta], ['write', graph], ['write', counters], ['write', graph], ['write', meta]
      ]);
      expect(files.get(meta)!.bytes).toEqual(beforeMeta);
      expect(files.get(graph)!.bytes).toEqual(beforeGraph);
    }
  );

  it('keeps completed-operation CAS refusal and rolls back the other independent operation', async () => {
    const beforeMeta = files.get(meta)!.bytes;
    let foreignGraph!: FileRecord;
    failAtCounters(bytes => {
      put(counters, bytes);
      foreignGraph = put(graph, enc.encode('{"nodes":[],"relationships":[],"foreign":true}'));
    });
    expect(await updateLibraryDraft(root, 'lib', payload())).toMatchObject({
      status: 'error', message: expect.stringMatching(/rollback was incomplete/)
    });
    expect(files.get(graph)).toBe(foreignGraph);
    expect(files.get(meta)!.bytes).toEqual(beforeMeta);
    expect(calls).toEqual([
      ['write', meta], ['write', graph], ['write', counters], ['write', counters], ['write', meta]
    ]);
  });

  it.each([true, false])('preserves third-party replacement bytes, path and metadata (original present=%s)', async present => {
    if (!present) files.delete(counters);
    const beforeMeta = files.get(meta)!.bytes;
    const beforeGraph = files.get(graph)!.bytes;
    let replacement!: FileRecord;
    failAtCounters(() => { replacement = put(counters, foreign); });
    const result = await updateLibraryDraft(root, 'lib', payload());
    expect.soft(files.has(counters)).toBe(true);
    expect.soft(files.get(counters)).toEqual(replacement);
    expect.soft(files.get(counters)).toBe(replacement);
    expect.soft(files.get(counters)?.bytes).toEqual(foreign);
    expect.soft(calls.filter(([, path]) => path === counters)).toEqual([['write', counters]]);
    expect.soft(result).toMatchObject({ status: 'error', message: expect.stringMatching(/rollback was incomplete/) });
    expect.soft(files.get(meta)!.bytes).toEqual(beforeMeta);
    expect.soft(files.get(graph)!.bytes).toEqual(beforeGraph);
  });
});
