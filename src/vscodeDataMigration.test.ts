import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  // /ws is only a stable fixture/counter label. URI path and fsPath both use
  // the real per-test root, shared by instrumented Authoring I/O and Node cache.
  tempRoot: '',
  physicalPath: (path: string): string =>
    path === '/ws' || path.startsWith('/ws/') ? mocks.tempRoot + path.slice(3) : path,
  fixturePath: (path: string): string =>
    path === mocks.tempRoot || path.startsWith(`${mocks.tempRoot}/`)
      ? '/ws' + path.slice(mocks.tempRoot.length) : path,
  // Bookkeeping only: reads below always consult disk, never this map.
  files: new Map<string, Uint8Array>(),
  readFiles: new Map<string, number>(),
  readDirectories: new Map<string, number>(),
  rename: vi.fn(),
  writeGate: null as Promise<void> | null
}));

vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const { posix } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  class Uri {
    readonly path: string;
    constructor(path: string, public readonly scheme = 'file') {
      this.path = mocks.physicalPath(path);
    }
    get fsPath(): string { return this.path; }
    toString(): string {
      return this.scheme === 'file'
        ? pathToFileURL(this.path).toString()
        : `${this.scheme}://${encodeURI(this.path)}`;
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(posix.join(base.path, ...parts), base.scheme);
    }
    static file(path: string): Uri { return new Uri(path, 'file'); }
    static from(value: { path: string; scheme: string }): Uri {
      return new Uri(value.path, value.scheme);
    }
    with(change: { path?: string }): Uri { return new Uri(change.path ?? this.path, this.scheme); }
  }
  return {
    Uri,
    FileType: { File: 1, Directory: 2 },
    workspace: {
      fs: {
        stat: async (uri: Uri) => {
          const stat = await fs.stat(uri.fsPath);
          return { type: stat.isDirectory() ? 2 : 1, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size };
        },
        readFile: async (uri: Uri) => {
          const path = mocks.fixturePath(uri.path);
          mocks.readFiles.set(path, (mocks.readFiles.get(path) ?? 0) + 1);
          return fs.readFile(uri.fsPath);
        },
        readDirectory: async (uri: Uri) => {
          const path = mocks.fixturePath(uri.path);
          mocks.readDirectories.set(path, (mocks.readDirectories.get(path) ?? 0) + 1);
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]);
        },
        writeFile: async (uri: Uri, bytes: Uint8Array) => {
          if (mocks.writeGate) await mocks.writeGate;
          await fs.writeFile(uri.fsPath, bytes);
          mocks.files.set(mocks.fixturePath(uri.path), bytes);
        },
        createDirectory: async (uri: Uri) => { await fs.mkdir(uri.fsPath, { recursive: true }); },
        rename: async (from: Uri, to: Uri) => {
          const fromPath = mocks.fixturePath(from.path);
          const toPath = mocks.fixturePath(to.path);
          mocks.rename(fromPath, toPath);
          await fs.rename(from.fsPath, to.fsPath);
          const bytes = mocks.files.get(fromPath);
          if (bytes) mocks.files.set(toPath, bytes);
          mocks.files.delete(fromPath);
        },
        delete: async (uri: Uri) => {
          await fs.unlink(uri.fsPath);
          mocks.files.delete(mocks.fixturePath(uri.path));
        }
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
const makeDirectory = (path: string): void => {
  mkdirSync(mocks.physicalPath(path), { recursive: true });
};
const put = (path: string, value: unknown): void => {
  const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(mocks.physicalPath(path), bytes);
  mocks.files.set(path, bytes);
};
const get = (path: string): unknown => JSON.parse(readFileSync(mocks.physicalPath(path), 'utf8'));

describe('VS Code workspace data migration adapter', () => {
  beforeEach(() => {
    mocks.files.clear();
    mocks.tempRoot = mkdtempSync(join(tmpdir(), 'snl-migration-test-'));
    mocks.readFiles.clear();
    mocks.readDirectories.clear();
    mocks.rename.mockClear();
    mocks.writeGate = null;
    makeDirectory('/ws/.SNL_Doc');
    makeDirectory('/ws/.SNL_Doc/term_macros');
  });

  afterEach(() => {
    rmSync(mocks.tempRoot, { recursive: true, force: true });
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
      entry_kinds: [{ id: 'theorem', name: 'Theorem', numbering: '.1' }],
      macro_kinds: []
    });
    put('/ws/.SNL_Doc/term_macros/Logic.json', {
      version: '6', name: 'Logic', macros: { x: { styles: [] } }
    });
    put('/ws/.SNL_Doc/entries.json', [
      { id: 'Set.mem', kind: 'theorem', title: 'Membership', content: { snl: '' } }
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
          ...(version === '10' || version === '11' ? { kind: 'const' } : {}),
          styles: [version === '11'
            ? {
                style_name: 'default',
                template: { mode: 'formula_inline', body: 'x' },
                tags: []
              }
            : { style_name: 'default', mode: 'formula_inline', template: 'x', tags: [] }]
        }
      }
    }));
    expect(report.to).toBe('0.1.0');
    expect(get('/ws/.SNL_Doc/config.json')).toMatchObject({ version: '0.1.0' });
    expect(get('/ws/.SNL_Doc/term_macros/Logic.json')).toMatchObject({ version: '8' });
  });

  it('reads each current entity directory and file once for a Dashboard refresh', async () => {
    for (const directory of ['packages', 'entries', 'macros', 'libraries']) {
      makeDirectory(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.11',
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
      [packageManifestPath('Logic'), makePackageManifest('Logic', 'Logic', '', ['entry.one'])],
      [entryEntityPath('Logic', 'entry.one'),
        makeEntryEnvelope('Logic', {
          id: 'entry.one', package: 'Logic', kind: 'definition', title: 'One', content: { snl: '' }, pointer: null
        })],
      [macroEntityPath('Logic', 'logic.one'),
        makeMacroEnvelope('Logic', {
          name: 'logic.one', description: '', source: { entries: [], urls: [] },
          kind: 'const', dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default',
            template: { mode: 'formula_inline', body: 'x' },
            tags: []
          }]
        })]
    ]);
    for (const [path, value] of entities) put(`/ws/.SNL_Doc/${path}`, value);

    const result = await readDashboardWorkspaceData(vscode.Uri.file('/ws'));

    expect(result.inspection.status).toBe('needsMigration');
    expect(result.overview.entries.map((entry) => entry.id)).toEqual(['entry.one']);
    for (const directory of ['packages', 'entries', 'macros']) {
      expect(mocks.readDirectories.get(`/ws/.SNL_Doc/${directory}`)).toBe(1);
    }
    for (const path of entities.keys()) {
      expect(mocks.readFiles.get(`/ws/.SNL_Doc/${path}`)).toBe(1);
    }
  });

  it('rejects target-invalid flat Kind coloring on a 0.0.11 Dashboard read', async () => {
    for (const directory of ['packages', 'entries', 'macros', 'libraries']) {
      makeDirectory(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.11',
      entry_kinds: [{
        id: 'definition', name: 'Definition', defaultCounterName: '', style: '',
        coloring: { stroke: '#111111', background: '#ffffff' }
      }],
      macro_kinds: [],
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

    await expect(readDashboardWorkspaceData(vscode.Uri.file('/ws')))
      .rejects.toThrow(/coloring.*light|coloring.*dark|themed/i);
  });

  it('rejects a Dashboard overview when 0.0.11 Package membership omits a live Entry', async () => {
    for (const directory of ['packages', 'entries', 'macros', 'libraries']) {
      makeDirectory(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.11', entry_kinds: [], macro_kinds: [], active_macro_packages: ['Logic'],
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
    put(
      `/ws/.SNL_Doc/${packageManifestPath('Logic')}`,
      makePackageManifest('Logic', 'Logic', '', [])
    );
    put(
      `/ws/.SNL_Doc/${entryEntityPath('Logic', 'hidden')}`,
      makeEntryEnvelope('Logic', {
        id: 'hidden', package: 'Logic', kind: 'definition', title: 'Hidden', content: { snl: '' }, pointer: null
      })
    );

    await expect(readDashboardWorkspaceData(vscode.Uri.file('/ws')))
      .rejects.toThrow(/entry_ids.*diverges|membership/i);
  });

  it('keeps Dashboard migration inspection fail-closed for a partial entity topology', async () => {
    for (const directory of ['packages', 'macros', 'libraries']) {
      makeDirectory(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.11', entry_kinds: [], macro_kinds: [],
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

    await expect(readDashboardWorkspaceData(vscode.Uri.file('/ws')))
      .rejects.toThrow(/missing.*entries/i);
  });

  it('rejects a Dashboard refresh when a shared entity snapshot is malformed', async () => {
    for (const directory of ['packages', 'entries', 'macros', 'libraries']) {
      makeDirectory(`/ws/.SNL_Doc/${directory}`);
    }
    put('/ws/.SNL_Doc/config.json', {
      version: '0.0.11', entry_kinds: [], macro_kinds: [],
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
