import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const mocks = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>>, language: 'en', readEntries: vi.fn() }));
vi.mock('./snlDoc', () => ({ readEntries: mocks.readEntries }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: mocks.language }) }));
import { createPointerHostDriver } from './pointerSyncDriver';
import { readPointerIndex } from './pointerSync/persistence';
import { cachePath, clearCache, readCacheArtifact } from './derivedCache';
import { isPointerIndex } from './pointerSync/persistence';
import { PointerIndexCoordinator } from './pointerSyncHostState';
import type { PointerIndex } from './pointerSync';
import * as resolver from './pointerSync/resolve';
import * as scopes from './pointerSync/scope';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function boot(uri: never) {
  const driver = createPointerHostDriver();
  const coordinator = new PointerIndexCoordinator<PointerIndex>({
    build: previous => driver.build(uri, previous),
    publish: index => driver.publish(uri, index),
  });
  return { driver, coordinator };
}
async function fixture() {
  mocks.language = 'en';
  mocks.readEntries.mockReset().mockImplementation(async () => structuredClone(mocks.entries));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-pointer-driver-')); roots.push(root);
  await fs.mkdir(path.join(root, '.SNL_Doc'));
  await fs.writeFile(path.join(root, '.SNL_Doc/config.json'), JSON.stringify({ version: '0.1.0' }));
  await fs.writeFile(path.join(root, 'Example.lean'), 'prefix\nfoo\n');
  mocks.entries = [{ id: 'A', title: 'Alpha', package: 'P', pointer: { file: 'Example.lean', mode: 'regex', pattern: '^foo$', flags: 'm', beforeLines: 0, afterLines: 0 } }];
  return { root, uri: { fsPath: root } as never, driver: createPointerHostDriver() };
}
describe('Pointer host filesystem adapter', () => {
  it('cold-boots a new driver/coordinator from real persisted candidates without resolving or compiling unchanged input', async () => {
    const f = await fixture();
    const resolve = vi.spyOn(resolver, 'resolvePointerTextAsync');
    const compile = vi.spyOn(scopes, 'compilePointerScope');
    const first = boot(f.uri);
    const saved = await first.coordinator.ensure();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(await readPointerIndex(f.root)).toEqual(saved);
    first.coordinator.dispose();
    resolve.mockClear(); compile.mockClear();
    const source = vi.spyOn(resolver, 'readPointerSource');
    const open = vi.spyOn(fs, 'open');
    const cold = boot(f.uri);
    const rebuilt = await cold.coordinator.ensure();
    expect(open.mock.calls.some(([file]) => file === cachePath(f.root, 'pointer-inverse'))).toBe(true);
    expect(source).toHaveBeenCalledWith(f.root, 'Example.lean');
    expect(mocks.readEntries).toHaveBeenCalledTimes(2);
    expect(mocks.readEntries).toHaveBeenLastCalledWith(f.uri, true);
    expect(rebuilt).toEqual(saved);
    expect(resolve).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    expect(await cold.coordinator.ensure()).toBe(rebuilt);
    expect(await cold.driver.query(f.uri, rebuilt, 'Example.lean', 2, 'prefix\nfoo\n')).toMatchObject({
      complete: true, candidates: [{ entryId: 'A', startLine: 2 }],
    });
    const bytes = await fs.readFile(cachePath(f.root, 'pointer-inverse'), 'utf8');
    expect(await cold.driver.query(f.uri, rebuilt, 'Example.lean', 3, 'dirty\nprefix\nfoo\n')).toMatchObject({
      candidates: [{ entryId: 'A', startLine: 3 }],
    });
    expect(await fs.readFile(cachePath(f.root, 'pointer-inverse'), 'utf8')).toBe(bytes);
    cold.coordinator.dispose();
    resolve.mockClear(); compile.mockClear();
    const again = boot(f.uri);
    expect(await again.coordinator.ensure()).toEqual(saved);
    expect(resolve).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    again.coordinator.dispose();
  });
  it.each([
    { id: 'Renamed' },
    { package: 'NewPackage' },
    { title: { type: 'i18n', default_language: 'en', values: { en: 'Updated' } } },
    { pointer: { file: 'Example.lean', mode: 'regex', pattern: '^prefix$', flags: 'm', priority: .5 } },
  ])('cold-reconciles complete changed metadata %j while retaining unchanged resolutions', async change => {
    const f = await fixture();
    mocks.entries.push({ id: 'B', pointer: { file: 'Example.lean', mode: 'regex', pattern: 'prefix' } });
    const first = boot(f.uri); await first.coordinator.ensure(); first.coordinator.dispose();
    Object.assign(mocks.entries[0], change);
    const resolve = vi.spyOn(resolver, 'resolvePointerTextAsync');
    const compile = vi.spyOn(scopes, 'compilePointerScope');
    const cold = boot(f.uri);
    const index = await cold.coordinator.ensure();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0]).toEqual(mocks.entries[0].pointer);
    const row = index.files['Example.lean'].entries.find(entry => entry.entryId !== 'B')!;
    expect(row).toMatchObject({ entryId: mocks.entries[0].id, package: mocks.entries[0].package,
      title: mocks.entries[0].title, pointer: mocks.entries[0].pointer });
    expect(await readPointerIndex(f.root)).toEqual(index);
    cold.coordinator.dispose();
  });
  it('cold-reconciles added, removed and moved Entries without reviving stale buckets', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'other'), 'other source');
    mocks.entries.push({ id: 'Deleted', pointer: { file: 'Example.lean', mode: 'regex', pattern: 'prefix' } });
    const first = boot(f.uri); await first.coordinator.ensure(); first.coordinator.dispose();
    mocks.entries = [
      { id: 'A', pointer: { file: 'other', mode: 'regex', pattern: 'other' } },
      { id: 'Added', pointer: { file: 'other', mode: 'lines', line: 1 } },
    ];
    const resolve = vi.spyOn(resolver, 'resolvePointerTextAsync');
    const cold = boot(f.uri); const index = await cold.coordinator.ensure();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(Object.keys(index.files)).toEqual(['other']);
    expect(index.files.other.entries.map(entry => entry.entryId)).toEqual(['A', 'Added']);
    cold.coordinator.dispose();
  });
  it.each(['changed', 'missing'] as const)('checks current source bytes on cold boot (%s), reusing only other files', async state => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'other'), 'other source');
    mocks.entries.push({ id: 'B', pointer: { file: 'other', mode: 'regex', pattern: 'other' } });
    const first = boot(f.uri); await first.coordinator.ensure(); first.coordinator.dispose();
    const file = path.join(f.root, 'Example.lean');
    if (state === 'changed') {
      const stat = await fs.stat(file);
      // Same length/mtime is not a freshness certificate.
      await fs.writeFile(file, 'foo\nprefix\n');
      await fs.utimes(file, stat.atime, stat.mtime);
    } else await fs.unlink(file);
    const resolve = vi.spyOn(resolver, 'resolvePointerTextAsync');
    const compile = vi.spyOn(scopes, 'compilePointerScope');
    const source = vi.spyOn(resolver, 'readPointerSource');
    const cold = boot(f.uri); const index = await cold.coordinator.ensure();
    expect(source).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(state === 'changed' ? 1 : 0);
    expect(compile).toHaveBeenCalledTimes(state === 'changed' ? 1 : 0);
    expect(index.files['Example.lean'].entries[0].resolution).toMatchObject(state === 'changed'
      ? { status: 'ok', scope: { startLine: 1 } } : { status: 'file-missing' });
    expect(index.files.other.entries[0].resolution.status).toBe('ok');
    cold.coordinator.dispose();
  });
  it.each(['missing', 'bad-json', 'bad-hash', 'old-version'] as const)('cold-rebuilds %s cache without any legacy syncSNL I/O', async state => {
    const f = await fixture();
    const first = boot(f.uri); const saved = await first.coordinator.ensure(); first.coordinator.dispose();
    const file = cachePath(f.root, 'pointer-inverse');
    if (state === 'missing') await fs.unlink(file);
    else if (state === 'bad-json') await fs.writeFile(file, '{broken');
    else {
      const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state === 'bad-hash') envelope.value.files['Example.lean'].entries[0].entryId = 'Forged';
      else envelope.version = 'obsolete';
      await fs.writeFile(file, JSON.stringify(envelope));
    }
    const legacy = path.join(f.root, '.SNL_Doc/syncSNL.json');
    await fs.writeFile(legacy, 'legacy ignored');
    const before = await fs.stat(legacy);
    const read = vi.spyOn(fs, 'readFile'), open = vi.spyOn(fs, 'open');
    const write = vi.spyOn(fs, 'writeFile'), unlink = vi.spyOn(fs, 'unlink'), rm = vi.spyOn(fs, 'rm');
    const resolve = vi.spyOn(resolver, 'resolvePointerTextAsync');
    const cold = boot(f.uri); const index = await cold.coordinator.ensure();
    expect(index).toEqual(saved);
    expect(resolve).toHaveBeenCalledTimes(1);
    for (const spy of [read, open, write, unlink, rm]) {
      expect(spy.mock.calls.some(([target]) => target === legacy)).toBe(false);
    }
    expect(await fs.stat(legacy)).toMatchObject({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs });
    expect(await fs.readFile(legacy, 'utf8')).toBe('legacy ignored');
    expect(await readPointerIndex(f.root)).toEqual(saved);
    cold.coordinator.dispose();
  });
  it.each([
    { file: '../outside', mode: 'regex', pattern: 'foo' },
    { file: 'Example.lean', mode: 'regex', pattern: 'foo', occurrence: 0 },
    { file: 'Example.lean', mode: 'regex', pattern: 'foo', flags: 'gg' },
    { file: 'Example.lean', mode: 'regex', pattern: '[' },
    { file: 'Example.lean', mode: 'lines', line: 1, column: 999 },
  ])('does not let a prior successful resolution bypass current Pointer validation: %j', async pointer => {
    const f = await fixture();
    const first = boot(f.uri); await first.coordinator.ensure(); first.coordinator.dispose();
    mocks.entries[0].pointer = pointer;
    const compile = vi.spyOn(scopes, 'compilePointerScope');
    const cold = boot(f.uri); const index = await cold.coordinator.ensure();
    expect(cold.driver.summary(index)).toMatchObject({ pointers: 1, unresolved: 1 });
    expect(compile).not.toHaveBeenCalled();
    expect((await cold.driver.query(f.uri, index, 'Example.lean', 2, 'prefix\nfoo\n')).candidates).toEqual([]);
    cold.coordinator.dispose();
  });
  it('reads canonical Entries before cache admission and refuses to publish after canonical read failure', async () => {
    const f = await fixture();
    const first = boot(f.uri); await first.coordinator.ensure(); first.coordinator.dispose();
    const file = cachePath(f.root, 'pointer-inverse');
    const bytes = await fs.readFile(file, 'utf8');
    mocks.readEntries.mockRejectedValueOnce(new Error('canonical metadata invalid'));
    const open = vi.spyOn(fs, 'open');
    const cold = boot(f.uri);
    await expect(cold.coordinator.ensure()).rejects.toThrow('canonical metadata invalid');
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    cold.coordinator.dispose();
  });
  it('rebuilds the global v3 cache through the common interface without touching legacy files', async () => {
    const f = await fixture();
    const legacy = path.join(f.root, '.SNL_Doc/syncSNL.json');
    await fs.writeFile(legacy, 'legacy bytes are not authority');
    mocks.entries.push({ id: 'Other', package: 'OutsideLibrary', pointer: { file: 'other', mode: 'lines', line: 1 } });
    await fs.writeFile(path.join(f.root, 'other'), 'other source');
    const index = await f.driver.build(f.uri); await f.driver.publish(f.uri, index);
    const artifact = await readCacheArtifact(f.root, { id: 'pointer-inverse', version: '1', validate: isPointerIndex });
    expect(artifact?.value).toEqual(index);
    expect(await fs.readFile(legacy, 'utf8')).toBe('legacy bytes are not authority');
    expect(JSON.parse(await fs.readFile(cachePath(f.root, 'pointer-inverse'), 'utf8')).value.version).toBe(3);
    await clearCache(f.root, 'pointer-inverse');
    await fs.writeFile(path.join(f.root, 'Example.lean'), 'new\nprefix\nfoo\n');
    const cold = createPointerHostDriver();
    const rebuilt = await cold.build(f.uri); await cold.publish(f.uri, rebuilt);
    expect(await cold.query(f.uri, rebuilt, 'Example.lean', 3, 'new\nprefix\nfoo\n')).toMatchObject({ candidates: [{ entryId: 'A', startLine: 3 }] });
    expect(await cold.query(f.uri, rebuilt, 'other', 1, 'other source')).toMatchObject({ candidates: [{ entryId: 'Other', package: 'OutsideLibrary' }] });
    expect(await fs.readFile(legacy, 'utf8')).toBe('legacy bytes are not authority');
  });
  it('publishes exact columns/priority despite obsolete fields and distinguishes same-line dirty cursor moves', async () => {
    const f=await fixture(), text='alpha beta\n';
    await fs.writeFile(path.join(f.root,'Example.lean'),text);
    mocks.entries=[
      {id:'a',pointer:{file:'Example.lean',mode:'lines',line:1,column:1,endColumn:6,beforeLines:-99,afterLines:1e12,priority:-.5}},
      {id:'b',pointer:{file:'Example.lean',mode:'lines',line:1,column:7,endColumn:11,priority:.25}}
    ];
    const index=await f.driver.build(f.uri);await f.driver.publish(f.uri,index);
    const persisted=(await readPointerIndex(f.root))!;
    expect(persisted.version).toBe(3);
    expect(await f.driver.query(f.uri,persisted,'Example.lean',1,text,2)).toMatchObject({complete:true,candidates:[{entryId:'a',startColumn:1,endColumn:6,priority:-.5}]});
    expect(await f.driver.query(f.uri,persisted,'Example.lean',1,text,7)).toMatchObject({complete:true,candidates:[{entryId:'b',startColumn:7,endColumn:11,priority:.25}]});
    expect((await f.driver.query(f.uri,persisted,'Example.lean',1,text,6)).candidates).toEqual([]);
    expect((await f.driver.query(f.uri,persisted,'Example.lean',1,text,11)).candidates).toEqual([]);
    expect((await f.driver.query(f.uri,persisted,'Example.lean',2,text,1)).candidates).toEqual([]);
  });
  it('round-trips canonical localized titles and resolves the current language at query time', async () => {
    const f = await fixture();
    const title = { type: 'i18n', default_language: 'zh-CN', values: { en: 'Alpha', 'zh-CN': '阿尔法', fr: '' } };
    mocks.entries[0].title = title;
    const authored = structuredClone(mocks.entries);
    const index = await f.driver.build(f.uri);
    await f.driver.publish(f.uri, index);
    const persisted = await readPointerIndex(f.root);
    expect(persisted).toBeDefined();
    for (const [language, expected] of [['en', 'Alpha'], ['zh-CN', '阿尔法'], ['de', '阿尔法'], ['constructor', '阿尔法'], ['fr', '']]) {
      mocks.language = language;
      const found = await f.driver.query(f.uri, persisted!, 'Example.lean', 2, 'prefix\nfoo\n');
      expect(found).toMatchObject({ complete: true, candidates: [{ entryId: 'A', title: expected, startLine: 2 }] });
    }
    expect(mocks.entries).toEqual(authored);
    expect(mocks.entries[0].title).toBe(title);
  });
  it.each([
    { name: 'text', title: '  Alpha  ', expected: '  Alpha  ' },
    { name: 'empty text', title: '', expected: '' },
    { name: 'absent title', title: undefined, expected: undefined },
    { name: 'English default', title: { type: 'i18n', default_language: 'en', values: { en: 'Alpha', 'zh-CN': '阿尔法' } }, expected: 'Alpha' },
    { name: 'empty default', title: { type: 'i18n', default_language: 'en', values: { en: '', 'zh-CN': '阿尔法' } }, expected: '' },
    { name: 'partial locale map', title: { type: 'i18n', default_language: 'fr', values: { 'zh-CN': '阿尔法' } }, expected: '阿尔法' },
    { name: 'legacy flat locale map', title: { en: 'Alpha', 'zh-CN': '阿尔法' }, expected: 'Alpha' },
  ])('publishes and queries $name without losing title semantics', async ({ title, expected }) => {
    const f = await fixture();
    mocks.entries[0].title = title;
    const index = await f.driver.build(f.uri);
    await f.driver.publish(f.uri, index);
    const persisted = await readPointerIndex(f.root);
    expect(persisted).toBeDefined();
    mocks.language = 'de';
    const found = await f.driver.query(f.uri, persisted!, 'Example.lean', 2, 'prefix\nfoo\n');
    expect(found).toMatchObject({ complete: true, candidates: [{ entryId: 'A', title: expected }] });
  });
  it('refreshes canonical titles while reusing unchanged Pointer resolutions', async () => {
    const f = await fixture();
    const index = await f.driver.build(f.uri);
    mocks.entries[0].title = { type: 'i18n', default_language: 'en', values: { en: 'Updated' } };
    const next = await f.driver.build(f.uri, index);
    await f.driver.publish(f.uri, next);
    const persisted = await readPointerIndex(f.root);
    expect(persisted).toBeDefined();
    const found = await f.driver.query(f.uri, persisted!, 'Example.lean', 2, 'prefix\nfoo\n');
    expect(found).toMatchObject({ complete: true, candidates: [{ entryId: 'A', title: 'Updated' }] });
  });
  it('publishes an actual validated inverse map and keeps dirty text overlays out of disk', async () => {
    const f = await fixture();
    const index = await f.driver.build(f.uri); await f.driver.publish(f.uri, index);
    const before = await fs.readFile(cachePath(f.root, 'pointer-inverse'), 'utf8');
    expect((await readPointerIndex(f.root))?.files['Example.lean'].entries[0].resolution).toMatchObject({ status: 'ok', scope: { startLine: 2 } });
    const found = await f.driver.query(f.uri, index, 'Example.lean', 3, 'prefix\ninserted\nfoo\n');
    expect(found).toMatchObject({ complete: true, candidates: [{ entryId: 'A', title: 'Alpha', startLine: 3 }] });
    expect(await fs.readFile(cachePath(f.root, 'pointer-inverse'), 'utf8')).toBe(before);
  });
  it('reconciles moved/deleted Pointer metadata instead of retaining stale rows', async () => {
    const f = await fixture(); const index = await f.driver.build(f.uri);
    mocks.entries = [];
    const next = await f.driver.build(f.uri, index); await f.driver.publish(f.uri, next);
    expect(f.driver.summary(next)).toMatchObject({ pointers: 0, files: 0 });
    expect((await readPointerIndex(f.root))?.files['Example.lean']).toBeUndefined();
  });
  it('reports unresolved pointers without mutating the authored object', async () => {
    const f = await fixture(); const pointer = { file: 'missing.lean', mode: 'lines', line: 10, beforeLines: 0, afterLines: 20 };
    mocks.entries.push({ id: 'Missing', pointer });
    const index = await f.driver.build(f.uri);
    expect(f.driver.summary(index)).toMatchObject({ files: 2, pointers: 2, unresolved: 1 });
    expect(mocks.entries[1].pointer).toBe(pointer);
  });
  it('does not initialize an SNL directory through maintenance of a non-SNL project', async () => {
    const f = await fixture(); await fs.rm(path.join(f.root, '.SNL_Doc'), { recursive: true });
    await expect(f.driver.build(f.uri)).rejects.toThrow();
    await expect(fs.stat(path.join(f.root, '.SNL_Doc'))).rejects.toThrow();
  });
});
