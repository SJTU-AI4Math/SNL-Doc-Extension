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
let failConfigWrite = false;

function uri(path: string): MemUri {
  return {
    path,
    fsPath: path,
    scheme: 'mem',
    toString: () => `mem:${path}`
  };
}

vi.mock('vscode', () => ({
  env: { language: 'en' },
  FileType: { File: 1, Directory: 2 },
  Uri: {
    joinPath: (base: MemUri, ...parts: string[]) =>
      uri([base.path.replace(/\/$/u, ''), ...parts].join('/'))
  },
  workspace: {
    fs: {
      stat: vi.fn(async (target: MemUri) => {
        if (files.has(target.fsPath)) return { type: 1 };
        if (
          target.fsPath === '/ws/.SNL_Doc' ||
          target.fsPath === '/ws/.SNL_Doc/term_macros'
        ) return { type: 2 };
        throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
      }),
      readFile: vi.fn(async (target: MemUri) => {
        const value = files.get(target.fsPath);
        if (!value) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        return value;
      }),
      writeFile: vi.fn(async (target: MemUri, value: Uint8Array) => {
        if (failConfigWrite && target.fsPath.endsWith('/config.json')) {
          throw new Error('config write denied');
        }
        files.set(target.fsPath, new Uint8Array(value));
      }),
      delete: vi.fn(async (target: MemUri) => { files.delete(target.fsPath); }),
      createDirectory: vi.fn(async () => undefined),
      readDirectory: vi.fn(async (target: MemUri) =>
        target.fsPath.endsWith('/term_macros') ? [['core.json', 1]] : [])
    },
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) }))
  }
}));

import { createMacroPackage } from './snlDoc';

const root = uri('/ws') as never;
const configPath = '/ws/.SNL_Doc/config.json';
const packagePath = '/ws/.SNL_Doc/term_macros/algebra.json';

beforeEach(() => {
  files.clear();
  files.set(configPath, enc.encode(JSON.stringify({
    version: '0.0.5',
    active_macro_packages: ['core']
  })));
  files.set('/ws/.SNL_Doc/term_macros/core.json', enc.encode(JSON.stringify({
    version: 8,
    name: 'Core',
    macros: {}
  })));
  failConfigWrite = false;
});

describe('legacy Macro Package creation transaction', () => {
  it('creates the package and activates it in the same transaction', async () => {
    expect(await createMacroPackage(root, 'algebra', 'Algebra')).toEqual({
      status: 'ok',
      file: 'algebra.json'
    });
    expect(files.has(packagePath)).toBe(true);
    const config = JSON.parse(dec.decode(files.get(configPath)!));
    expect(config.active_macro_packages).toEqual(['algebra', 'core']);
  });

  it('rolls back the package file when activation cannot be persisted', async () => {
    failConfigWrite = true;
    const result = await createMacroPackage(root, 'algebra', 'Algebra');
    expect(result).toMatchObject({ status: 'error' });
    expect(files.has(packagePath)).toBe(false);
  });
});
