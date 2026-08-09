import { describe, expect, it, vi } from 'vitest';
import { promises as nodeFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;

vi.mock('vscode', () => ({
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    joinPath: (base: TestUri, ...parts: string[]): TestUri => {
      const path = [base.path.replace(/\/$/, ''), ...parts].join('/');
      return {
        path,
        fsPath: path,
        scheme: base.scheme,
        toString: () => `${base.scheme}:${path}`
      };
    }
  }
}));

interface TestUri {
  path: string;
  fsPath: string;
  scheme: string;
  toString(): string;
}

function uri(path: string, scheme = 'mem'): TestUri {
  return { path, fsPath: path, scheme, toString: () => `${scheme}:${path}` };
}

import { cacheWorkspaceAsset } from './workspaceAssets';

function fixture(symlinks: string[] = []) {
  const files = new Map<string, Uint8Array>([
    ['/ws/.SNL_Doc/assets/figures/proof.png', new Uint8Array([1, 2, 3])]
  ]);
  const writes = new Map<string, Uint8Array>();
  const symlinkSet = new Set(symlinks);
  const fsApi = {
    stat: vi.fn(async (target: TestUri) => {
      if (symlinkSet.has(target.path)) {
        const targetKind = files.has(target.path) ? FILE : DIRECTORY;
        return { type: targetKind | SYMLINK, size: files.get(target.path)?.length ?? 0 };
      }
      if (files.has(target.path)) return { type: FILE, size: files.get(target.path)!.length };
      if (target.path === '/ws/.SNL_Doc/assets' ||
          target.path === '/ws/.SNL_Doc/assets/figures' ||
          target.path === '/cache' || target.path === '/cache/assets') {
        return { type: DIRECTORY, size: 0 };
      }
      throw new Error(`ENOENT ${target.path}`);
    }),
    readFile: vi.fn(async (target: TestUri) => files.get(target.path) ?? (() => { throw new Error('ENOENT'); })()),
    createDirectory: vi.fn(async () => undefined),
    writeFile: vi.fn(async (target: TestUri, bytes: Uint8Array) => { writes.set(target.path, bytes); })
  };
  return { fsApi, writes };
}

const followingNodeFs = {
  stat: async (target: TestUri) => {
    const stat = await nodeFs.stat(target.fsPath);
    return {
      type: stat.isFile() ? FILE : DIRECTORY,
      size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs
    };
  },
  readFile: async (target: TestUri) => nodeFs.readFile(target.fsPath),
  createDirectory: async (target: TestUri) => {
    await nodeFs.mkdir(target.fsPath, { recursive: true });
  },
  writeFile: async (target: TestUri, bytes: Uint8Array) => {
    await nodeFs.writeFile(target.fsPath, bytes);
  }
};

describe('cacheWorkspaceAsset', () => {
  it('rejects a local assets-root symlink even when the filesystem provider follows it', async () => {
    const temp = await nodeFs.mkdtemp(join(tmpdir(), 'snl-asset-root-link-'));
    try {
      const workspace = join(temp, 'workspace');
      const outside = join(temp, 'outside');
      const cache = join(temp, 'cache');
      await nodeFs.mkdir(join(workspace, '.SNL_Doc'), { recursive: true });
      await nodeFs.mkdir(outside, { recursive: true });
      await nodeFs.writeFile(join(outside, 'secret.png'), new Uint8Array([9]));
      await nodeFs.symlink(outside, join(workspace, '.SNL_Doc', 'assets'), 'dir');
      const followingFs = {
        stat: async (target: TestUri) => {
          const stat = await nodeFs.stat(target.fsPath);
          return {
            type: stat.isFile() ? FILE : DIRECTORY,
            size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs
          };
        },
        readFile: async (target: TestUri) => nodeFs.readFile(target.fsPath),
        createDirectory: async (target: TestUri) => {
          await nodeFs.mkdir(target.fsPath, { recursive: true });
        },
        writeFile: async (target: TestUri, bytes: Uint8Array) => {
          await nodeFs.writeFile(target.fsPath, bytes);
        }
      };

      await expect(cacheWorkspaceAsset({
        workspaceRoot: uri(workspace, 'file') as never,
        cacheRoot: uri(cache, 'file') as never,
        relativePath: 'secret.png',
        fsApi: followingFs as never,
        asWebviewUri: () => 'must-not-resolve'
      })).rejects.toThrow(/symbolic link/i);
      await expect(nodeFs.stat(join(cache, 'assets'))).rejects.toThrow();
    } finally {
      await nodeFs.rm(temp, { recursive: true, force: true });
    }
  });

  it('rejects an intermediate-directory swap between validation and handle binding', async () => {
    const temp = await nodeFs.mkdtemp(join(tmpdir(), 'snl-asset-swap-'));
    const workspace = join(temp, 'workspace');
    const cache = join(temp, 'cache');
    const figures = join(workspace, '.SNL_Doc', 'assets', 'figures');
    const target = join(figures, 'proof.png');
    const outside = join(temp, 'outside');
    await nodeFs.mkdir(figures, { recursive: true });
    await nodeFs.mkdir(outside, { recursive: true });
    await nodeFs.writeFile(target, new Uint8Array([1, 2, 3]));
    await nodeFs.writeFile(join(outside, 'proof.png'), new Uint8Array([9, 9, 9]));
    const realpath = nodeFs.realpath.bind(nodeFs);
    let swapped = false;
    const spy = vi.spyOn(nodeFs, 'realpath').mockImplementation(async (path) => {
      const result = await realpath(path);
      if (!swapped && path === target) {
        await nodeFs.rename(figures, `${figures}.safe`);
        await nodeFs.symlink(outside, figures, 'dir');
        swapped = true;
      }
      return result;
    });
    try {
      await expect(cacheWorkspaceAsset({
        workspaceRoot: uri(workspace, 'file') as never,
        cacheRoot: uri(cache, 'file') as never,
        relativePath: 'figures/proof.png',
        fsApi: followingNodeFs as never,
        asWebviewUri: () => 'must-not-resolve'
      })).rejects.toThrow(/symbolic link|changed while/i);
      await expect(nodeFs.stat(join(cache, 'assets'))).rejects.toThrow();
    } finally {
      spy.mockRestore();
      await nodeFs.rm(temp, { recursive: true, force: true });
    }
  });

  it('copies a validated nested asset into a trusted cache and returns its webview URI', async () => {
    const temp = await nodeFs.mkdtemp(join(tmpdir(), 'snl-asset-copy-'));
    try {
      const workspace = join(temp, 'workspace');
      const cache = join(temp, 'cache');
      await nodeFs.mkdir(join(workspace, '.SNL_Doc', 'assets', 'figures'), { recursive: true });
      await nodeFs.writeFile(
        join(workspace, '.SNL_Doc', 'assets', 'figures', 'proof.png'),
        new Uint8Array([1, 2, 3])
      );
      const followingFs = {
        stat: async (target: TestUri) => {
          const stat = await nodeFs.stat(target.fsPath);
          return {
            type: stat.isFile() ? FILE : DIRECTORY,
            size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs
          };
        },
        readFile: async (target: TestUri) => nodeFs.readFile(target.fsPath),
        createDirectory: async (target: TestUri) => {
          await nodeFs.mkdir(target.fsPath, { recursive: true });
        },
        writeFile: async (target: TestUri, bytes: Uint8Array) => {
          await nodeFs.writeFile(target.fsPath, bytes);
        }
      };
      const result = await cacheWorkspaceAsset({
        workspaceRoot: uri(workspace, 'file') as never,
        cacheRoot: uri(cache, 'file') as never,
        relativePath: 'figures/proof.png',
        fsApi: followingFs as never,
        asWebviewUri: (target) => `vscode-webview://trusted${(target as unknown as TestUri).path}`
      });

      expect(result).toMatch(/vscode-webview:\/\/trusted.*\/cache\/assets\/[a-f0-9]{64}\.png$/);
      const cachedPath = result.replace('vscode-webview://trusted', '');
      expect(await nodeFs.readFile(cachedPath)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await nodeFs.rm(temp, { recursive: true, force: true });
    }
  });

  it.each([
    '/ws/.SNL_Doc/assets',
    '/ws/.SNL_Doc/assets/figures',
    '/ws/.SNL_Doc/assets/figures/proof.png'
  ])('rejects symbolic-link boundary %s before reading bytes', async (link) => {
    const { fsApi } = fixture([link]);
    await expect(cacheWorkspaceAsset({
      workspaceRoot: uri('/ws') as never,
      cacheRoot: uri('/cache') as never,
      relativePath: 'figures/proof.png',
      fsApi: fsApi as never,
      asWebviewUri: () => 'unused'
    })).rejects.toThrow(/symbolic link/i);
    expect(fsApi.readFile).not.toHaveBeenCalled();
  });

  it.each(['../secret.png', '/tmp/secret.png', 'file:secret.png', 'figures\\secret.png']) (
    'rejects unsafe author paths: %s',
    async (relativePath) => {
      const { fsApi } = fixture();
      await expect(cacheWorkspaceAsset({
        workspaceRoot: uri('/ws') as never,
        cacheRoot: uri('/cache') as never,
        relativePath,
        fsApi: fsApi as never,
        asWebviewUri: () => 'unused'
      })).rejects.toThrow(/safe path/i);
      expect(fsApi.readFile).not.toHaveBeenCalled();
    }
  );
});
