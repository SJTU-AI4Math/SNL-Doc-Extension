import { describe, expect, it, vi } from 'vitest';
import {
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath
} from './entityStorage';

import { makeEntityStorageReceipt } from './dataMigrations';

const encoder = new TextEncoder();
const reads: string[] = [];
const directoryReads: string[] = [];
const files = new Map<string, unknown>();

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { path: string; scheme?: string }, ...parts: string[]) => {
      const path = [base.path, ...parts].join('/');
      return { path, fsPath: path, scheme: base.scheme ?? 'file' };
    },
    file: (path: string) => ({ path, fsPath: path, scheme: 'file' })
  },
  FileType: { File: 1, Directory: 2 },
  window: { createOutputChannel: () => undefined },
  workspace: {
    fs: {
      stat: async (uri: { path: string }) => {
        if (!files.has(uri.path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        const value = files.get(uri.path);
        return { type: value && typeof value === 'object' &&
          (value as { directory?: unknown }).directory === true ? 2 : 1 };
      },
      readFile: async (uri: { path: string }) => {
        reads.push(uri.path);
        if (!files.has(uri.path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return encoder.encode(JSON.stringify(files.get(uri.path)));
      },
      readDirectory: async (uri: { path: string }) => {
        directoryReads.push(uri.path);
        throw new Error(`point read enumerated ${uri.path}`);
      },
      writeFile: async (uri: { path: string }, bytes: Uint8Array) => {
        files.set(uri.path, JSON.parse(new TextDecoder().decode(bytes)));
      }
    }
  }
}));

import {
  collectEntryDependencies,
  entityRevision,
  readEntriesByIds,
  readEntryDependencyClosure,
  readLibraryGraph,
  readMacrosByNames,
  readMacrosByNamesWithOrigin,
  updateLibrary,
  writeLibraryCounters,
  writeLibraryGraph
} from './snlDoc';

const root = { path: '/ws', fsPath: '/ws', scheme: 'file' } as never;
const snl = (relative: string): string => `/ws/.SNL_Doc/${relative}`;

function seedCurrentWorkspace(activePackages: string[] = []): Record<string, unknown> {
  const config = {
    version: '0.0.6', entry_kinds: [], macro_kinds: [],
    active_macro_packages: activePackages,
    entity_storage: {
      version: 1, entry_path_version: 2,
      legacy_backup_version: '0.0.4',
      entry_default_package: '_unpackaged',
      receipt: makeEntityStorageReceipt([], new Map(), false)
    }
  };
  files.set(snl('config.json'), config);
  for (const directory of ['packages', 'entries', 'macros']) {
    files.set(snl(directory), { directory: true });
  }
  for (const packageId of ['_unpackaged', ...activePackages]) {
    files.set(
      snl(packageManifestPath(packageId)),
      makePackageManifest(packageId, packageId, '')
    );
  }
  return config;
}

describe('Entry identity point reads', () => {
  it('extracts only identities referenced by visible Entry SNL', () => {
    const dependencies = collectEntryDependencies([
      { id: 'visible', kind: 'theorem', title: '', content: { snl: 'root(Eq(x@source-entry))' } }
    ]);
    expect(dependencies.macroNames).toContain('Eq');
    expect(dependencies.entryIds).toContain('source-entry');
  });

  it('updates Library metadata without enumerating unrelated entity storage', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    seedCurrentWorkspace();
    const original = { title: 'Old' };
    files.set('/ws/.SNL_Doc', { directory: true });
    files.set(snl('libraries/notes'), { directory: true });
    files.set(snl('libraries/notes/meta.json'), original);

    const result = await updateLibrary(
      { path: '/ws', fsPath: '/ws', scheme: 'mem' } as never,
      'notes',
      { title: 'New' },
      entityRevision(original)
    );

    expect(result).toEqual({
      status: 'updated', slug: 'notes', title: 'New',
      revision: entityRevision({ title: 'New' })
    });
    expect(directoryReads).toEqual([]);
    expect(files.get(snl('libraries/notes/meta.json'))).toEqual({ title: 'New' });

    files.set(snl('entries'), { directory: false });
    await expect(updateLibrary(
      { path: '/ws', fsPath: '/ws', scheme: 'mem' } as never,
      'notes',
      { title: 'Must not land' },
      entityRevision({ title: 'New' })
    )).rejects.toThrow(/not a directory/i);
    expect(files.get(snl('libraries/notes/meta.json'))).toEqual({ title: 'New' });
    files.set(snl('entries'), { directory: true });

    const currentConfig = files.get(snl('config.json')) as Record<string, unknown>;
    const storageMetadata = currentConfig.entity_storage as Record<string, unknown>;
    const validReceipt = storageMetadata.receipt as Record<string, unknown>;
    storageMetadata.receipt = { ...validReceipt, unexpected: true };
    await expect(updateLibrary(
      { path: '/ws', fsPath: '/ws', scheme: 'mem' } as never,
      'notes',
      { title: 'Must not land' },
      entityRevision({ title: 'New' })
    )).rejects.toThrow(/receipt/i);
    expect(files.get(snl('libraries/notes/meta.json'))).toEqual({ title: 'New' });

    storageMetadata.receipt = {};
    await expect(updateLibrary(
      { path: '/ws', fsPath: '/ws', scheme: 'mem' } as never,
      'notes',
      { title: 'Must not land' },
      entityRevision({ title: 'New' })
    )).rejects.toThrow(/receipt/i);
    expect(files.get(snl('libraries/notes/meta.json'))).toEqual({ title: 'New' });

    delete storageMetadata.receipt;
    await expect(updateLibrary(
      { path: '/ws', fsPath: '/ws', scheme: 'mem' } as never,
      'notes',
      { title: 'Must not land' },
      entityRevision({ title: 'New' })
    )).rejects.toThrow(/entity_storage|receipt/i);
    expect(files.get(snl('libraries/notes/meta.json'))).toEqual({ title: 'New' });
  });

  it('writes Library graph and counters without enumerating entity storage', async () => {
    files.clear();
    directoryReads.length = 0;
    files.set('/ws/.SNL_Doc', { directory: true });
    seedCurrentWorkspace();
    const memRoot = { path: '/ws', fsPath: '/ws', scheme: 'mem' } as never;

    const graph = await writeLibraryGraph(memRoot, 'notes', {
      nodes: [{ id: 'n1', label: 'Entry', props: { entryId: 'A' } }],
      relationships: []
    }, null);
    const counters = await writeLibraryCounters(memRoot, 'notes', [], null);
    const staleGraph = await writeLibraryGraph(memRoot, 'notes', {
      nodes: [], relationships: []
    }, null);

    expect(graph).toEqual({ status: 'ok' });
    expect(staleGraph).toMatchObject({ status: 'error' });
    expect(counters).toBeUndefined();
    await expect(writeLibraryCounters(memRoot, 'notes', [], null)).rejects.toThrow(/stale/i);
    expect(directoryReads).toEqual([]);
  });

  it('reads only requested hash paths regardless of unrelated entity count', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    seedCurrentWorkspace(['Logic']);
    files.set(snl(entryEntityPath('A')), makeEntryEnvelope('Logic', {
      id: 'A', package: 'Logic', title: 'A'
    }));
    files.set(snl(entryEntityPath('B')), makeEntryEnvelope('_unpackaged', {
      id: 'B', package: '_unpackaged', title: 'B'
    }));
    // These files represent an arbitrarily large unrelated catalog. The point
    // read must not know or care that they exist.
    for (let i = 0; i < 100; i++) {
      const id = `unrelated-${i}`;
      files.set(snl(entryEntityPath(id)), makeEntryEnvelope('_unpackaged', {
        id, package: '_unpackaged', title: id
      }));
    }

    const entries = await readEntriesByIds(root, ['B', 'A', 'B', 'missing']);

    expect(entries.map((entry) => entry.id)).toEqual(['B', 'A']);
    expect(directoryReads).toEqual([]);
    expect(reads).toEqual([
      snl('config.json'),
      snl(packageManifestPath('_unpackaged')),
      snl(packageManifestPath('Logic')),
      snl(entryEntityPath('B')),
      snl(entryEntityPath('A'))
    ]);
  });

  it('rejects a point-read Entry whose inactive Package manifest is missing', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    seedCurrentWorkspace();
    files.set(snl(entryEntityPath('Ghost.entry')), makeEntryEnvelope('Ghost', {
      id: 'Ghost.entry', package: 'Ghost', title: 'Ghost'
    }));

    await expect(readEntriesByIds(root, ['Ghost.entry']))
      .rejects.toThrow(/Ghost.*manifest|manifest.*Ghost/i);
    expect(directoryReads).toEqual([]);
    expect(reads).toContain(snl(entryEntityPath('Ghost.entry')));
  });

  it('resolves a cycle-safe transitive point-read dependency closure', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    seedCurrentWorkspace();
    files.set(snl(packageManifestPath('Inactive')), makePackageManifest('Inactive', 'Inactive', ''));
    files.set(snl(entryEntityPath('A')), makeEntryEnvelope('Inactive', {
      id: 'A', package: 'Inactive', title: 'A', content: { snl: 'x@B' }
    }));
    files.set(snl(entryEntityPath('B')), makeEntryEnvelope('_unpackaged', {
      id: 'B', package: '_unpackaged', title: 'B', content: { snl: 'y@C' }
    }));
    files.set(snl(entryEntityPath('C')), makeEntryEnvelope('_unpackaged', {
      id: 'C', package: '_unpackaged', title: 'C', content: { snl: 'z@A' }
    }));

    const seed = await readEntriesByIds(root, ['A']);
    reads.length = 0;
    const closure = await readEntryDependencyClosure(root, seed);

    expect(closure.entries.map((entry) => entry.id)).toEqual(['A', 'B', 'C']);
    expect([...closure.requestedEntryIds].sort()).toEqual(['A', 'B', 'C']);
    expect([...closure.requestedMacroNames].sort()).toEqual(['x', 'y', 'z']);
    expect(closure.candidatePackages).toContain('_unpackaged');
    expect(closure.candidatePackages).toContain('Inactive');
    expect(directoryReads).toEqual([]);
    expect(reads.filter((path) => path.includes('/entries/'))).toEqual([
      snl(entryEntityPath('B')),
      snl(entryEntityPath('C'))
    ]);
  });

  it('point-reads only requested Macro names from configured active Packages', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    seedCurrentWorkspace(['Logic', 'Extra']);
    files.set(snl(macroEntityPath('Logic', 'Eq')), makeMacroEnvelope('Logic', {
      name: 'Eq', source: { entries: ['A'], urls: [] }, styles: []
    }));
    files.set(snl(macroEntityPath('Extra', 'Eq')), makeMacroEnvelope('Extra', {
      name: 'Eq', source: { entries: ['B'], urls: [] }, styles: []
    }));
    for (let i = 0; i < 100; i++) {
      const name = `unrelated-${i}`;
      files.set(snl(macroEntityPath('Logic', name)), makeMacroEnvelope('Logic', {
        name, source: { entries: [], urls: [] }, styles: []
      }));
    }

    const result = await readMacrosByNamesWithOrigin(root, ['Eq', 'missing', 'Eq']);
    const macros = result.macros;

    // Package file order is deterministic last-write-wins; Extra sorts before
    // Logic, so Logic is the effective definition. The full candidate list is
    // retained so watcher invalidation also observes a previously-missing
    // Macro file being created.
    expect(result.packages).toEqual(['Extra', 'Logic']);
    expect(macros.Eq?.source?.entries).toEqual(['A']);
    expect(directoryReads).toEqual([]);
    expect(reads).toEqual([
      snl('config.json'),
      snl(packageManifestPath('_unpackaged')),
      snl(packageManifestPath('Logic')),
      snl(packageManifestPath('Extra')),
      snl(macroEntityPath('Extra', 'Eq')),
      snl(macroEntityPath('Logic', 'Eq'))
    ]);
  });

  it('fails closed on malformed active Package configuration without enumerating storage', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    const malformed = seedCurrentWorkspace();
    malformed.active_macro_packages = 'Logic';

    await expect(readMacrosByNames(root, ['Eq'])).rejects.toThrow(/active_macro_packages/);
    expect(directoryReads).toEqual([]);
    expect(reads).toEqual([snl('config.json')]);

    for (const version of ['0.0.5', '9.0.0']) {
      files.clear();
      reads.length = 0;
      files.set(snl('config.json'), { version });
      await expect(readEntriesByIds(root, ['A'])).rejects.toThrow(/current|newer/i);
      expect(directoryReads).toEqual([]);
      expect(reads).toEqual([snl('config.json')]);
    }

    files.clear();
    reads.length = 0;
    seedCurrentWorkspace(['Logic', 'logic']);
    await expect(readMacrosByNames(root, ['Eq'])).rejects.toThrow(/case-fold|duplicate/i);
    expect(directoryReads).toEqual([]);
    expect(reads).toEqual([snl('config.json')]);
  });

  it('loads a Library graph by point-reading only its referenced Entries', async () => {
    files.clear();
    reads.length = 0;
    directoryReads.length = 0;
    seedCurrentWorkspace(['Logic']);
    files.set(snl('libraries/notes/graph.json'), {
      nodes: [
        { id: 'n1', label: 'Entry', props: { entryId: 'A' } },
        { id: 'n2', label: 'Entry', props: { entryId: 'missing' } }
      ],
      relationships: []
    });
    files.set(snl(entryEntityPath('A')), makeEntryEnvelope('Logic', {
      id: 'A', package: 'Logic', title: 'A'
    }));
    for (let i = 0; i < 100; i++) {
      const id = `unrelated-${i}`;
      files.set(snl(entryEntityPath(id)), makeEntryEnvelope('_unpackaged', {
        id, package: '_unpackaged', title: id
      }));
    }

    const result = await readLibraryGraph(root, 'notes');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected graph');
    expect(result.result.entries.map((entry) => entry.id)).toEqual(['A']);
    expect(result.result.warnings).toContain(
      'Entry node "n2" references missing entry "missing"'
    );
    expect(directoryReads).toEqual([]);
    expect(reads).toEqual([
      snl('libraries/notes/graph.json'),
      snl('config.json'),
      snl(packageManifestPath('_unpackaged')),
      snl(packageManifestPath('Logic')),
      snl(entryEntityPath('A'))
    ]);
  });
});
