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
let graphStatCount = 0;
let injectOnGraphStat = 1;
const graphPath = '/ws/.SNL_Doc/libraries/lib/graph.json';

function uri(path: string): MemUri {
  return { path, fsPath: path, scheme: 'mem', toString: () => `mem:${path}` };
}

vi.mock('vscode', () => ({
  env: { language: 'en' },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: { joinPath: (base: MemUri, ...parts: string[]) => uri([base.path.replace(/\/$/u, ''), ...parts].join('/')) },
  workspace: {
    fs: {
      stat: vi.fn(async (target: MemUri) => {
        if ([
          '/ws/.SNL_Doc',
          '/ws/.SNL_Doc/libraries',
          '/ws/.SNL_Doc/libraries/lib'
        ].includes(target.fsPath)) return { type: 2 };
        if (injectConcurrentWrite && target.fsPath === graphPath &&
            ++graphStatCount >= injectOnGraphStat) {
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

import {
  updateLibraryGraphNodeEntryId,
  wrapLibraryGraphNodeWithParent,
  mutateLibraryGraph
} from './snlDoc';

const root = uri('/ws') as never;

beforeEach(() => {
  injectConcurrentWrite = false;
  graphStatCount = 0;
  injectOnGraphStat = 1;
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

describe('wrapLibraryGraphNodeWithParent raw CAS writer', () => {
  const parent = {
    id: 'parent',
    label: 'Entry' as const,
    props: { entryId: 'entry-parent' }
  };

  it('wraps the latest raw graph without dropping unknown fields', async () => {
    expect(await wrapLibraryGraphNodeWithParent(root, 'lib', 'child', parent))
      .toEqual({ status: 'ok' });
    const graph = JSON.parse(dec.decode(files.get(graphPath)!));
    expect(graph.extension).toEqual({ keep: true });
    expect(graph.nodes.map((node: any) => node?.id ?? node)).toEqual([
      'root', 'parent', 'child', 'malformed'
    ]);
    expect(graph.relationships).toEqual([
      { from: 'root', to: 'parent', label: 'branch', properties: { order: 1 } },
      { from: 'parent', to: 'child', label: 'branch' },
      { from: 'child', to: 'root', label: 'custom', extra: true },
      9
    ]);
  });

  it('rejects a stale snapshot instead of undoing a concurrent CAS writer', async () => {
    injectConcurrentWrite = true;
    const result = await wrapLibraryGraphNodeWithParent(root, 'lib', 'root', parent);
    expect(result).toMatchObject({ status: 'error' });
    expect(result.status === 'error' ? result.message : '').toContain('Refusing stale write');
    const graph = JSON.parse(dec.decode(files.get(graphPath)!));
    expect(graph).toMatchObject({ writer: 'external', nodes: [{ id: 'root', external: true }] });
  });
});

describe('mutateLibraryGraph raw writer lock', () => {
  beforeEach(() => {
    files.set(graphPath, enc.encode(JSON.stringify({
      version: 2,
      extension: { keep: true },
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'a' }, nodeExtension: 1 },
        { id: 'child', label: 'Entry', props: { entryId: 'b' }, nodeExtension: 2 }
      ],
      relationships: [
        { from: 'root', to: 'child', label: 'branch', relationshipExtension: 3 }
      ]
    })));
  });

  it('serializes cooperating mutations and preserves wrapper/record extensions', async () => {
    const results = await Promise.all([
      mutateLibraryGraph(root, 'lib', ({ nodes }) => {
        nodes[0] = { ...nodes[0], props: { ...nodes[0].props, first: true } };
        return true;
      }),
      mutateLibraryGraph(root, 'lib', ({ nodes, relationships }) => {
        nodes[1] = { ...nodes[1], props: { ...nodes[1].props, second: true } };
        relationships[0] = { ...relationships[0], from: 'child' };
        return true;
      })
    ]);
    expect(results).toEqual([
      { status: 'ok', changed: true },
      { status: 'ok', changed: true }
    ]);
    const graph = JSON.parse(dec.decode(files.get(graphPath)!));
    expect(graph.extension).toEqual({ keep: true });
    expect(graph.nodes[0]).toMatchObject({ nodeExtension: 1, props: { first: true } });
    expect(graph.nodes[1]).toMatchObject({ nodeExtension: 2, props: { second: true } });
    expect(graph.relationships[0]).toMatchObject({
      from: 'child',
      relationshipExtension: 3
    });
  });

  it('rejects a stale raw snapshot rather than overwriting an injected writer', async () => {
    injectConcurrentWrite = true;
    injectOnGraphStat = 2;
    let rolledBack = false;
    const result = await mutateLibraryGraph(root, 'lib', ({ nodes }, transaction) => {
      transaction.onRollback(() => { rolledBack = true; });
      nodes[0] = { ...nodes[0], props: { ...nodes[0].props, changed: true } };
      return true;
    });
    expect(result).toMatchObject({ status: 'error' });
    expect(rolledBack).toBe(true);
    expect(result.status === 'error' ? result.message : '').toContain('Refusing stale write');
    expect(JSON.parse(dec.decode(files.get(graphPath)!))).toMatchObject({ writer: 'external' });
  });
});
