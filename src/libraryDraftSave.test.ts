import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MemUri { path: string; fsPath: string; scheme: string; toString(skip?: boolean): string }
const enc = new TextEncoder();
const dec = new TextDecoder();
const files = new Map<string, Uint8Array>();
let failWritePath: string | null = null;
let failAfterWritePath: string | null = null;
let truncateThenFailWritePath: string | null = null;
function uri(path: string): MemUri {
  return { path, fsPath: path, scheme: 'mem', toString: () => `mem:${path}` };
}
function json(path: string): any { return JSON.parse(dec.decode(files.get(path)!)); }

vi.mock('vscode', () => ({
  env: { language: 'en' }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: { joinPath: (base: MemUri, ...parts: string[]) => uri([base.path.replace(/\/$/u, ''), ...parts].join('/')) },
  workspace: {
    fs: {
      stat: vi.fn(async (target: MemUri) => {
        if (['/ws/.SNL_Doc', '/ws/.SNL_Doc/libraries', '/ws/.SNL_Doc/libraries/lib'].includes(target.fsPath)) return { type: 2 };
        if (files.has(target.fsPath)) return { type: 1 };
        throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
      }),
      readFile: vi.fn(async (target: MemUri) => {
        const value = files.get(target.fsPath);
        if (!value) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        return value;
      }),
      writeFile: vi.fn(async (target: MemUri, value: Uint8Array) => {
        if (target.fsPath === failWritePath) { failWritePath = null; throw new Error('injected write failure'); }
        if (target.fsPath === truncateThenFailWritePath) {
          truncateThenFailWritePath = null;
          files.set(target.fsPath, new Uint8Array(value.slice(0, Math.max(1, Math.floor(value.length / 2)))));
          throw new Error('injected truncated write failure');
        }
        files.set(target.fsPath, new Uint8Array(value));
        if (target.fsPath === failAfterWritePath) {
          failAfterWritePath = null;
          throw new Error('injected post-write failure');
        }
      }),
      delete: vi.fn(async (target: MemUri) => { files.delete(target.fsPath); })
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) }))
  }
}));

vi.mock('./workspaceDataMigration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspaceDataMigration')>()),
  inspectStoredWorkspaceData: vi.fn(async () => ({ status: 'current' }))
}));

import { entityRevision, updateLibraryDraft } from './snlDoc';
const root = uri('/ws') as never;
const metaPath = '/ws/.SNL_Doc/libraries/lib/meta.json';
const graphPath = '/ws/.SNL_Doc/libraries/lib/graph.json';
const countersPath = '/ws/.SNL_Doc/libraries/lib/counters.json';

beforeEach(() => {
  failWritePath = null;
  failAfterWritePath = null;
  truncateThenFailWritePath = null;
  files.clear();
  files.set('/ws/.SNL_Doc/config.json', enc.encode(JSON.stringify({
    version: '0.2.0', entry_kinds: [], macro_kinds: []
  })));
  files.set(metaPath, enc.encode(JSON.stringify({ title: 'Old', metaExtension: { keep: true } })));
  files.set(graphPath, enc.encode(JSON.stringify({
    graphExtension: { keep: true },
    nodes: [{
      id: 'root', label: 'Entry',
      props: { entryId: 'entry', counterId: 'counter-a', propsExtension: { keep: true } },
      nodeExtension: 7
    }],
    relationships: []
  })));
  files.set(countersPath, enc.encode(JSON.stringify({
    countersExtension: { keep: true },
    counters: [{ id: 'counter-a', name: 'theorem', numbering: '1', children: [], counterExtension: 9 }]
  })));
});

function revisions() {
  return {
    meta: entityRevision(json(metaPath)),
    graph: entityRevision(json(graphPath)),
    counters: entityRevision(json(countersPath))
  };
}
function managedGraphNodes(): any[] {
  return json(graphPath).nodes.map((node: any) => ({
    id: node.id,
    label: node.label,
    props: {
      ...(typeof node.props?.entryId === 'string' ? { entryId: node.props.entryId } : {}),
      ...(typeof node.props?.counterId === 'string' ? { counterId: node.props.counterId } : {})
    }
  }));
}
function managedCounters(): any[] {
  const project = (node: any): any => ({
    id: node.id,
    name: node.name,
    numbering: node.numbering,
    children: Array.isArray(node.children) ? node.children.map(project) : []
  });
  return json(countersPath).counters.map(project);
}
function payload() {
  return {
    title: 'New title',
    graph: { nodes: [{ id: 'root', label: 'Entry', props: { entryId: 'entry', counterId: 'counter-a' } }], relationships: [] },
    counters: [{ id: 'counter-a', name: 'renamed', numbering: 'I', children: [] }],
    expectedRevisions: revisions()
  };
}

describe('updateLibraryDraft three-file transaction', () => {
  it('CAS-updates all three files and preserves unknown wrapper and record fields', async () => {
    const result = await updateLibraryDraft(root, 'lib', payload());
    expect(result).toEqual({ status: 'updated', slug: 'lib', title: 'New title', revisions: revisions() });
    expect(json(metaPath)).toMatchObject({ title: 'New title', metaExtension: { keep: true } });
    expect(json(graphPath)).toMatchObject({
      graphExtension: { keep: true },
      nodes: [{ nodeExtension: 7, props: { propsExtension: { keep: true } } }]
    });
    expect(json(countersPath)).toMatchObject({ countersExtension: { keep: true }, counters: [{ counterExtension: 9, name: 'renamed' }] });
    expect(result.status === 'updated' ? result.revisions : null).toEqual(revisions());
  });

  it('preserves relationship extensions across a local endpoint change without persisting draft keys', async () => {
    files.set(graphPath, enc.encode(JSON.stringify({
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'root-entry' } },
        { id: 'other', label: 'Entry', props: { entryId: 'other-entry' } },
        { id: 'child', label: 'Entry', props: { entryId: 'child-entry' } }
      ],
      relationships: [
        { from: 'root', to: 'child', label: 'branch', relationshipExtension: { keep: true } }
      ]
    })));
    const input = {
      title: 'Moved child',
      graph: {
        nodes: managedGraphNodes(),
        relationships: [
          { from: 'other', to: 'child', label: 'branch', _draftKey: '0' }
        ]
      },
      counters: managedCounters(),
      expectedRevisions: revisions()
    };

    expect(await updateLibraryDraft(root, 'lib', input)).toMatchObject({ status: 'updated' });
    expect(json(graphPath).relationships).toEqual([{
      from: 'other', to: 'child', label: 'branch', relationshipExtension: { keep: true }
    }]);
  });

  it('preserves a valid relationship after tolerant reads skip an earlier raw row', async () => {
    files.set(graphPath, enc.encode(JSON.stringify({
      nodes: [
        { id: 'a', label: 'Entry', props: { entryId: 'a' } },
        { id: 'b', label: 'Entry', props: { entryId: 'b' } }
      ],
      relationships: [
        { from: 'missing', to: 'b', label: 'branch', malformedExtension: 'poison' },
        { from: 'a', to: 'b', label: 'reference', validExtension: 'keep' }
      ]
    })));
    const input = {
      title: 'Only title changed',
      graph: {
        nodes: managedGraphNodes(),
        relationships: [{ from: 'a', to: 'b', label: 'reference', _draftKey: '1' }]
      },
      counters: managedCounters(),
      expectedRevisions: revisions()
    };

    expect(await updateLibraryDraft(root, 'lib', input)).toMatchObject({ status: 'updated' });
    expect(json(graphPath).relationships).toEqual([{
      from: 'a', to: 'b', label: 'reference', validExtension: 'keep'
    }]);
  });

  it('rebinds relationship draft identities after a reordered save', async () => {
    files.set(graphPath, enc.encode(JSON.stringify({
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'root' } },
        { id: 'one', label: 'Entry', props: { entryId: 'one' } },
        { id: 'two', label: 'Entry', props: { entryId: 'two' } }
      ],
      relationships: [
        { from: 'root', to: 'one', label: 'branch', extension: 'one' },
        { from: 'root', to: 'two', label: 'branch', extension: 'two' }
      ]
    })));
    const firstInput = {
      title: 'Reordered',
      graph: {
        nodes: managedGraphNodes(),
        relationships: [
          { from: 'root', to: 'two', label: 'branch', _draftKey: '1' },
          { from: 'root', to: 'one', label: 'branch', _draftKey: '0' }
        ]
      },
      counters: managedCounters(),
      expectedRevisions: revisions()
    };
    const first = await updateLibraryDraft(root, 'lib', firstInput);
    expect(first.status).toBe('updated');
    if (first.status !== 'updated') throw new Error('expected update');

    const second = await updateLibraryDraft(root, 'lib', {
      ...firstInput,
      graph: {
        ...firstInput.graph,
        relationships: firstInput.graph.relationships.map((relationship, index) => ({
          ...relationship, _draftKey: String(index)
        }))
      },
      expectedRevisions: first.revisions
    });
    expect(second.status).toBe('updated');
    expect(json(graphPath).relationships.map((relationship: any) => relationship.extension))
      .toEqual(['two', 'one']);
  });

  it('creates optional graph and counter sidecars from the null revision', async () => {
    files.delete(graphPath);
    files.delete(countersPath);
    const result = await updateLibraryDraft(root, 'lib', {
      title: 'First outline',
      graph: { nodes: [], relationships: [] },
      counters: [],
      expectedRevisions: {
        meta: entityRevision(json(metaPath)),
        graph: entityRevision(null),
        counters: entityRevision(null)
      }
    });
    expect(result).toMatchObject({ status: 'updated', title: 'First outline' });
    expect(json(graphPath)).toEqual({ nodes: [], relationships: [] });
    expect(json(countersPath)).toEqual({ counters: [] });
  });

  it('rejects any stale revision before writing any file', async () => {
    const input = payload();
    input.expectedRevisions.graph = 'stale';
    const before = new Map(files);
    expect(await updateLibraryDraft(root, 'lib', input)).toMatchObject({ status: 'conflict' });
    expect([...files.entries()]).toEqual([...before.entries()]);
  });

  it('rejects graph counter references missing from the submitted counter tree', async () => {
    const input = payload();
    input.counters = [];
    expect(await updateLibraryDraft(root, 'lib', input)).toMatchObject({ status: 'invalid' });
    expect(json(metaPath).title).toBe('Old');
  });

  it.each([
    ['payload', (input: any) => { input.attackerPayload = true; }],
    ['graph envelope', (input: any) => { input.graph.attackerGraph = true; }],
    ['revision envelope', (input: any) => { input.expectedRevisions.attackerRevision = true; }],
    ['node', (input: any) => { input.graph.nodes[0].attackerNode = true; }],
    ['node props', (input: any) => { input.graph.nodes[0].props.attackerProp = true; }],
    ['relationship', (input: any) => {
      input.graph.relationships = [{ from: 'root', to: 'root', label: 'reference', attackerRelationship: true }];
    }],
    ['counter', (input: any) => { input.counters[0].attackerCounter = true; }]
  ])('rejects unknown %s fields from the untrusted wire payload before writing', async (_surface, mutate) => {
    const input = payload() as any;
    mutate(input);
    const before = new Map(files);
    expect(await updateLibraryDraft(root, 'lib', input)).toMatchObject({ status: 'invalid' });
    expect([...files.entries()]).toEqual([...before.entries()]);
  });

  it('rejects sparse Counter arrays from the untrusted structured-clone payload', async () => {
    const input = payload() as any;
    input.counters = new Array(2);
    input.counters[1] = { id: 'counter-a', name: 'renamed', numbering: 'I', children: [] };
    const before = new Map(files);
    expect(await updateLibraryDraft(root, 'lib', input)).toMatchObject({ status: 'invalid' });
    expect([...files.entries()]).toEqual([...before.entries()]);
  });

  it.each([
    ['first', metaPath],
    ['second', graphPath],
    ['third', countersPath]
  ])('rolls back the complete transaction when the %s write fails', async (_position, failedPath) => {
    const before = { meta: json(metaPath), graph: json(graphPath), counters: json(countersPath) };
    failWritePath = failedPath;
    expect(await updateLibraryDraft(root, 'lib', payload())).toMatchObject({ status: 'error' });
    expect(json(metaPath)).toEqual(before.meta);
    expect(json(graphPath)).toEqual(before.graph);
    expect(json(countersPath)).toEqual(before.counters);
  });

  it('rolls back the current file when its backend mutates bytes before rejecting', async () => {
    const before = { meta: json(metaPath), graph: json(graphPath), counters: json(countersPath) };
    failAfterWritePath = countersPath;
    expect(await updateLibraryDraft(root, 'lib', payload())).toMatchObject({ status: 'error' });
    expect(json(metaPath)).toEqual(before.meta);
    expect(json(graphPath)).toEqual(before.graph);
    expect(json(countersPath)).toEqual(before.counters);
  });

  it('restores every file byte-for-byte when the current write truncates before rejecting', async () => {
    const before = new Map([
      [metaPath, new Uint8Array(files.get(metaPath)!)],
      [graphPath, new Uint8Array(files.get(graphPath)!)],
      [countersPath, new Uint8Array(files.get(countersPath)!)]
    ]);
    truncateThenFailWritePath = countersPath;
    expect(await updateLibraryDraft(root, 'lib', payload())).toMatchObject({ status: 'error' });
    for (const [path, bytes] of before) expect(files.get(path)).toEqual(bytes);
  });
});
