import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MemUri {
  path: string;
  fsPath: string;
  scheme: string;
  toString(skipEncoding?: boolean): string;
}
const enc = new TextEncoder();
const dec = new TextDecoder();
const files = new Map<string, Uint8Array>();
let injectConcurrentWrite = false;
const graphPath = '/ws/.SNL_Doc/libraries/lib/graph.json';

function uri(path: string): MemUri {
  return { path, fsPath: path, scheme: 'mem', toString: () => `mem:${path}` };
}

vi.mock('vscode', () => ({
  env: { language: 'en' },
  FileType: { File: 1, Directory: 2 },
  Uri: { joinPath: (base: MemUri, ...parts: string[]) => uri([base.path.replace(/\/$/u, ''), ...parts].join('/')) },
  workspace: {
    fs: {
      stat: vi.fn(async (target: MemUri) => {
        if (injectConcurrentWrite && target.fsPath === graphPath) {
          injectConcurrentWrite = false;
          files.set(graphPath, enc.encode(JSON.stringify({
            nodes: [{ id: 'root', label: 'Entry', props: {}, external: true }],
            relationships: [],
            writer: 'external'
          })));
        }
        if (files.has(target.fsPath)) return { type: 1 };
        throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
      }),
      readFile: vi.fn(async (target: MemUri) => {
        const value = files.get(target.fsPath);
        if (!value) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        return value;
      }),
      writeFile: vi.fn(async (target: MemUri, value: Uint8Array) => {
        files.set(target.fsPath, new Uint8Array(value));
      })
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) }))
  }
}));

import { updateLibraryGraphNodeEntryId } from './snlDoc';

const root = uri('/ws') as never;

beforeEach(() => {
  injectConcurrentWrite = false;
  files.clear();
  files.set('/ws/.SNL_Doc/config.json', enc.encode(JSON.stringify({ version: '0.0.5' })));
  files.set(graphPath, enc.encode(JSON.stringify({
    version: 2,
    extension: { keep: true },
    nodes: [
      { id: 'root', label: 'Entry', props: { entryId: 'entry-a' }, extra: 7 },
      { id: 'child', label: 'Entry', props: {} },
      'malformed'
    ],
    relationships: [
      { from: 'root', to: 'child', label: 'branch', properties: { order: 1 } },
      { from: 'child', to: 'root', label: 'custom', extra: true },
      9
    ]
  })));
});

describe('updateLibraryGraphNodeEntryId raw CAS writer', () => {
  it('preserves unknown data, node identity, and every relationship', async () => {
    expect(await updateLibraryGraphNodeEntryId(root, 'lib', 'root', 'entry-a', 'entry-b')).toEqual({ status: 'ok' });
    const graph = JSON.parse(dec.decode(files.get(graphPath)!));
    expect(graph.extension).toEqual({ keep: true });
    expect(graph.nodes).toEqual([
      { id: 'root', label: 'Entry', props: { entryId: 'entry-b' }, extra: 7 },
      { id: 'child', label: 'Entry', props: {} },
      'malformed'
    ]);
    expect(graph.relationships).toEqual([
      { from: 'root', to: 'child', label: 'branch', properties: { order: 1 } },
      { from: 'child', to: 'root', label: 'custom', extra: true },
      9
    ]);
  });

  it('rejects a stale snapshot instead of overwriting a concurrent writer', async () => {
    injectConcurrentWrite = true;
    const result = await updateLibraryGraphNodeEntryId(root, 'lib', 'root', 'entry-a', 'entry-b');
    expect(result).toMatchObject({ status: 'error' });
    expect(result.status === 'error' ? result.message : '').toContain('Refusing stale write');
    const graph = JSON.parse(dec.decode(files.get(graphPath)!));
    expect(graph).toMatchObject({ writer: 'external', nodes: [{ id: 'root', external: true }] });
  });
});
