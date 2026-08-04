import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
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
        readFile: async (uri: Uri) => mocks.files.get(uri.path) ?? missing(),
        readDirectory: async (uri: Uri) => {
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
  inspectWorkspaceDataVersion,
  migrateWorkspaceData
} from './vscodeDataMigration';

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
    const root = vscode.Uri.file('/ws');
    expect((await inspectWorkspaceDataVersion(root)).status).toBe('needsMigration');
    const report = await migrateWorkspaceData(root, (_file, raw) => ({
      ...(raw as Record<string, unknown>), version: '7'
    }));
    expect(report.to).toBe('0.0.4');
    expect(get('/ws/.SNL_Doc/config.json')).toMatchObject({ version: '0.0.4' });
    expect(get('/ws/.SNL_Doc/term_macros/Logic.json')).toMatchObject({ version: '7' });
  });
});
