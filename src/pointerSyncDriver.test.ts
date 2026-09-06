import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
const mocks = vi.hoisted(() => ({ entries: [] as Array<Record<string, unknown>> }));
vi.mock('./snlDoc', () => ({ readEntries: async () => mocks.entries }));
vi.mock('./preferences', () => ({ read_extension_preferences: () => ({ language: 'en' }) }));
import { createPointerHostDriver } from './pointerSyncDriver';
import { readPointerIndex } from './pointerSync/persistence';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snl-pointer-driver-')); roots.push(root);
  await fs.mkdir(path.join(root, '.SNL_Doc'));
  await fs.writeFile(path.join(root, '.SNL_Doc/config.json'), JSON.stringify({ version: '0.1.0' }));
  await fs.writeFile(path.join(root, 'Example.lean'), 'prefix\nfoo\n');
  mocks.entries = [{ id: 'A', title: 'Alpha', package: 'P', pointer: { file: 'Example.lean', mode: 'regex', pattern: '^foo$', flags: 'm', beforeLines: 0, afterLines: 0 } }];
  return { root, uri: { fsPath: root } as never, driver: createPointerHostDriver() };
}
describe('Pointer host filesystem adapter', () => {
  it('publishes an actual validated inverse map and keeps dirty text overlays out of disk', async () => {
    const f = await fixture();
    const index = await f.driver.build(f.uri); await f.driver.publish(f.uri, index);
    const before = await fs.readFile(path.join(f.root, '.SNL_Doc/syncSNL.json'), 'utf8');
    expect((await readPointerIndex(f.root))?.files['Example.lean'].entries[0].resolution).toMatchObject({ status: 'ok', range: { startLine: 2 } });
    const found = await f.driver.query(f.uri, index, 'Example.lean', 3, 'prefix\ninserted\nfoo\n');
    expect(found).toMatchObject({ complete: true, candidates: [{ entryId: 'A', title: 'Alpha', startLine: 3 }] });
    expect(await fs.readFile(path.join(f.root, '.SNL_Doc/syncSNL.json'), 'utf8')).toBe(before);
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
