import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const mocks = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>>, language: 'en' }));
vi.mock('./snlDoc', () => ({ readEntries: async () => mocks.entries }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: mocks.language }) }));
import { createPointerHostDriver } from './pointerSyncDriver';
import { readPointerIndex } from './pointerSync/persistence';
import { cachePath, clearCache, readCacheArtifact } from './derivedCache';
import { isPointerIndex } from './pointerSync/persistence';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  mocks.language = 'en';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-pointer-driver-')); roots.push(root);
  await fs.mkdir(path.join(root, '.SNL_Doc'));
  await fs.writeFile(path.join(root, '.SNL_Doc/config.json'), JSON.stringify({ version: '0.1.0' }));
  await fs.writeFile(path.join(root, 'Example.lean'), 'prefix\nfoo\n');
  mocks.entries = [{ id: 'A', title: 'Alpha', package: 'P', pointer: { file: 'Example.lean', mode: 'regex', pattern: '^foo$', flags: 'm', beforeLines: 0, afterLines: 0 } }];
  return { root, uri: { fsPath: root } as never, driver: createPointerHostDriver() };
}
describe('Pointer host filesystem adapter', () => {
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
