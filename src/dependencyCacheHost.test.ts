import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';

// Only the VS Code transport is substituted: all storage, schema/CAS, reads,
// dependency generation and cache publication below run against real files.
vi.mock('vscode', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const uri = (p: string): any => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` });
  return {
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    Uri: { file: uri, joinPath: (base: any, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { fs: {
      stat: async (u: any) => { const s = await fs.lstat(u.fsPath); return { type: s.isSymbolicLink() ? 64 : s.isDirectory() ? 2 : 1, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }; },
      readFile: (u: any) => fs.readFile(u.fsPath),
      readDirectory: async (u: any) => (await fs.readdir(u.fsPath, { withFileTypes: true })).map(d => [d.name, d.isDirectory() ? 2 : d.isSymbolicLink() ? 64 : 1]),
      createDirectory: (u: any) => fs.mkdir(u.fsPath, { recursive: true }),
      writeFile: (u: any, b: Uint8Array) => fs.writeFile(u.fsPath, b),
      rename: (a: any, b: any) => fs.rename(a.fsPath, b.fsPath),
      delete: (u: any) => fs.rm(u.fsPath, { recursive: true, force: true })
    } },
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }
  };
});
import {
  initSnlDoc, createEntryKind, createMacroPackage, addMacro, readAllMacros, updateMacro,
  addEntry, readEntries, updateEntry, entityRevision, addRelationship, updateRelationship,
  deleteRelationship, readAuthoredRelationships, readOverview, readGlobalPageRank,
  regenerateDependencyRelationships, readRelationships, type MacroPackageEntry
} from './snlDoc';
import { clearCache, cachePath } from './derivedCache';
import { entryEntityPath } from './entityStorage';
import { relationshipGraphEdge } from './relationshipGraphWire';
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'snl-dependency-host-')); roots.push(root);
  const uri = vscode.Uri.file(root);
  expect(await initSnlDoc(uri)).toEqual({ status: 'created' });
  expect(await createEntryKind(uri, { id: 'entry', name: 'Entry', description: '', coloring: { light: { stroke: '', background: '' }, dark: { stroke: '', background: '' } }, defaultCounterName: '', style: '' })).toMatchObject({ status: 'created' });
  for (const id of ['A', 'B', 'isolated']) {
    expect(await addEntry(uri, { id, kind: 'entry', title: id, content: { snl: '' }, pointer: null, contribution_info: null })).toMatchObject({ status: 'ok' });
  }
  const relationships = [
    { id: 'manual', from: 'A', to: 'B', label: 'depends', metadata: { opaque: ['author'], isAtomic: 'keep' } },
    { id: 'legacy', from: 'B', to: 'A', label: 'depends', metadata: { generator: 'macro-source-scan', macros: ['old'] } },
    { id: 'context', from: 'B', to: 'A', label: 'uses_context', metadata: { generator: 'macro-source-scan', nested: { keep: true } } }
  ];
  await fs.writeFile(join(root, '.SNL_Doc/relationships.json'), JSON.stringify({ version: 1, relationships }, null, 3) + '\n');
  return { root, uri, relationships };
}
async function authored(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const d of await fs.readdir(join(root, dir), { withFileTypes: true })) {
      if (d.name === '.cache') continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else result[p] = (await fs.readFile(join(root, p))).toString('base64');
    }
  }
  await walk('.SNL_Doc'); return result;
}
async function setSnl(f: Awaited<ReturnType<typeof fixture>>, id: string, snl: string) {
  const e = (await readEntries(f.uri)).find(e => e.id === id)!;
  expect(await updateEntry(f.uri, id, { ...e, content: { snl } }, entityRevision(e))).toMatchObject({ status: 'updated' });
}
async function withMacro() {
  const f = await fixture();
  expect(await createMacroPackage(f.uri, 'Test', 'Test')).toMatchObject({ status: 'ok' });
  const macro: MacroPackageEntry = { name: 'testMacro', kind: 'const', description: '', source: { entries: ['B', 'B', 'A', 'missing'], urls: [] }, dynamic_arity: false, styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: 'x' }, tags: [] }], tags: [] };
  expect(await addMacro(f.uri, 'Test', macro)).toMatchObject({ status: 'ok' });
  await setSnl(f, 'A', 'testMacro testMacro');
  return f;
}

describe('Dependency cache real host storage', () => {
  it('cold/hot/concurrent/clear/corrupt reads generate only cache and preserve the authored pool', async () => {
    const f = await withMacro(); const before = await authored(f.root);
    const cold = await readRelationships(f.uri);
    expect(cold.find(r => r.id === 'dep.A.B')).toMatchObject({ from: 'A', to: 'B', metadata: { macros: ['testMacro'], isAtomic: true } });
    const file = cachePath(f.root, 'dependencies'); const stat = await fs.stat(file);
    expect(await Promise.all([readRelationships(f.uri), readRelationships(f.uri)])).toEqual([cold, cold]);
    expect((await fs.stat(file)).mtimeMs).toBe(stat.mtimeMs);
    await clearCache(f.root, 'dependencies'); expect(await readRelationships(f.uri)).toEqual(cold);
    await fs.writeFile(file, '{corrupt'); expect(await readRelationships(f.uri)).toEqual(cold);
    expect((await readOverview(f.uri)).relationships).toEqual(cold);
    expect(relationshipGraphEdge(cold.find(r => r.id === 'dep.A.B')!)).toMatchObject({ isDependency: true });
    expect(await authored(f.root)).toEqual(before);
    expect(await readAuthoredRelationships(f.uri)).toEqual(f.relationships);
  });
  it('manual CAS never writes derived rows and both current/legacy auto rows reject edits', async () => {
    const f = await withMacro(); const composed = await readRelationships(f.uri);
    const automatic = composed.find(r => r.id === 'dep.A.B')!;
    const before = await authored(f.root);
    for (const r of [automatic, f.relationships[1]]) {
      expect(await updateRelationship(f.uri, r.id, r, entityRevision(r))).toMatchObject({ status: 'invalid', message: expect.stringMatching(/read-only/) });
      expect(await deleteRelationship(f.uri, r.id)).toMatchObject({ status: 'invalid' });
    }
    expect(await addRelationship(f.uri, { ...automatic, id: 'fake' })).toMatchObject({ status: 'invalid' });
    expect(await authored(f.root)).toEqual(before);
    const manual = composed.find(r => r.id === 'manual')!;
    expect(await updateRelationship(f.uri, manual.id, { ...manual, label: 'custom' }, 'stale')).toMatchObject({ status: 'conflict' });
    expect(await updateRelationship(f.uri, manual.id, { ...manual, label: 'custom' }, entityRevision(manual))).toMatchObject({ status: 'updated' });
    expect(await addRelationship(f.uri, { id: 'extra', from: 'B', to: 'isolated', label: 'depends', metadata: null })).toMatchObject({ status: 'ok' });
    expect(await deleteRelationship(f.uri, 'extra')).toMatchObject({ status: 'ok' });
    const raw = await readAuthoredRelationships(f.uri);
    expect(raw).toEqual(f.relationships.map(r => r.id === 'manual' ? { ...r, label: 'custom' } : r));
    expect(raw.some(r => r.id === automatic.id)).toBe(false);
    expect((await readRelationships(f.uri)).find(r => r.id === automatic.id)).toEqual(automatic);
  });
  it('invalidates globally on Macro sources, Entry references and pool additions/deletions', async () => {
    const f = await withMacro(); await readRelationships(f.uri);
    const file = cachePath(f.root, 'dependencies'); const oldHash = JSON.parse(await fs.readFile(file, 'utf8')).inputHash;
    const m = (await readAllMacros(f.uri)).testMacro;
    expect(await updateMacro(f.uri, 'Test', { ...m, source: { entries: ['isolated'], urls: [] } }, entityRevision(m))).toMatchObject({ status: 'updated' });
    const fresh = await readRelationships(f.uri);
    expect(fresh.some(r => r.id === 'dep.A.B')).toBe(false);
    expect(fresh.find(r => r.id === 'dep.A.isolated')).toBeDefined();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).inputHash).not.toBe(oldHash);
    await setSnl(f, 'B', 'testMacro');
    await regenerateDependencyRelationships(f.uri, { entryIds: new Set(['A']) });
    expect((await readRelationships(f.uri)).find(r => r.id === 'dep.B.isolated')).toBeDefined();
    await setSnl(f, 'A', ''); expect((await readRelationships(f.uri)).some(r => r.from === 'A' && r.id !== 'manual')).toBe(false);
    // Deletion uses the real host writer, not a fabricated cached response.
    const { deleteEntry } = await import('./snlDoc');
    expect(await deleteEntry(f.uri, 'isolated')).toMatchObject({ status: 'ok' });
    expect((await readRelationships(f.uri)).some(r => r.to === 'isolated')).toBe(false);
    expect(await addEntry(f.uri, { id: 'isolated', kind: 'entry', title: 'Again', content: {}, pointer: null, contribution_info: null })).toMatchObject({ status: 'ok' });
    expect((await readRelationships(f.uri)).find(r => r.id === 'dep.B.isolated')).toBeDefined();
  });
  it('PageRank host caches the full composed topology independently of title and Authoring', async () => {
    const f = await withMacro(); const before = await authored(f.root);
    const rank = await readGlobalPageRank(f.uri);
    expect(rank.scores.A).toBeCloseTo(20 / 77, 10); expect(rank.scores.B).toBeCloseTo(37 / 77, 10);
    expect(Object.keys(rank.scores).sort()).toEqual(['A', 'B', 'isolated']);
    const file = cachePath(f.root, 'pagerank'); const bytes = await fs.readFile(file, 'utf8'); const stat = await fs.stat(file);
    expect(await readGlobalPageRank(f.uri)).toEqual(rank);
    expect(await authored(f.root)).toEqual(before);
    const e = (await readEntries(f.uri)).find(e => e.id === 'A')!;
    expect(await updateEntry(f.uri, 'A', { ...e, title: 'Renamed title' }, entityRevision(e))).toMatchObject({ status: 'updated' });
    expect(await readGlobalPageRank(f.uri)).toEqual(rank);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes); expect((await fs.stat(file)).mtimeMs).toBe(stat.mtimeMs);
    await clearCache(f.root, 'pagerank'); expect(await readGlobalPageRank(f.uri)).toEqual(rank);
    await fs.writeFile(file, 'bad'); expect(await readGlobalPageRank(f.uri)).toEqual(rank);
    await addRelationship(f.uri, { id: 'back', from: 'B', to: 'A', label: 'depends', metadata: null });
    const changed = await readGlobalPageRank(f.uri); expect(changed.graphInputHash).not.toBe(rank.graphInputHash);
    expect(changed.scores.A).toBeCloseTo(changed.scores.B, 12);
    expect(JSON.parse(await fs.readFile(join(f.root, '.SNL_Doc', entryEntityPath('_unpackaged', 'A')), 'utf8')).entry).not.toHaveProperty('pageRank');
  });
  it('rebuild leaves every Authoring byte unchanged and replaces legacy automatic rows only in reads', async () => {
    const f = await fixture(); const before = await authored(f.root);
    expect(await regenerateDependencyRelationships(f.uri, { entryIds: new Set(['A']) })).toMatchObject({ status: 'ok' });
    expect(await authored(f.root)).toEqual(before);
    expect((await readRelationships(f.uri)).map(r => r.id).sort()).toEqual(['context', 'manual']);
    expect(JSON.parse(await fs.readFile(join(f.root, '.SNL_Doc/.cache/dependencies/result.json'), 'utf8')).generator).toBe('dependencies');
  });
});
