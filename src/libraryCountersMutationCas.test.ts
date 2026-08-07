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
const countersPath = '/ws/.SNL_Doc/libraries/lib/counters.json';

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

import { mutateLibraryCounters, type CounterNode } from './snlDoc';

const root = uri('/ws') as never;

beforeEach(() => {
  files.clear();
  files.set('/ws/.SNL_Doc/config.json', enc.encode(JSON.stringify({ version: '0.0.5' })));
  files.set(countersPath, enc.encode(JSON.stringify({
    version: 1,
    extension: { keep: true },
    counters: [
      { id: 'a', name: 'A', numbering: '1', children: [], color: 'red' },
      { id: 'b', name: 'B', numbering: '2', children: [], color: 'blue' }
    ]
  })));
});

function wrap(roots: CounterNode[], targetId: string, parentId: string): boolean {
  const index = roots.findIndex((node) => node.id === targetId);
  if (index < 0) return false;
  const target = roots[index];
  roots.splice(index, 1, {
    id: parentId,
    name: parentId,
    numbering: '',
    children: [target]
  });
  return true;
}

describe('mutateLibraryCounters writer lock', () => {
  it('serializes concurrent mutations and preserves unknown wrapper/node fields', async () => {
    await Promise.all([
      mutateLibraryCounters(root, 'lib', (roots) => wrap(roots, 'a', 'pa')),
      mutateLibraryCounters(root, 'lib', (roots) => wrap(roots, 'b', 'pb'))
    ]);

    const stored = JSON.parse(dec.decode(files.get(countersPath)!));
    expect(stored.extension).toEqual({ keep: true });
    expect(stored.counters.map((node: any) => node.id)).toEqual(['pa', 'pb']);
    expect(stored.counters[0].children[0]).toMatchObject({ id: 'a', color: 'red' });
    expect(stored.counters[1].children[0]).toMatchObject({ id: 'b', color: 'blue' });
  });

  it('fails closed on malformed persisted trees', async () => {
    files.set(countersPath, enc.encode(JSON.stringify({ counters: [{ id: 'a', children: [] }] })));
    const before = dec.decode(files.get(countersPath)!);
    expect(await mutateLibraryCounters(root, 'lib', () => true)).toEqual({ status: 'invalid' });
    expect(dec.decode(files.get(countersPath)!)).toBe(before);
  });
});
