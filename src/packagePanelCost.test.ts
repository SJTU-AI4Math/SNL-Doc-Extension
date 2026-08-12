import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { entryEntityPath, makeEntryEnvelope, makeMacroEnvelope, makePackageManifest, macroEntityPath, packageManifestPath } from './entityStorage';

const PACKAGE_COUNT = 24;
const packageIds = Array.from({ length: PACKAGE_COUNT }, (_, index) => `pkg-${String(index).padStart(2, '0')}`);
const jsonByPath = new Map<string, unknown>();
function seedCurrentTopology(): void {
  jsonByPath.clear();
  for (const id of packageIds) {
    jsonByPath.set(`packages/${packageManifestPath(id).slice('packages/'.length)}`, makePackageManifest(id, id.toUpperCase(), ''));
    const name = `macro.${id}`;
    jsonByPath.set(`macros/${macroEntityPath(id, name).slice('macros/'.length)}`, makeMacroEnvelope(id, {
      name,
      description: '',
      source: { entries: [], urls: [] },
      kind: 'const',
      dynamic_arity: false,
      styles: [{
        style_name: 'default',
        template: { mode: 'formula_inline', body: name },
        tags: []
      }],
      tags: []
    }));
  }
  jsonByPath.set('config.json', {
    version: '0.0.11',
    entry_kinds: [],    macro_kinds: [],
    active_macro_packages: packageIds
  });
}
seedCurrentTopology();

const state = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => Promise<void>) | undefined,
  posted: [] as Array<Record<string, unknown>>,
  snapshotCalls: 0,
  directoryReads: [] as string[],
  entityReads: [] as string[],
  entityInFlight: 0,
  maxEntityInFlight: 0,
  writes: [] as string[],
  failOnceAt: null as string | null,
  mutateBeforeRead: null as ((relative: string) => void) | null
}));

function relativePath(uri: { path: string }): string {
  return uri.path.replace(/^\/ws\/.SNL_Doc\/?/, '');
}

vi.mock('vscode', () => ({
  ColorThemeKind: { Dark: 2 },
  FileType: { File: 1, Directory: 2 },
  env: { language: 'en' },
  Uri: { joinPath: (base: { path: string }, ...parts: string[]) => {
    const joined = [base.path, ...parts].join('/');
    return { path: joined, fsPath: joined };
  } },
  ViewColumn: { Active: -1 },
  RelativePattern: class {},
  commands: { executeCommand: async () => undefined },
  window: {
    activeColorTheme: { kind: 2 },
    createOutputChannel: () => undefined,
    createWebviewPanel: () => ({
      webview: {
        html: '',
        postMessage: async (message: Record<string, unknown>) => { state.posted.push(message); return true; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          state.receive = handler;
          return { dispose: () => undefined };
        }
      },
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }),
    showWarningMessage: async () => undefined
  },
  workspace: {
    fs: {
      stat: async (uri: { path: string }) => {
        const relative = relativePath(uri);
        if (
          uri.path === '/ws/.SNL_Doc' || relative === 'config.json' || jsonByPath.has(relative) ||
          [...jsonByPath.keys()].some((path) => path.startsWith(`${relative}/`))
        ) return {};
        throw new Error(`ENOENT: ${relative}`);
      },
      readDirectory: async (uri: { path: string }) => {
        const directory = relativePath(uri);
        state.directoryReads.push(directory);
        return [...jsonByPath.keys()]
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => [path.slice(directory.length + 1), 1] as [string, number]);
      },
      readFile: async (uri: { path: string }) => {
        const relative = relativePath(uri);
        state.mutateBeforeRead?.(relative);
        state.entityReads.push(relative);
        state.entityInFlight += 1;
        state.maxEntityInFlight = Math.max(state.maxEntityInFlight, state.entityInFlight);
        await new Promise((resolve) => setTimeout(resolve, relative.includes('pkg-00') ? 3 : 1));
        state.entityInFlight -= 1;
        return new TextEncoder().encode(JSON.stringify(jsonByPath.get(relative)));
      },
      writeFile: async (uri: { path: string }, bytes: Uint8Array) => {
        const relative = relativePath(uri);
        state.writes.push(relative);
        if (state.failOnceAt === relative) {
          state.failOnceAt = null;
          throw new Error(`injected write failure: ${relative}`);
        }
        jsonByPath.set(relative, JSON.parse(new TextDecoder().decode(bytes)));
      },
      createDirectory: async () => undefined,
      delete: async (uri: { path: string }) => {
        const relative = relativePath(uri);
        state.writes.push(`delete:${relative}`);
        if (state.failOnceAt === relative) {
          state.failOnceAt = null;
          throw new Error(`injected delete failure: ${relative}`);
        }
        jsonByPath.delete(relative);
      }
    },
    getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  }
}));

vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/ws' }),
  handlePanelNavMessage: async () => false,
  installSnlDocWatcher: () => undefined,
  webviewLocalResourceRoots: () => []
}));

vi.mock('./snlDoc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snlDoc')>();
  return {
    ...actual,
    readPackageMacroSnapshot: async (...args: Parameters<typeof actual.readPackageMacroSnapshot>) => {
      state.snapshotCalls += 1;
      return actual.readPackageMacroSnapshot(...args);
    },
    readPackagePanelSnapshot: async () => {
      state.snapshotCalls += 1;
      return {
        selected: { status: 'ok', pkg: { version: '9', name: 'Current', macros: {} }, macros: [] },
        workspaceMacros: {},
        macroKinds: [],
        active: ['current', 'alpha', 'beta'],
        otherPackages: [{ file: 'alpha', name: 'ALPHA' }, { file: 'beta', name: 'BETA' }]
      };
    },
    readMacroPackage: async () => { throw new Error('PackagePanel must not perform per-package reads'); },
    readAllMacros: async () => { throw new Error('PackagePanel must not start a second macro scan'); },
    resolveActiveMacroPackages: async () => { throw new Error('PackagePanel must derive active packages from its snapshot'); },
    readMacroKinds: async () => { throw new Error('PackagePanel must derive macro kinds from its snapshot config'); },
    readEntries: async () => [],
    setMacroPackageActive: async () => undefined,
    batchDeleteMacros: async () => ({ status: 'ok' }),
    batchMoveMacros: async () => ({ status: 'ok' }),
    batchCopyMacros: async () => ({ status: 'ok' }),
    batchPackageAsNew: async () => ({ status: 'ok' }),
    batchMoveToNewPackage: async () => ({ status: 'ok' })
  };
});

const extensionUri = { path: '/ext' } as never;

function entryKindConfig(): Record<string, unknown> {
  return {
    version: '0.0.11',
    entry_kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: '', style: '', coloring: {
      light: { stroke: '#888', background: '#888' }, dark: { stroke: '#888', background: '#888' }
    } }],
    macro_kinds: [], active_macro_packages: [],
    entity_storage: {
      version: 1, legacy_backup_version: '0.0.5', entry_default_package: '_unpackaged',
      receipt: {
        legacy_backup_present: false, legacy_entries_present: false,
        entry_count: 0, macro_package_count: 0, macro_count: 0,
        entries_digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        macro_packages_digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
      }
    }
  };
}

function newEntry(id: string, packageId: string) {
  return { id, package: packageId, kind: 'definition', title: 'Changed', content: { snl: '' }, pointer: null };
}

function seedEntryTransactionTopology(): void {
  jsonByPath.clear(); state.writes.length = 0; state.failOnceAt = null; state.mutateBeforeRead = null;
  jsonByPath.set('config.json', entryKindConfig());
  jsonByPath.set(packageManifestPath('_unpackaged'), makePackageManifest('_unpackaged', 'Unpackaged', '', []));
  jsonByPath.set(packageManifestPath('logic'), makePackageManifest('logic', 'Logic', '', []));
  jsonByPath.set('entries/.gitkeep', null);
  jsonByPath.set('macros/.gitkeep', null);
}

function seedMoveTransactionTopology(id: string) {
  seedEntryTransactionTopology();
  const oldEntry = makeEntryEnvelope('source', { ...newEntry(id, 'source'), title: 'Old' });
  jsonByPath.delete(packageManifestPath('logic'));
  jsonByPath.set(packageManifestPath('source'), makePackageManifest('source', 'Source', '', [id]));
  jsonByPath.set(packageManifestPath('destination'), makePackageManifest('destination', 'Destination', '', []));
  jsonByPath.set(entryEntityPath('source', id), oldEntry);
  return oldEntry;
}

function seedDeleteTransactionTopology(id: string): void {
  seedEntryTransactionTopology();
  jsonByPath.set(packageManifestPath('logic'), makePackageManifest('logic', 'Logic', '', [id]));
  jsonByPath.set(entryEntityPath('logic', id), makeEntryEnvelope('logic', { ...newEntry(id, 'logic'), title: 'Delete' }));
}

describe('PackagePanel read cost', () => {
  beforeEach(() => {
    seedCurrentTopology();
    state.receive = undefined;
    state.posted.length = 0;
    state.snapshotCalls = 0;
    state.directoryReads.length = 0;
    state.entityReads.length = 0;
    state.entityInFlight = 0;
    state.maxEntityInFlight = 0;
    state.writes.length = 0;
    state.failOnceAt = null;
    state.mutateBeforeRead = null;
  });

  it('uses one operation-local snapshot for the selected package and all derived package data', async () => {
    const { PackagePanel } = await import('./packagePanel');
    (PackagePanel as unknown as { panels: Map<string, unknown> }).panels.clear();
    PackagePanel.createOrShow(extensionUri, 'current.json');

    await state.receive?.({ type: 'ready' });

    expect(state.snapshotCalls).toBe(1);
    const payload = state.posted.find(({ type }) => type === 'package');
    expect(payload?.otherPackages).toEqual([
      { file: 'alpha', name: 'ALPHA' },
      { file: 'beta', name: 'BETA' }
    ]);
  });

  it('enumerates exactly the selected Package Entry ids without catalog or Macro reads', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', {
      version: '0.0.11', entry_kinds: [], macro_kinds: [],
      active_macro_packages: []
    });
    const selectedIds = ['logic.first', 'logic.second'];
    jsonByPath.set(packageManifestPath('logic'), makePackageManifest('logic', 'Logic', '', selectedIds));
    jsonByPath.set(packageManifestPath('other'), makePackageManifest('other', 'Other', '', ['other.only']));
    for (const [packageId, ids] of [['logic', selectedIds], ['other', ['other.only']]] as const) {
      for (const id of ids) {
        jsonByPath.set(entryEntityPath(packageId, id), makeEntryEnvelope(packageId, {
          id, package: packageId, kind: 'definition', title: id, content: { snl: '' }, pointer: null
        }));
      }
    }
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readEntryPackagePanelSnapshot({ path: '/ws' } as never, 'logic');

    expect(snapshot.selected).toMatchObject({
      status: 'ok', entries: selectedIds.map((id) => expect.objectContaining({ id, package: 'logic' }))
    });
    expect(state.directoryReads).not.toContain('entries');
    expect(state.entityReads.filter((entryPath) => entryPath.startsWith('entries/')).sort()).toEqual(
      selectedIds.map((id) => entryEntityPath('logic', id)).sort()
    );
    expect(state.entityReads.some((entryPath) => entryPath.startsWith('macros/'))).toBe(false);

    const source = fs.readFileSync(path.resolve(__dirname, 'snlDoc.ts'), 'utf8');
    const implementation = source.slice(
      source.indexOf('export async function readEntryPackagePanelSnapshot'),
      source.indexOf('// ---------------------------------------------------------------------------', source.indexOf('export async function readEntryPackagePanelSnapshot'))
    );
    expect(implementation).not.toContain('readEntryEntityRecords(');
    expect(implementation).not.toContain('readPackageMacroSnapshot(');
  });

  it('rejects Entry creation from a malformed Package manifest before any write', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', {
      version: '0.0.11', entry_kinds: [], macro_kinds: [], active_macro_packages: [],
      entity_storage: {
        version: 1, legacy_backup_version: '0.0.5', entry_default_package: '_unpackaged',
        receipt: {
          legacy_backup_present: false, legacy_entries_present: false,
          entry_count: 0, macro_package_count: 0, macro_count: 0,
          entries_digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
          macro_packages_digest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        }
      }
    });
    jsonByPath.set(packageManifestPath('logic'), {
      format: 'snl-package', version: 1, schema_version: 1,
      id: 'logic', name: 42, description: '', entry_ids: []
    });
    // Ensure every current-topology directory exists in the in-memory provider.
    jsonByPath.set('entries/.gitkeep', null);
    jsonByPath.set('macros/.gitkeep', null);
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const result = await actual.addEntry({ path: '/ws', toString: () => 'file:///ws' } as never, {
      id: 'new.entry', package: 'logic', kind: 'definition', title: 'New',
      content: { snl: '' }, pointer: null
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(state.writes).toEqual([]);
    const source = fs.readFileSync(path.resolve(__dirname, 'snlDoc.ts'), 'utf8');
    const implementation = source.slice(
      source.indexOf('export async function addEntry'),
      source.indexOf('/**', source.indexOf('export async function addEntry') + 1)
    );
    expect(implementation).toContain('readPackageManifestRecord(');
    expect(implementation).not.toContain('exists(snlRelativeUri(workspaceRoot, packageManifestPath(packageId)))');
  });

  it('rolls back create membership when the manifest CAS write fails', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', { version: '0.0.11', entry_kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: '', style: '', coloring: { light: { stroke: '#888', background: '#888' }, dark: { stroke: '#888', background: '#888' } } }], macro_kinds: [], active_macro_packages: [] });
    const manifestPath = packageManifestPath('logic');
    jsonByPath.set(manifestPath, makePackageManifest('logic', 'Logic', '', []));
    state.failOnceAt = manifestPath;
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const result = await actual.addEntry({ path: '/ws', toString: () => 'file:///ws' } as never, {
      id: 'logic.new', package: 'logic', kind: 'definition', title: 'New',
      content: { snl: '' }, pointer: null
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(jsonByPath.get(manifestPath)).toEqual(makePackageManifest('logic', 'Logic', '', []));
    expect(jsonByPath.has(entryEntityPath('logic', 'logic.new'))).toBe(false);
  });

  it('rolls back a cross-Package move after an injected membership failure', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', { version: '0.0.11', entry_kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: '', style: '', coloring: { light: { stroke: '#888', background: '#888' }, dark: { stroke: '#888', background: '#888' } } }], macro_kinds: [], active_macro_packages: [] });
    const id = 'logic.move';
    const sourcePath = packageManifestPath('source');
    const destinationPath = packageManifestPath('destination');
    const oldEntryPath = entryEntityPath('source', id);
    const oldEntry = makeEntryEnvelope('source', { id, package: 'source', kind: 'definition', title: 'Old', content: { snl: '' }, pointer: null });
    jsonByPath.set(sourcePath, makePackageManifest('source', 'Source', '', [id]));
    jsonByPath.set(destinationPath, makePackageManifest('destination', 'Destination', '', []));
    jsonByPath.set(oldEntryPath, oldEntry);
    state.failOnceAt = sourcePath;
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const result = await actual.updateEntry({ path: '/ws', toString: () => 'file:///ws' } as never, id, {
      package: 'destination', kind: 'definition', title: 'Moved', content: { snl: '' }, pointer: null
    }, actual.entityRevision(oldEntry.entry));

    expect(result).toMatchObject({ status: 'error' });
    expect(jsonByPath.get(sourcePath)).toEqual(makePackageManifest('source', 'Source', '', [id]));
    expect(jsonByPath.get(destinationPath)).toEqual(makePackageManifest('destination', 'Destination', '', []));
    expect(jsonByPath.get(oldEntryPath)).toEqual(oldEntry);
    expect(jsonByPath.has(entryEntityPath('destination', id))).toBe(false);
  });

  it('rejects package-bound deletion of owner-matching but unindexed hidden data', async () => {
    jsonByPath.clear();
    state.writes.length = 0;
    jsonByPath.set('config.json', entryKindConfig());
    const id = 'logic.hidden';
    const manifestPath = packageManifestPath('logic');
    const entityPath = entryEntityPath('logic', id);
    const hidden = makeEntryEnvelope('logic', {
      id, package: 'logic', kind: 'definition', title: 'Hidden', content: { snl: '' }, pointer: null
    });
    jsonByPath.set(manifestPath, makePackageManifest('logic', 'Logic', '', []));
    jsonByPath.set(entityPath, hidden);
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');
    const root = { path: '/ws', toString: () => 'mem:/ws' } as never;

    await expect(actual.entryBelongsToPackage(root, 'logic', id)).resolves.toBe(false);
    const result = await actual.deleteEntry(root, id, 'logic');

    expect(result).toMatchObject({ status: expect.stringMatching(/invalid|notFound|error/) });
    expect(jsonByPath.get(entityPath)).toEqual(hidden);
    expect(state.writes).toEqual([]);
  });

  it('rolls back delete membership when Entry deletion fails', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', { version: '0.0.11', entry_kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: '', style: '', coloring: { light: { stroke: '#888', background: '#888' }, dark: { stroke: '#888', background: '#888' } } }], macro_kinds: [], active_macro_packages: [] });
    const id = 'logic.delete';
    const manifestPath = packageManifestPath('logic');
    const entityPath = entryEntityPath('logic', id);
    const entry = makeEntryEnvelope('logic', { id, package: 'logic', kind: 'definition', title: 'Delete', content: { snl: '' }, pointer: null });
    jsonByPath.set(manifestPath, makePackageManifest('logic', 'Logic', '', [id]));
    jsonByPath.set(entityPath, entry);
    state.failOnceAt = entityPath;
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const result = await actual.deleteEntry({ path: '/ws', toString: () => 'file:///ws' } as never, id, 'logic');

    expect(result).toMatchObject({ status: 'error' });
    expect(jsonByPath.get(manifestPath)).toEqual(makePackageManifest('logic', 'Logic', '', [id]));
    expect(jsonByPath.get(entityPath)).toEqual(entry);
  });

  it('restores exact create state for every publication fault and stale manifest CAS', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');
    const root = { path: '/ws', toString: () => 'file:///ws' } as never;
    const manifestPath = packageManifestPath('logic');
    const entityPath = entryEntityPath('logic', 'logic.new');
    for (const failedPath of [entityPath, manifestPath]) {
      seedEntryTransactionTopology();
      state.failOnceAt = failedPath;
      const before = structuredClone([...jsonByPath]);
      const result = await actual.addEntry(root, newEntry('logic.new', 'logic'));
      expect(result, failedPath).toMatchObject({ status: 'error' });
      expect(state.writes, failedPath).toContain(failedPath);
      expect([...jsonByPath], failedPath).toEqual(before);
    }

    seedEntryTransactionTopology();
    let mutated = false;
    state.mutateBeforeRead = (relative) => {
      if (!mutated && relative === manifestPath && state.writes.includes(entityPath)) {
        mutated = true;
        const manifest = structuredClone(jsonByPath.get(manifestPath)) as Record<string, unknown>;
        manifest.description = 'external manifest edit';
        jsonByPath.set(manifestPath, manifest);
        state.mutateBeforeRead = null;
      }
    };
    const result = await actual.addEntry(root, newEntry('logic.new', 'logic'));
    expect(mutated).toBe(true);
    expect(result).toMatchObject({ status: 'error' });
    expect(jsonByPath.has(entityPath)).toBe(false);
    expect(jsonByPath.get(manifestPath)).toMatchObject({ description: 'external manifest edit', entry_ids: [] });
  });

  it('restores exact move state for every publication fault and later manifest/entity CAS', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');
    const root = { path: '/ws', toString: () => 'file:///ws' } as never;
    const id = 'logic.move';
    const sourceManifestPath = packageManifestPath('source');
    const destinationManifestPath = packageManifestPath('destination');
    const sourceEntryPath = entryEntityPath('source', id);
    const destinationEntryPath = entryEntityPath('destination', id);
    for (const failedPath of [destinationEntryPath, destinationManifestPath, sourceManifestPath, sourceEntryPath]) {
      const oldEntry = seedMoveTransactionTopology(id);
      state.failOnceAt = failedPath;
      const before = structuredClone([...jsonByPath]);
      const result = await actual.updateEntry(root, id, newEntry(id, 'destination'), actual.entityRevision(oldEntry.entry));
      expect(result, failedPath).toMatchObject({ status: 'error' });
      expect(state.writes, failedPath).toContain(
        failedPath === sourceEntryPath ? `delete:${failedPath}` : failedPath
      );
      expect([...jsonByPath], failedPath).toEqual(before);
    }

    for (const [casPath, completedWrites] of [
      [destinationManifestPath, 1], [sourceManifestPath, 2], [sourceEntryPath, 3]
    ] as const) {
      const oldEntry = seedMoveTransactionTopology(id);
      const originalSourceManifest = structuredClone(jsonByPath.get(sourceManifestPath));
      const originalDestinationManifest = structuredClone(jsonByPath.get(destinationManifestPath));
      let mutated = false;
      state.mutateBeforeRead = (relative) => {
        if (!mutated && relative === casPath && state.writes.length === completedWrites) {
          mutated = true;
          const value = structuredClone(jsonByPath.get(casPath)) as Record<string, any>;
          if (casPath === sourceEntryPath) value.entry.title = 'external entity edit';
          else value.description = 'external manifest edit';
          jsonByPath.set(casPath, value);
          state.mutateBeforeRead = null;
        }
      };
      const result = await actual.updateEntry(root, id, newEntry(id, 'destination'), actual.entityRevision(oldEntry.entry));
      expect(mutated, casPath).toBe(true);
      expect(result, casPath).toMatchObject({ status: 'error' });
      expect(jsonByPath.has(destinationEntryPath), casPath).toBe(false);
      if (casPath === destinationManifestPath) {
        expect(jsonByPath.get(destinationManifestPath)).toMatchObject({
          description: 'external manifest edit', entry_ids: []
        });
        expect(jsonByPath.get(sourceManifestPath)).toEqual(originalSourceManifest);
        expect(jsonByPath.get(sourceEntryPath)).toEqual(oldEntry);
      } else if (casPath === sourceManifestPath) {
        expect(jsonByPath.get(destinationManifestPath), casPath).toEqual(originalDestinationManifest);
        expect(jsonByPath.get(sourceManifestPath)).toMatchObject({ description: 'external manifest edit', entry_ids: [id] });
        expect(jsonByPath.get(sourceEntryPath)).toEqual(oldEntry);
      } else {
        expect(jsonByPath.get(destinationManifestPath), casPath).toEqual(originalDestinationManifest);
        expect(jsonByPath.get(sourceManifestPath)).toEqual(originalSourceManifest);
        expect(jsonByPath.get(sourceEntryPath)).toMatchObject({ entry: { title: 'external entity edit' } });
      }
    }
  });

  it('restores exact delete state for every publication fault and stale entity CAS', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');
    const root = { path: '/ws', toString: () => 'file:///ws' } as never;
    const id = 'logic.delete';
    const manifestPath = packageManifestPath('logic');
    const entityPath = entryEntityPath('logic', id);
    for (const failedPath of [manifestPath, entityPath]) {
      seedDeleteTransactionTopology(id);
      state.failOnceAt = failedPath;
      const before = structuredClone([...jsonByPath]);
      const result = await actual.deleteEntry(root, id, 'logic');
      expect(result, failedPath).toMatchObject({ status: 'error' });
      expect(state.writes, failedPath).toContain(
        failedPath === entityPath ? `delete:${failedPath}` : failedPath
      );
      expect([...jsonByPath], failedPath).toEqual(before);
    }

    seedDeleteTransactionTopology(id);
    const originalManifest = structuredClone(jsonByPath.get(manifestPath));
    let mutated = false;
    state.mutateBeforeRead = (relative) => {
      if (!mutated && relative === entityPath && state.writes.length === 1) {
        mutated = true;
        const value = structuredClone(jsonByPath.get(entityPath)) as Record<string, any>;
        value.entry.title = 'external entity edit';
        jsonByPath.set(entityPath, value);
        state.mutateBeforeRead = null;
      }
    };
    const result = await actual.deleteEntry(root, id, 'logic');
    expect(mutated).toBe(true);
    expect(result).toMatchObject({ status: 'error' });
    expect(jsonByPath.get(manifestPath)).toEqual(originalManifest);
    expect(jsonByPath.get(entityPath)).toMatchObject({ entry: { title: 'external entity edit' } });
  });

  it('rejects stale Entry revisions and stale listed membership before publish', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', { version: '0.0.11', entry_kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: '', style: '', coloring: { light: { stroke: '#888', background: '#888' }, dark: { stroke: '#888', background: '#888' } } }], macro_kinds: [], active_macro_packages: [] });
    const manifestPath = packageManifestPath('logic');
    jsonByPath.set(manifestPath, makePackageManifest('logic', 'Logic', '', ['missing.entry']));
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const create = await actual.addEntry({ path: '/ws', toString: () => 'file:///ws' } as never, {
      id: 'logic.new', package: 'logic', kind: 'definition', title: 'New', content: { snl: '' }, pointer: null
    });
    expect(create).toMatchObject({ status: 'error' });
    expect(state.writes).toEqual([]);

    jsonByPath.set(manifestPath, makePackageManifest('logic', 'Logic', '', ['logic.old']));
    const entityPath = entryEntityPath('logic', 'logic.old');
    const entry = makeEntryEnvelope('logic', { id: 'logic.old', package: 'logic', kind: 'definition', title: 'Old', content: { snl: '' }, pointer: null });
    jsonByPath.set(entityPath, entry);
    const update = await actual.updateEntry({ path: '/ws', toString: () => 'file:///ws' } as never, 'logic.old', {
      package: 'logic', kind: 'definition', title: 'Changed', content: { snl: '' }, pointer: null
    }, 'stale-revision');
    expect(update).toMatchObject({ status: 'error' });
    expect(state.writes).toEqual([]);
    expect(jsonByPath.get(entityPath)).toEqual(entry);
  });

  it('uses one current-storage Package/Macro snapshot per SNoogL query', async () => {
    const { SnoogLPanel } = await import('./snooglPanel');
    (SnoogLPanel as unknown as { instance: { dispose(): void } | null }).instance?.dispose();
    SnoogLPanel.open(extensionUri, 'macro');

    await state.receive?.({ type: 'ready' });

    expect(state.snapshotCalls).toBe(1);
    expect(state.directoryReads.filter((path) => path === 'packages')).toHaveLength(1);
    expect(state.directoryReads.filter((path) => path === 'macros')).toHaveLength(1);
    expect(state.entityReads.filter((path) => path.startsWith('packages/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.entityReads.filter((path) => path.startsWith('macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('lists and reads every Package/Macro entity at most once with bounded fan-out', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');
    const snapshot = await actual.readPackagePanelSnapshot({ path: '/ws' } as never, 'pkg-00');

    expect(snapshot.selected.status).toBe('ok');
    expect(Object.keys(snapshot.workspaceMacros)).toHaveLength(PACKAGE_COUNT);
    expect(state.directoryReads.sort()).toEqual(['macros', 'packages']);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.entityReads.filter((path) => path.startsWith('packages/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.entityReads.filter((path) => path.startsWith('macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.maxEntityInFlight).toBeGreaterThan(1);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('gives readAllMacros the same single-snapshot P-package/M-macro read cost', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const macros = await actual.readAllMacros({ path: '/ws' } as never);

    expect(Object.keys(macros)).toHaveLength(PACKAGE_COUNT);
    expect(state.directoryReads.sort()).toEqual(['macros', 'packages']);
    expect(state.entityReads.filter((path) => path.startsWith('packages/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.entityReads.filter((path) => path.startsWith('macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('folds collisions deterministically in file order and exposes the winning origin', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', {
      version: '0.0.11', entry_kinds: [], macro_kinds: [], active_macro_packages: ['core', 'core-extra']    });
    for (const id of ['core', 'core-extra']) {
      jsonByPath.set(`packages/${packageManifestPath(id).slice('packages/'.length)}`, makePackageManifest(id, id, ''));
      jsonByPath.set(`macros/${macroEntityPath(id, 'Shared.name').slice('macros/'.length)}`, makeMacroEnvelope(id, {
        name: 'Shared.name',
        description: id,
        source: { entries: [], urls: [] },
        kind: 'const',
        dynamic_arity: false,
        styles: [{
          style_name: 'default',
          template: { mode: 'formula_inline', body: id },
          tags: []
        }],
        tags: []
      }));
    }
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readPackageMacroSnapshot({ path: '/ws' } as never);

    expect(snapshot.activePackages.map(({ file }) => file)).toEqual(['core-extra', 'core']);
    expect(snapshot.macroOrigins['Shared.name']).toBe('core');
    expect(snapshot.workspaceMacros['Shared.name'].description).toBe('core');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.workspaceMacros)).toBe(true);
  });

  it('uses the same one-read snapshot contract for legacy package files', async () => {
    jsonByPath.clear();
    const legacyIds = Array.from({ length: PACKAGE_COUNT }, (_, index) => `legacy-${String(index).padStart(2, '0')}`);
    jsonByPath.set('config.json', {
      version: '0.0.5',
      macro_kinds: [],
      active_macro_packages: legacyIds
    });
    for (const id of legacyIds) {
      jsonByPath.set(`term_macros/${id}.json`, {
        version: '9',
        name: id.toUpperCase(),
        macros: {
          [`macro.${id}`]: {
            description: '',
            source: { entries: [], urls: [] },
            dynamic_arity: false,
            styles: [{ style_name: 'default', mode: 'formula_inline', template: id, tags: [] }],
            tags: []
          }
        }
      });
    }
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readPackagePanelSnapshot({ path: '/ws' } as never, legacyIds[0]);

    expect(snapshot.selected.status).toBe('ok');
    expect(Object.keys(snapshot.workspaceMacros)).toHaveLength(PACKAGE_COUNT);
    expect(state.directoryReads).toEqual(['term_macros']);
    expect(state.entityReads.filter((path) => path.startsWith('term_macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('keeps a missing selected package as noFile while deriving the effective active set', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readPackagePanelSnapshot({ path: '/ws' } as never, 'missing');

    expect(snapshot.selected).toEqual({ status: 'noFile' });
    expect(snapshot.active).toEqual(packageIds);
  });

  it('fails closed when an active Macro entity is corrupt', async () => {
    const corruptPath = [...jsonByPath.keys()].find((path) => path.startsWith('macros/'))!;
    jsonByPath.set(corruptPath, { format: 'snl-macro', version: 1, package: packageIds[0], macro: null });
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    await expect(
      actual.readPackagePanelSnapshot({ path: '/ws' } as never, packageIds[0])
    ).rejects.toThrow('is not a valid SNL Macro envelope');
  });

  it('fails closed when a configured active package has no manifest', async () => {
    jsonByPath.set('config.json', {
      version: '0.0.11',
      entry_kinds: [],      macro_kinds: [],
      active_macro_packages: [...packageIds, 'missing-active']
    });
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    await expect(
      actual.readPackagePanelSnapshot({ path: '/ws' } as never, packageIds[0])
    ).rejects.toThrow('Active Macro Package "missing-active" has no Package manifest.');
  });

  it('fails closed when a Macro owner has no manifest', async () => {
    const name = 'macro.orphan';
    jsonByPath.set(`macros/${macroEntityPath('orphan', name).slice('macros/'.length)}`, makeMacroEnvelope('orphan', {
      name,
      description: '',
      source: { entries: [], urls: [] },
      kind: 'const',
      dynamic_arity: false,
      styles: [{
        style_name: 'default',
        template: { mode: 'formula_inline', body: name },
        tags: []
      }],
      tags: []
    }));
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    await expect(
      actual.readPackagePanelSnapshot({ path: '/ws' } as never, packageIds[0])
    ).rejects.toThrow('Macro entity references missing Package orphan.');
  });
});
