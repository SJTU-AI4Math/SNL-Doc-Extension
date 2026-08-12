import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entryEntityPath, packageManifestPath } from './entityStorage';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MemUri = {
  scheme: string;
  path: string;
  fsPath: string;
  toString(skipEncoding?: boolean): string;
};

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  directories: new Set<string>(),
  onWrite: undefined as undefined | ((path: string) => void),
  onRename: undefined as undefined | ((from: string, to: string) => void),
  renames: [] as Array<[string, string]>,
  deletes: [] as string[]
}));

const normalize = (path: string): string => path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
const uri = (path: string): MemUri => ({
  scheme: 'mem',
  path: normalize(path),
  fsPath: normalize(path),
  toString: () => `mem:${normalize(path)}`
});
const parent = (path: string): string => normalize(path.slice(0, path.lastIndexOf('/')) || '/');
const addDirectory = (path: string): void => {
  let current = normalize(path);
  while (!state.directories.has(current)) {
    state.directories.add(current);
    if (current === '/') break;
    current = parent(current);
  }
};
const putJson = (path: string, value: unknown): void => {
  addDirectory(parent(path));
  state.files.set(normalize(path), encoder.encode(`${JSON.stringify(value, null, 2)}\n`));
};
const getJson = (path: string): unknown => JSON.parse(decoder.decode(state.files.get(normalize(path))));
const missing = (): Error & { code: string } => Object.assign(new Error('missing'), { code: 'FileNotFound' });

vi.mock('vscode', () => ({
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    joinPath: (base: MemUri, ...parts: string[]) => uri(`${base.path}/${parts.join('/')}`)
  },
  workspace: {
    fs: {
      stat: async (target: MemUri) => {
        const path = normalize(target.path);
        if (state.files.has(path)) return { type: 1, size: state.files.get(path)!.byteLength };
        if (state.directories.has(path)) return { type: 2, size: 0 };
        throw missing();
      },
      readFile: async (target: MemUri) => {
        const bytes = state.files.get(normalize(target.path));
        if (!bytes) throw missing();
        return bytes.slice();
      },
      readDirectory: async (target: MemUri) => {
        const directory = normalize(target.path);
        if (!state.directories.has(directory)) throw missing();
        const prefix = directory === '/' ? '/' : `${directory}/`;
        const children = new Map<string, number>();
        for (const path of state.directories) {
          if (!path.startsWith(prefix) || path === directory) continue;
          const rest = path.slice(prefix.length);
          if (rest && !rest.includes('/')) children.set(rest, 2);
        }
        for (const path of state.files.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          if (rest && !rest.includes('/')) children.set(rest, 1);
        }
        return [...children].sort(([left], [right]) => left.localeCompare(right));
      },
      createDirectory: async (target: MemUri) => { addDirectory(target.path); },
      writeFile: async (target: MemUri, bytes: Uint8Array) => {
        const path = normalize(target.path);
        state.onWrite?.(path);
        addDirectory(parent(path));
        state.files.set(path, bytes.slice());
      },
      rename: async (from: MemUri, to: MemUri, options: { overwrite: boolean }) => {
        const source = normalize(from.path);
        const target = normalize(to.path);
        if (!state.files.has(source)) throw missing();
        if (!options.overwrite && state.files.has(target)) throw new Error('exists');
        state.files.set(target, state.files.get(source)!.slice());
        state.files.delete(source);
        state.renames.push([source, target]);
        state.onRename?.(source, target);
      },
      delete: async (target: MemUri) => {
        const path = normalize(target.path);
        state.deletes.push(path);
        if (!state.files.delete(path) && !state.directories.delete(path)) throw missing();
      }
    }
  },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
}));

const root = uri('/workspace') as never;
const snl = '/workspace/.SNL_Doc';
const configPath = `${snl}/config.json`;
const unpackagedPath = `${snl}/${packageManifestPath('_unpackaged')}`;
const concurrentEntryPath = `${snl}/${entryEntityPath('_unpackaged', 'hidden.entry')}`;
const unpackagedPredecessor = {
  format: 'snl-package', version: 1, id: '_unpackaged', name: 'Unpackaged',
  description: 'Entries without an assigned package.'
};
const validConcurrentEntry = {
  format: 'snl-entry', version: 1, schema_version: 1, package: '_unpackaged',
  entry: {
    id: 'hidden.entry', package: '_unpackaged', kind: 'definition', title: 'Hidden',
    content: { snl: '' }, pointer: null
  }
};

describe('fresh initialization membership publication', () => {
  beforeEach(() => {
    state.files.clear();
    state.directories.clear();
    state.renames.length = 0;
    state.deletes.length = 0;
    state.onWrite = undefined;
    state.onRename = undefined;
    addDirectory('/workspace');
  });

  it('rejects a valid Entry introduced before config publication and leaves config absent', async () => {
    state.onWrite = (path) => {
      if (path.includes('/.config.init-')) putJson(concurrentEntryPath, validConcurrentEntry);
    };
    const { initSnlDoc } = await import('./snlDoc');

    await expect(initSnlDoc(root)).rejects.toThrow(/Cannot initialize|topology|Entry/i);

    expect(getJson(concurrentEntryPath)).toEqual(validConcurrentEntry);
    expect(state.files.has(configPath)).toBe(false);
    expect(state.renames.some(([, to]) => to === configPath)).toBe(false);
  });

  it('rolls back only its config when a valid Entry is introduced during config rename', async () => {
    state.onRename = (_from, to) => {
      if (to === configPath) putJson(concurrentEntryPath, validConcurrentEntry);
    };
    const { initSnlDoc } = await import('./snlDoc');

    await expect(initSnlDoc(root)).rejects.toThrow(/Cannot initialize|topology|Entry/i);

    expect(getJson(concurrentEntryPath)).toEqual(validConcurrentEntry);
    expect(state.files.has(configPath)).toBe(false);
    expect(state.deletes).toContain(configPath);
  });

  it('upgrades exact markerless _unpackaged retry residue and publishes config 0.0.11', async () => {
    addDirectory(`${snl}/packages`);
    addDirectory(`${snl}/entries`);
    addDirectory(`${snl}/macros`);
    addDirectory(`${snl}/libraries`);
    putJson(unpackagedPath, unpackagedPredecessor);
    const { initSnlDoc } = await import('./snlDoc');

    await expect(initSnlDoc(root)).resolves.toEqual({ status: 'created' });

    expect(getJson(unpackagedPath)).toMatchObject({
      ...unpackagedPredecessor, schema_version: 2, entry_ids: []
    });
    expect(getJson(configPath)).toMatchObject({ version: '0.0.11' });
  });
});
