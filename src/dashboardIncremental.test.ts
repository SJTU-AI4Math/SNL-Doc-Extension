import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as os from 'node:os';

const probe = vi.hoisted(() => ({
  reads: [] as string[], stats: [] as string[], directories: [] as string[],
  failSuffix: '',
  inFlight: 0, peak: 0, gate: undefined as Promise<void> | undefined
}));
vi.mock('vscode', () => {
  const io = require('node:fs/promises') as typeof import('node:fs/promises');
  const paths = require('node:path') as typeof import('node:path');
  class Uri {
    constructor(public path: string) {}
    get fsPath() { return this.path; }
    readonly scheme = 'file';
    toString() { return `file:${this.path}`; }
    static file(p: string) { return new Uri(p); }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri(paths.join(base.path, ...parts)); }
  }
  return { Uri, FileType: { File: 1, Directory: 2 }, workspace: { fs: {
    stat: async (uri: Uri) => { if (probe.failSuffix && uri.path.endsWith(probe.failSuffix)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); probe.stats.push(uri.path); const stat = await io.stat(uri.path); return { type: stat.isDirectory() ? 2 : 1 }; },
    readDirectory: async (uri: Uri) => {
      if (probe.failSuffix && uri.path.endsWith(probe.failSuffix)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      probe.directories.push(uri.path);
      return (await io.readdir(uri.path, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? 2 : 1]);
    },
    readFile: async (uri: Uri) => {
      if (probe.failSuffix && uri.path.endsWith(probe.failSuffix)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      probe.reads.push(uri.path);
      probe.peak = Math.max(probe.peak, ++probe.inFlight);
      try {
        if (uri.path.includes('/entries/') || uri.path.includes('/macros/')) await probe.gate;
        return await io.readFile(uri.path);
      } finally { --probe.inFlight; }
    }
  } } };
});

import * as vscode from 'vscode';
import { readDashboardCatalog } from './snlDoc';
import { readDashboardStatistics, readDashboardRelationships } from './dashboardStatistics';
import { entryEntityPath, macroEntityPath, makeEntryEnvelope, makeMacroEnvelope, makePackageManifest, packageManifestPath } from './entityStorage';

let root: string;
const resetProbe = () => { probe.reads = []; probe.stats = []; probe.directories = []; probe.peak = 0; };
const write = async (relative: string, data: unknown) => {
  const target = nodePath.join(root, '.SNL_Doc', relative);
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(data));
};
async function fixture(count: number) {
  await write('config.json', { version: '0.1.0', entry_kinds: [], macro_kinds: [], active_macro_packages: ['Logic'] });
  const ids = Array.from({ length: count }, (_, i) => `entry.${String(i).padStart(5, '0')}`);
  await write(packageManifestPath('_unpackaged'), makePackageManifest('_unpackaged', 'Unpackaged', ''));
  await write(packageManifestPath('Logic'), makePackageManifest('Logic', 'Logic', 'Package navigation', ids));
  for (let offset = 0; offset < ids.length; offset += 32) {
    await Promise.all(ids.slice(offset, offset + 32).map(id => write(entryEntityPath('Logic', id), makeEntryEnvelope('Logic', {
      id, package: 'Logic', kind: 'definition', title: `Title ${id}`, content: { snl: 'secret body' }, pointer: null
    }))));
  }
  await write(macroEntityPath('Logic', 'logic.one'), makeMacroEnvelope('Logic', {
    name: 'logic.one', description: '', source: { entries: [], urls: [] }, kind: 'const', dynamic_arity: false, tags: [],
    styles: [{ style_name: 'default', template: { mode: 'formula_inline', body: 'x' }, tags: [] }]
  }));
  await write('libraries/demo/meta.json', { title: 'Demo' });
  await write('libraries/demo/graph.json', { nodes: [ { id: ids[0], label: 'Entry' }, { id: ids[0], label: 'Entry' } ], relationships: [] });
  await write('relationships.json', { version: 1, relationships: [{ id: 'r1', from: ids[0], to: ids[1], label: 'implies', metadata: null }] });
  resetProbe();
}

beforeEach(async () => { root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'dashboard-catalog-')); probe.gate = undefined; probe.failSuffix = ''; resetProbe(); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('real filesystem Dashboard catalog and incremental scans', () => {
  it.each([100, 9000])('opens a fixed two-Package catalog with %i Entries without reading entity or graph content', async count => {
    await fixture(count);
    const start = performance.now();
    const catalog = await readDashboardCatalog(vscode.Uri.file(root));
    const milliseconds = performance.now() - start;
    expect(catalog.dataStatus.status).toBe('unchecked');
    expect(catalog.entryPackages).toHaveLength(2);
    expect(catalog.entryPackages.every(pkg => pkg.entryCount === null)).toBe(true);
    expect(catalog.libraries).toEqual([{ slug: 'demo', title: 'Demo', entryCount: null, relationshipCount: null }]);
    expect(probe.reads.map(p => nodePath.relative(nodePath.join(root, '.SNL_Doc'), p)).sort()).toEqual([
      'config.json', 'libraries/demo/meta.json', packageManifestPath('Logic'), packageManifestPath('_unpackaged')
    ].sort());
    for (const touched of [...probe.reads, ...probe.stats, ...probe.directories]) {
      expect(touched).not.toMatch(/\/(entries|macros)(\/|$)|graph\.json|relationships\.json|term_macros/);
    }
    expect(catalog).not.toHaveProperty('entries');
    expect(catalog).not.toHaveProperty('allMacros');
    console.info(JSON.stringify({ phase: 'catalog', entries: count, packages: 2, readFiles: probe.reads.length, milliseconds }));
  });

  it('counts accurately in bounded responsive batches and sends summaries, not record pools', async () => {
    await fixture(512);
    const catalog = await readDashboardCatalog(vscode.Uri.file(root));
    resetProbe();
    let observedDuringScan = false;
    const timer = setInterval(() => {
      const n = probe.reads.filter(p => p.includes('/entries/')).length;
      if (n > 0 && n < 512) observedDuringScan = true;
    }, 0);
    const start = performance.now();
    let statistics;
    try { statistics = await readDashboardStatistics(vscode.Uri.file(root), catalog, new AbortController().signal); }
    finally { clearInterval(timer); }
    expect(statistics).toEqual({ totalEntryCount: 512,
      entryPackages: [{ id: '_unpackaged', entryCount: 0 }, { id: 'Logic', entryCount: 512 }],
      macroPackages: [{ file: 'Logic.json', macroCount: 1 }], relationshipCount: 1,
      libraries: [{ slug: 'demo', entryCount: 1, relationshipCount: 0 }] });
    expect(probe.peak).toBeLessThanOrEqual(8);
    expect(observedDuringScan).toBe(true);
    expect(JSON.stringify(statistics)).not.toMatch(/secret body|allMacros|entry\.000/);
    console.info(JSON.stringify({ phase: 'statistics', entries: 512, readFiles: probe.reads.length, peak: probe.peak, milliseconds: performance.now() - start }));
  });

  it.each(['/entries', '/macros', '/relationships.json'])('does not report false zero when %s is unreadable', async suffix => {
    await fixture(10);
    const catalog = await readDashboardCatalog(vscode.Uri.file(root));
    probe.failSuffix = suffix;
    await expect(readDashboardStatistics(vscode.Uri.file(root), catalog, new AbortController().signal)).rejects.toThrow('permission denied');
  });

  it('aborts after the in-flight batch without starting later files', async () => {
    await fixture(100);
    const catalog = await readDashboardCatalog(vscode.Uri.file(root));
    resetProbe();
    let release!: () => void;
    probe.gate = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const task = readDashboardStatistics(vscode.Uri.file(root), catalog, controller.signal);
    const rejected = expect(task).rejects.toThrow();
    await vi.waitFor(() => expect(probe.inFlight).toBe(8));
    controller.abort();
    release();
    await rejected;
    expect(probe.inFlight).toBe(0);
    expect(probe.reads).toHaveLength(8);
  });

  it('defers relationship bodies and returns only referenced endpoint titles', async () => {
    await fixture(100);
    await readDashboardCatalog(vscode.Uri.file(root));
    expect(probe.reads.some(p => p.endsWith('/relationships.json'))).toBe(false);
    const result = await readDashboardRelationships(vscode.Uri.file(root), new AbortController().signal);
    expect(result.relationships).toHaveLength(1);
    expect(result.entries).toEqual([
      { id: 'entry.00000', title: 'Title entry.00000' },
      { id: 'entry.00001', title: 'Title entry.00001' }
    ]);
    expect(JSON.stringify(result)).not.toContain('secret body');
  });

  it.each([['0.0.11', 'needsMigration'], ['99.0.0', 'future'], ['not-semver', 'invalid']])('reports version %s without a topology scan', async (version, status) => {
    await fixture(100);
    await write('config.json', { version, entry_kinds: [], macro_kinds: [] });
    const catalog = await readDashboardCatalog(vscode.Uri.file(root));
    expect(catalog.dataStatus.status).toBe(status);
    expect(probe.reads.some(p => p.includes('/entries/'))).toBe(false);
  });

  it('distinguishes missing workspace data from corrupt config', async () => {
    expect((await readDashboardCatalog(vscode.Uri.file(root))).hasSnlDoc).toBe(false);
    await write('config.json', null);
    const corrupt = await readDashboardCatalog(vscode.Uri.file(root));
    expect(corrupt.hasSnlDoc).toBe(true);
    expect(corrupt.dataStatus.status).toBe('invalid');
  });
});
