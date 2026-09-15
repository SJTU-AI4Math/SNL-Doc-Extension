import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { entryEntityPath, packageManifestPath, makeEntryEnvelope, makePackageManifest } from './entityStorage';

// Only VS Code's filesystem provider is substituted. snlDoc, entityStorageIo,
// vscodeDataMigration and (for file:) the workspace lock are real imports.
// Both URI schemes use actual private disk bytes; mem: is a provider simulation,
// not an installed VS Code host or a claim about every remote implementation.
const state = vi.hoisted(() => ({
  root: '', failAt: '', failCode: '', failOperation: 'stat',
  writes: [] as string[], trace: [] as string[],
  lastError: undefined as Error | undefined,
  onReadDirectory: undefined as undefined | ((target: string) => Promise<void>),
  onRename: undefined as undefined | ((target: string) => Promise<void>),
  onDelete: undefined as undefined | ((target: string) => Promise<void>)
}));
vi.mock('vscode', async () => {
  const disk = await import('node:fs/promises');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  class Uri {
    constructor(public path: string, public scheme = 'file') {}
    get fsPath() { return this.path; }
    toString() { return this.scheme === 'file' ? pathToFileURL(this.path).toString() : `mem:${this.path}`; }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(path.join(base.path, ...parts), base.scheme); }
    static file(p: string) { return new Uri(p); }
    static from(v: { path: string; scheme: string }) { return new Uri(v.path, v.scheme); }
    with(v: { path?: string }) { return new Uri(v.path ?? this.path, this.scheme); }
  }
  function inject(operation: string, target: string) {
    state.trace.push(`${operation}:${target}`);
    if (operation === state.failOperation && target === state.failAt) {
      state.lastError = Object.assign(new Error(`AD4 injected ${state.failCode || 'uncoded ENOENT-looking message'} ${operation}: ${target}`), state.failCode ? { code: state.failCode } : {});
      throw state.lastError;
    }
  }
  return {
    Uri,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    workspace: { fs: {
      stat: async (u: Uri) => { inject('stat', u.path); const s = await disk.lstat(u.path); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
      readFile: async (u: Uri) => { inject('readFile', u.path); return disk.readFile(u.path); },
      readDirectory: async (u: Uri) => { inject('readDirectory', u.path); const entries = await disk.readdir(u.path, { withFileTypes: true }); await state.onReadDirectory?.(u.path); return entries.map(d => [d.name, d.isSymbolicLink() ? 64 : d.isDirectory() ? 2 : 1]); },
      createDirectory: async (u: Uri) => { state.writes.push(`mkdir:${u.path}`); await disk.mkdir(u.path, { recursive: true }); },
      writeFile: async (u: Uri, bytes: Uint8Array) => { state.writes.push(`write:${u.path}`); await disk.writeFile(u.path, bytes); },
      rename: async (from: Uri, to: Uri, options: { overwrite?: boolean }) => {
        state.writes.push(`rename:${from.path}->${to.path}`);
        // All initialization publications are regular files on the same device.
        // link is an actual atomic no-replace publication; no race is injected here.
        if (options?.overwrite === false) { await disk.link(from.path, to.path); await disk.unlink(from.path); }
        else await disk.rename(from.path, to.path);
        state.trace.push(`published:${to.path}`);
        await state.onRename?.(to.path);
      },
      delete: async (u: Uri) => {
        state.trace.push(`delete-enter:${u.path}`);
        await state.onDelete?.(u.path);
        state.writes.push(`delete:${u.path}`);
        await disk.unlink(u.path);
        state.trace.push(`deleted:${u.path}`);
      }
    } }
  };
});

const observations: unknown[] = [];
const entry = { id: 'visible', package: 'logic', kind: 'definition', title: 'Visible', content: { snl: '' }, pointer: null };
const rootUri = (scheme = 'mem') => vscode.Uri.from({ path: state.root, scheme });
const abs = (p: string) => join(state.root, '.SNL_Doc', p);
async function put(p: string, value: unknown) { await fs.mkdir(dirname(p), { recursive: true }); await fs.writeFile(p, `${JSON.stringify(value, null, 2)}\n`); }
async function bytesOrNull(p: string) { try { return await fs.readFile(p, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
async function snapshot() {
  const result: Record<string, string> = {};
  async function walk(p: string) {
    for (const d of await fs.readdir(p, { withFileTypes: true })) {
      const child = join(p, d.name);
      if (d.isDirectory()) await walk(child);
      else result[child.slice(state.root.length + 1)] = await fs.readFile(child, 'utf8');
    }
  }
  await walk(state.root); return result;
}
async function outcome(f: () => Promise<unknown>) {
  try { return { status: 'fulfilled', value: await f() }; }
  catch (e) { const error = e as Error & { code?: string }; return { status: 'rejected', error: { name: error.name, code: error.code, message: error.message, stack: error.stack } }; }
}
async function seed() {
  await put(abs('config.json'), { version: '0.1.0', entry_kinds: [], macro_kinds: [], active_macro_packages: [] });
  await put(abs(packageManifestPath('logic')), makePackageManifest('logic', 'Logic', '', [entry.id]));
  await put(abs(entryEntityPath('logic', entry.id)), makeEntryEnvelope('logic', entry));
  for (const name of ['macros', 'libraries']) await fs.mkdir(abs(name));
}
beforeEach(async () => {
  state.root = await fs.mkdtemp(join(tmpdir(), 'ad4-owned-'));
  state.failAt = ''; state.failCode = ''; state.failOperation = 'stat'; state.lastError = undefined;
  state.writes = []; state.trace = []; state.onRename = undefined; state.onDelete = undefined; state.onReadDirectory = undefined;
});
afterEach(async () => {
  try {
    for (const record of observations.splice(0)) {
      if (process.env.AD4_OBSERVATIONS) appendFileSync(process.env.AD4_OBSERVATIONS, JSON.stringify(record) + '\n');
    }
  } finally { await fs.rm(state.root, { recursive: true, force: true }); }
});

const routes = [
  { name: 'readEntryPackages/config-stat', path: 'config.json', absent: [] },
  { name: 'readEntryPackages/packages-stat', path: 'packages', absent: [] },
  { name: 'entryBelongsToPackage/entry-stat', path: entryEntityPath('logic', entry.id), absent: false },
  { name: 'entryBelongsToPackage/manifest-stat', path: packageManifestPath('logic'), absent: false },
  { name: 'migration/readJson', path: 'config.json', absent: null },
  { name: 'migration/listJsonFiles', path: 'packages', absent: [] },
  { name: 'migration/directoryExists', path: 'packages', absent: false }
];
async function invoke(name: string) {
  const api = await import('./snlDoc');
  if (name.startsWith('readEntryPackages')) return api.readEntryPackages(rootUri());
  if (name.startsWith('entryBelongsToPackage')) return api.entryBelongsToPackage(rootUri(), 'logic', entry.id);
  const { createVscodeDataMigrationStorage } = await import('./vscodeDataMigration');
  const storage = createVscodeDataMigrationStorage(rootUri());
  if (name === 'migration/readJson') return storage.readJson('config.json');
  if (name === 'migration/listJsonFiles') return storage.listJsonFiles('packages');
  return storage.directoryExists!('packages');
}
describe('AD-IO actual public readers / concrete migration adapter', () => {
  for (const route of routes) for (const code of ['EACCES', 'Unavailable', 'EIO', '', 'ENOENT', 'FileNotFound']) {
    it(`${route.name} ${code}`, async () => {
      await seed(); const before = await snapshot();
      state.failAt = abs(route.path); state.failCode = code;
      let caught: unknown;
      const actual = await outcome(async () => {
        try { return await invoke(route.name); } catch (error) { caught = error; throw error; }
      });
      const after = await snapshot();
      observations.push({ id: 'AD-IO', route: route.name, code, actual, writes: state.writes, trace: state.trace, unchanged: JSON.stringify(before) === JSON.stringify(after) });
      expect(state.trace).toContain(`stat:${state.failAt}`);
      expect(after).toEqual(before); expect(state.writes).toEqual([]);
      if (code === 'ENOENT' || code === 'FileNotFound') expect(actual).toEqual({ status: 'fulfilled', value: route.absent });
      else { expect(actual.status).toBe('rejected'); expect(actual).toMatchObject({ error: { code: code || undefined } }); expect(caught).toBe(state.lastError); }
    });
  }
  it('valid indexed fixture is genuinely visible; typed validation alone maps to false', async () => {
    await seed();
    expect(await invoke('readEntryPackages')).toEqual([{ id: 'logic', name: 'Logic', description: '', entryCount: 1 }]);
    expect(await invoke('entryBelongsToPackage')).toBe(true);
    await put(abs(packageManifestPath('logic')), makePackageManifest('logic', 'Logic', '', []));
    expect(await invoke('entryBelongsToPackage')).toBe(false);
    observations.push({ id: 'control-valid-and-unindexed', indexed: true, unindexed: false, writes: state.writes });
  });
  for (const route of [routes[2], routes[4]]) it(`${route.name} readFile EACCES already propagates`, async () => {
    await seed(); state.failAt = abs(route.path); state.failCode = 'EACCES'; state.failOperation = 'readFile';
    const actual = await outcome(() => invoke(route.name));
    observations.push({ id: 'control-read-error', route: route.name, actual, writes: state.writes });
    expect(actual).toMatchObject({ status: 'rejected', error: { code: 'EACCES' } }); expect(state.writes).toEqual([]);
  });
});

describe('AD-CAS actual init / rollback after topology rejection', () => {
  for (const scheme of ['mem', 'file']) for (const timing of ['none', 'before-rollback-read', 'delete-hook', 'post-publication-read', 'rename-applied-then-rejected']) {
    it(`${scheme}: foreign replacement ${timing}`, async () => {
      const config = abs('config.json');
      const hiddenPath = abs(entryEntityPath('_unpackaged', 'hidden.entry'));
      const hidden = makeEntryEnvelope('_unpackaged', { ...entry, id: 'hidden.entry', package: '_unpackaged' });
      const foreign = { version: '0.1.0', entry_kinds: [], macro_kinds: [], vendor_foreign_owner: 'DO-NOT-DELETE' };
      const foreignBytes = `${JSON.stringify(foreign, null, 2)}\n`;
      let replacementObserved: string | null = null;
      async function replaceForeign() {
        // Bypass workspaceDataLock as a noncooperating writer. Real rename puts
        // a different inode at config.json after the production read completed.
        const other = abs('foreign-config.tmp');
        await fs.writeFile(other, foreignBytes); await fs.rename(other, config);
        replacementObserved = await bytesOrNull(config);
        state.trace.push('foreign-replacement:verified');
      }
      state.onRename = async target => {
        if (target !== config) return;
        await put(hiddenPath, hidden);
        if (timing === 'before-rollback-read' || timing === 'rename-applied-then-rejected') await replaceForeign();
        if (timing === 'rename-applied-then-rejected') throw new Error('provider rejected after applying rename');
      };
      state.onDelete = async target => { if (target === config && timing === 'delete-hook') await replaceForeign(); };
      let postReadReplacement = false;
      state.onReadDirectory = async target => {
        if (timing === 'post-publication-read' && target === abs('entries') && await bytesOrNull(config) && !postReadReplacement) {
          postReadReplacement = true; await replaceForeign();
        }
      };
      const { initSnlDoc } = await import('./snlDoc');
      const actual = await outcome(() => initSnlDoc(rootUri(scheme)));
      const finalConfig = await bytesOrNull(config);
      const after = await snapshot();
      observations.push({ id: 'AD-CAS', scheme, timing, actual, replacementObserved, foreignBytes, finalConfig, finalFiles: after, writes: state.writes, trace: state.trace });
      expect(actual).toMatchObject({ status: 'rejected', error: { message: expect.stringMatching(/topology changed|provider rejected after applying rename/) } });
      expect(JSON.parse((await bytesOrNull(hiddenPath))!)).toEqual(hidden);
      expect(state.trace).not.toContain(`delete-enter:${config}`);
      expect(actual).toMatchObject({ error: { name: 'SnlInitializationRecoveryRequiredError', message: expect.stringMatching(/Explicit recovery required/) } });
      expect((actual as { error?: { message: string } }).error?.message).toContain(config);
      if (timing === 'none' || timing === 'delete-hook') {
        // The retained delete-hook attack remains armed but MUST NOT be reached.
        // Independent rename/read hooks above prove actual foreign preservation.
        expect(replacementObserved).toBeNull();
        expect(JSON.parse(finalConfig!)).toMatchObject({ version: '0.1.0' });
      } else { expect(replacementObserved).toBe(foreignBytes); expect(finalConfig).toBe(foreignBytes); }
      state.onRename = undefined; state.onReadDirectory = undefined;
      const retry = await outcome(() => initSnlDoc(rootUri(scheme)));
      expect(retry.status).toBe('rejected');
      expect(await snapshot()).toEqual(after);
    });
  }
});

// Positive/recovery controls exercise the same exported initializer, not helpers.
describe('initialization recovery contract controls', () => {
  for (const scheme of ['mem', 'file']) {
    it(`${scheme}: fresh initialization remains usable and idempotent`, async () => {
      const { initSnlDoc, readEntryPackages } = await import('./snlDoc');
      expect(await initSnlDoc(rootUri(scheme))).toEqual({ status: 'created' });
      const before = await snapshot();
      expect(await initSnlDoc(rootUri(scheme))).toEqual({ status: 'exists' });
      expect(await snapshot()).toEqual(before);
      expect(await readEntryPackages(rootUri(scheme))).toMatchObject([{ id: '_unpackaged', entryCount: 0 }]);
    });

    it(`${scheme}: ambiguous publication preserves original cause and foreign bytes`, async () => {
      const { initSnlDoc, SnlInitializationRecoveryRequiredError } = await import('./snlDoc');
      const cause = Object.assign(new Error('provider lost acknowledgement'), { code: 'Unavailable' });
      const config = abs('config.json');
      const foreign = '{"vendor_foreign_owner":"preserve exact bytes"}\n';
      state.onRename = async target => {
        if (target !== config) return;
        await fs.writeFile(config, foreign);
        throw cause;
      };
      const error = await initSnlDoc(rootUri(scheme)).catch(e => e);
      expect(error).toBeInstanceOf(SnlInitializationRecoveryRequiredError);
      expect(error.cause).toBe(cause);
      expect(error.configMayBePublished).toBe(true);
      expect(error.recoveryUri.toString()).toBe(vscode.Uri.joinPath(rootUri(scheme), '.SNL_Doc', 'config.json').toString());
      expect(await fs.readFile(config, 'utf8')).toBe(foreign);
      expect(state.trace).not.toContain(`delete-enter:${config}`);
    });
  }

  for (const code of ['EACCES', 'Unavailable', '']) it(`initializer config stat ${code || 'uncoded'} fails closed`, async () => {
    await seed(); const before = await snapshot();
    state.failAt = abs('config.json'); state.failCode = code;
    const { initSnlDoc } = await import('./snlDoc');
    const error = await initSnlDoc(rootUri()).catch(e => e);
    expect(error).toBe(state.lastError);
    expect(error).toBeInstanceOf(Error);
    expect(await snapshot()).toEqual(before);
    expect(state.writes.filter(w => !w.startsWith('mkdir:'))).toEqual([]);
  });
});
