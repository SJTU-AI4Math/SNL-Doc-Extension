import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
  readFiles: new Map<string, number>(),
  readDirectories: new Map<string, number>(),
  rename: vi.fn(),
  writeGate: null as Promise<void> | null
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(public readonly path: string, public readonly scheme = 'file') {}
    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri([base.path.replace(/\/$/, ''), ...parts].join('/'), base.scheme);
    }
    static file(path: string): Uri { return new Uri(path, 'file'); }
    static from(value: { path: string; scheme: string }): Uri {
      return new Uri(value.path, value.scheme);
    }
    with(change: { path?: string }): Uri { return new Uri(change.path ?? this.path, this.scheme); }
  }
  const missing = (): never => { throw new Error('ENOENT'); };
  return {
    Uri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      fs: {
        stat: async (uri: Uri) => {
          if (mocks.files.has(uri.path)) return { type: 1 };
          if (mocks.directories.has(uri.path)) return { type: 2 };
          return missing();
        },
        readFile: async (uri: Uri) => {
          mocks.readFiles.set(uri.path, (mocks.readFiles.get(uri.path) ?? 0) + 1);
          return mocks.files.get(uri.path) ?? missing();
        },
        readDirectory: async (uri: Uri) => {
          mocks.readDirectories.set(
            uri.path,
            (mocks.readDirectories.get(uri.path) ?? 0) + 1
          );
          if (!mocks.directories.has(uri.path)) return missing();
          const prefix = `${uri.path}/`;
          return [...mocks.files.keys()]
            .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
            .map((path) => [path.slice(prefix.length), 1]);
        },
        writeFile: async (uri: Uri, bytes: Uint8Array) => {
          if (mocks.writeGate) await mocks.writeGate;
          mocks.files.set(uri.path, bytes);
        },
        createDirectory: async (uri: Uri) => { mocks.directories.add(uri.path); },
        rename: async (from: Uri, to: Uri) => {
          mocks.rename(from.path, to.path);
          const bytes = mocks.files.get(from.path) ?? missing();
          mocks.files.set(to.path, bytes);
          mocks.files.delete(from.path);
        },
        delete: async (uri: Uri) => { mocks.files.delete(uri.path); }
      }
    }
  };
});

vi.mock('./workspaceDataLock', () => ({
  withWorkspaceDataLock: async (
    _root: unknown,
    _purpose: string,
    task: () => Promise<unknown>
  ) => task()
}));

import * as vscode from 'vscode';
import {
  createVscodeDataMigrationStorage,
  readDashboardWorkspaceData,
  inspectWorkspaceDataVersion,
  migrateWorkspaceData
} from './vscodeDataMigration';
import { makeEntityStorageReceipt } from './dataMigrations';
import {
  entryEntityPath,
  macroEntityPath,
  makeEntryEnvelope,
  makeMacroEnvelope,
  makePackageManifest,
  packageManifestPath,
  UNPACKAGED_PACKAGE_ID
} from './entityStorage';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const put = (path: string, value: unknown): void => {
  mocks.files.set(path, encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
};
const get = (path: string): unknown => JSON.parse(decoder.decode(mocks.files.get(path)!));

describe('VS Code workspace data migration adapter', () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.directories.clear();
    mocks.readFiles.clear();
    mocks.readDirectories.clear();
    mocks.rename.mockClear();
    mocks.writeGate = null;
    mocks.directories.add('/ws/.SNL_Doc');
    mocks.directories.add('/ws/.SNL_Doc/term_macros');
  });

  it('reads relative JSON files and atomically renames writes', async () => {
    put('/ws/.SNL_Doc/config.json', { version: '0.0.3' });
    const root = vscode.Uri.file('/ws');
    const storage = createVscodeDataMigrationStorage(root);
    expect(await storage.readJson('config.json')).toEqual({ version: '0.0.3' });
    await storage.writeJsonAtomic('config.json', { version: '0.0.4' });
    expect(get('/ws/.SNL_Doc/config.json')).toEqual({ version: '0.0.4' });
    expect(mocks.rename).toHaveBeenCalledOnce();
    expect([...mocks.files.keys()].some((path) => path.includes('.snl-migration-tmp-'))).toBe(false);
  });

  it('refuses migrations on virtual providers without atomic replacement guarantees', async () => {
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.3', entry_kinds: [], macro_kinds: []
    });
    const root = vscode.Uri.from({ scheme: 'memfs', path: '/ws' });
    await expect(migrateWorkspaceData(root, (_file, raw) => raw))
      .rejects.toThrow(/atomic replacement/);
    expect(get('/ws/.SNL_Doc/config.json')).toMatchObject({ version: '0.0.3' });
  });

  it('rejects concurrent migrations for the same workspace', async () => {
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.3', entry_kinds: [], macro_kinds: []
    });
    const root = vscode.Uri.file('/ws');
    let release!: () => void;
    mocks.writeGate = new Promise<void>((resolve) => { release = resolve; });
    const first = migrateWorkspaceData(root, (_file: string, raw: unknown) => raw);
    const second = migrateWorkspaceData(root, (_file: string, raw: unknown) => raw);
    const outcome = await Promise.race([
      second.then(() => 'resolved', (error: unknown) =>
        error instanceof Error ? error.message : String(error)
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20))
    ]);
    release();
    mocks.writeGate = null;
    await Promise.allSettled([first, second]);
    expect(outcome).toMatch(/already running/);
  });

  it('inspects and migrates the real workspace layout through the adapter', async () => {
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.3',
      entry_kinds: [{ id: 'theorem', numbering: '.1' }],
      macro_kinds: []
    });
    put('/ws/.SNL_Doc/term_macros/Logic.json', {
      version: '6', name: 'Logic', macros: { x: { styles: [] } }
    });
    put('/ws/.SNL_Doc/entries.json', [
      { id: 'Set.mem', kind: 'theorem', title: 'Membership' }
    ]);
    const root = vscode.Uri.file('/ws');
    expect((await inspectWorkspaceDataVersion(root)).status).toBe('needsMigration');
    const report = await migrateWorkspaceData(root, (_file, raw, version) => ({
      ...(raw as Record<string, unknown>),
      version,
      macros: {
        x: {
          description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
          ...(version === '8' ? { default_style: { en: 'default' } } : {}),
          styles: [{ style_name: 'default', mode: 'formula_inline', template: 'x', tags: [] }]
        }
      }
    }));
    expect(report.to).toBe('0.0.7');
    expect(get('/ws/.SNL_Doc/config.json')).toMatchObject({ version: '0.0.7' });
    expect(get('/ws/.SNL_Doc/term_macros/Logic.json')).toMatchObject({ version: '8' });
  });

  it('reads each current entity directory and file once for a Dashboard refresh', async () => {
    for (const directory of ['packages', 'entries', 'macros', 'libraries']) {
      mocks.directories.add(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.7',
      entry_kinds: [],
      macro_kinds: [],
      active_macro_packages: ['Logic'],
      entity_storage: {
        version: 1,
        legacy_backup_version: '0.0.5',
        entry_default_package: UNPACKAGED_PACKAGE_ID,
        receipt: makeEntityStorageReceipt(null, new Map(), false)
      }
    });
    const entities = new Map<string, unknown>([
      [packageManifestPath(UNPACKAGED_PACKAGE_ID),
        makePackageManifest(UNPACKAGED_PACKAGE_ID, 'Unpackaged', '')],
      [packageManifestPath('Logic'), makePackageManifest('Logic', 'Logic', '')],
      [entryEntityPath('Logic', 'entry.one'),
        makeEntryEnvelope('Logic', { id: 'entry.one', package: 'Logic', kind: 'theorem', title: 'One', content: {}, pointer: null })],
      [macroEntityPath('Logic', 'logic.one'),
        makeMacroEnvelope('Logic', {
          name: 'logic.one', description: '', source: { entries: [], urls: [] },
          dynamic_arity: false, kind: 'const', tags: [],
          styles: [{ style_name: 'default', mode: 'formula_inline', template: 'x', tags: [] }]
        })]
    ]);
    for (const [path, value] of entities) put(`/ws/.SNL_Doc/${path}`, value);

    const result = await readDashboardWorkspaceData(vscode.Uri.file('/ws'));

    expect(result.inspection.status).toBe('current');
    expect(result.overview.entries.map((entry) => entry.id)).toEqual(['entry.one']);
    for (const directory of ['packages', 'entries', 'macros']) {
      expect(mocks.readDirectories.get(`/ws/.SNL_Doc/${directory}`)).toBe(1);
    }
    for (const path of entities.keys()) {
      expect(mocks.readFiles.get(`/ws/.SNL_Doc/${path}`)).toBe(1);
    }
  });

  it('keeps Dashboard migration inspection fail-closed for a partial entity topology', async () => {
    for (const directory of ['packages', 'macros', 'libraries']) {
      mocks.directories.add(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.6', entry_kinds: [], macro_kinds: [],
      entity_storage: {
        version: 1, legacy_backup_version: '0.0.5',
        entry_default_package: UNPACKAGED_PACKAGE_ID,
        receipt: makeEntityStorageReceipt(null, new Map(), false)
      }
    });
    put(
      `/ws/.SNL_Doc/${packageManifestPath(UNPACKAGED_PACKAGE_ID)}`,
      makePackageManifest(UNPACKAGED_PACKAGE_ID, 'Unpackaged', '')
    );

    const result = await readDashboardWorkspaceData(vscode.Uri.file('/ws'));

    expect(result.inspection.status).toBe('invalid');
    expect(result.inspection.message).toMatch(/missing.*entries/i);
  });

  it('rejects a Dashboard refresh when a shared entity snapshot is malformed', async () => {
    for (const directory of ['packages', 'entries', 'macros', 'libraries']) {
      mocks.directories.add(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.7', entry_kinds: [], macro_kinds: [],
      entity_storage: {
        version: 1, legacy_backup_version: '0.0.5',
        entry_default_package: UNPACKAGED_PACKAGE_ID,
        receipt: makeEntityStorageReceipt(null, new Map(), false)
      }
    });
    put(
      `/ws/.SNL_Doc/${packageManifestPath(UNPACKAGED_PACKAGE_ID)}`,
      makePackageManifest(UNPACKAGED_PACKAGE_ID, 'Unpackaged', '')
    );
    const badEntryPath = entryEntityPath(UNPACKAGED_PACKAGE_ID, 'bad');
    put(`/ws/.SNL_Doc/${badEntryPath}`, { corrupt: true });

    await expect(readDashboardWorkspaceData(vscode.Uri.file('/ws')))
      .rejects.toThrow(/not a valid SNL Entry envelope/);
    expect(mocks.readFiles.get(`/ws/.SNL_Doc/${badEntryPath}`)).toBe(1);
  });
});
