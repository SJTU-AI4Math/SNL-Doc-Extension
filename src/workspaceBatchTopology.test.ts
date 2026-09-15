import { beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './libraryPointRead.testSupport';
import { makePackageManifest, packageManifestPath } from './entityStorage';
import { makeEntityStorageReceipt } from './dataMigrations';

const state = vi.hoisted(() => ({
  afterWrite: null as null | ((path: string) => Promise<void>),
  denyConfig: false,
  writes: [] as string[]
}));
vi.mock('vscode', async () => {
  const disk = await import('node:fs/promises');
  const paths = await import('node:path');
  const uri = (path: string): any => ({ path, fsPath: path, scheme: 'batch-test', authority: '', toString: () => `batch-test:${path}` });
  return {
    env: { language: 'en' }, FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, joinPath: (base: any, ...parts: string[]) => uri(paths.join(base.path, ...parts)) },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      fs: {
        stat: async (u: any) => { const s = await disk.lstat(u.path); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1 }; },
        readFile: (u: any) => disk.readFile(u.path),
        readDirectory: async (u: any) => (await disk.readdir(u.path, { withFileTypes: true })).map(d => [d.name, d.isSymbolicLink() ? 64 : d.isDirectory() ? 2 : 1]),
        createDirectory: (u: any) => disk.mkdir(u.path, { recursive: true }),
        delete: (u: any) => disk.unlink(u.path),
        writeFile: async (u: any, bytes: Uint8Array) => {
          state.writes.push(u.path);
          if (state.denyConfig && u.path.endsWith('/config.json')) throw new Error('config publication denied');
          await disk.writeFile(u.path, bytes);
          await state.afterWrite?.(u.path);
        }
      }
    }
  };
});
import * as vscode from 'vscode';
import { createMacroPackage } from './snlDoc';

let f: Awaited<ReturnType<typeof fixture>>;
let root: vscode.Uri;
let configPath: string;
let createdPath: string;
beforeEach(async () => {
  state.afterWrite = null; state.denyConfig = false; state.writes = [];
  f = await fixture();
  // Unlike metadata-only point-read fixtures, the generic writer checks the
  // complete migration receipt against the actual (absent) legacy backup.
  f.config.entity_storage.receipt = makeEntityStorageReceipt(null, new Map(), false);
  await f.pkg('alpha');
  await f.pkg('_unpackaged');
  await f.put('config.json', { ...f.config, entry_kinds: [], macro_kinds: [] });
  await fs.mkdir(join(f.root, '.SNL_Doc'));
  for (const name of ['config.json', 'packages']) await fs.rename(join(f.root, name), join(f.root, '.SNL_Doc', name));
  for (const name of ['entries', 'macros']) await fs.mkdir(join(f.root, '.SNL_Doc', name));
  root = vscode.Uri.file(f.root);
  configPath = join(f.root, '.SNL_Doc/config.json');
  createdPath = join(f.root, '.SNL_Doc', packageManifestPath('algebra'));
});

it('creates and activates a current-schema Package as one successful public batch', async () => {
  expect(await createMacroPackage(root, 'algebra', 'Algebra', 'A package')).toEqual({ status: 'ok', file: 'algebra.json' });
  expect(JSON.parse(await fs.readFile(createdPath, 'utf8'))).toEqual(makePackageManifest('algebra', 'Algebra', 'A package'));
  expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({ ...f.config, entry_kinds: [], macro_kinds: [], active_macro_packages: ['algebra', 'alpha'] });
  expect(state.writes).toEqual([createdPath, configPath]);
});

it('preserves exact original activation and removes its own new manifest when config publication fails', async () => {
  const before = await fs.readFile(configPath);
  state.denyConfig = true;
  const result = await createMacroPackage(root, 'algebra', 'Algebra');
  expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('config publication denied') });
  await expect(fs.stat(createdPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(configPath)).toEqual(before);
});

it.each(['separate manifest', 'replacement manifest'] as const)(
  'rejects a last-write topology change and preserves foreign bytes: %s', async mode => {
    const before = await fs.readFile(configPath);
    const foreignId = mode === 'separate manifest' ? 'foreign' : 'algebra';
    const foreignPath = join(f.root, '.SNL_Doc', packageManifestPath(foreignId));
    const foreignBytes = Buffer.from(JSON.stringify(makePackageManifest(foreignId, 'Foreign', '', ['Missing'])));
    let injected = false;
    state.afterWrite = async path => {
      if (path !== configPath || injected) return;
      injected = true;
      await fs.writeFile(foreignPath, foreignBytes);
    };
    const result = await createMacroPackage(root, 'algebra', 'Algebra');
    expect(injected).toBe(true);
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/Workspace data is not writable/i) });
    expect(await fs.readFile(foreignPath)).toEqual(foreignBytes);
    expect(await fs.readFile(configPath)).toEqual(before);
    if (mode === 'separate manifest') {
      await expect(fs.stat(createdPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(result).toMatchObject({ message: expect.stringContaining('transaction rollback was incomplete') });
    }
  }
);
