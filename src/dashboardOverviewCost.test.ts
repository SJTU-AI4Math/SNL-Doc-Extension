import { describe, expect, it, vi } from 'vitest';

/**
 * Dashboard open cost. Cat 2026-07-25: "所有 Dashboard 相关的基本都慢,
 * 具体 Library 的 Infoview 不慢" — so `readOverview` is the hot path, not the
 * per-library reads.
 *
 * `readOverview` used to:
 *   - read every macro package TWICE (once via `readMacroPackages` for the
 *     macroCount, once via `readMacroPackage` for the actual macro rows),
 *   - read `config.json` TWICE (once directly, once inside
 *     `resolveActiveMacroPackages`),
 *   - read every library's `meta.json` serially (`listLibraries`),
 *   - read every library's `graph.json` serially (`for` loop with `await`),
 *   - and run all of the above strictly one stage after another.
 *
 * These tests measure the real thing against a stubbed `vscode` file layer:
 * per-path readFile counts plus observed concurrency peaks. They also pin the
 * ORDER-DEPENDENT observable outputs, because the previous round of this work
 * showed that "make it concurrent" silently flips collision winners when the
 * fold order changes (`core-extra.json` < `core.json` under localeCompare, but
 * bare `core` < `core-extra`).
 */

const readCounts: Record<string, number> = {};
let inFlight = 0;
let maxConcurrent = 0;
const maxConcurrentBySuffix: Record<string, number> = {};
const inFlightBySuffix: Record<string, number> = {};

const ROOT = '/ws';
const SNL = `${ROOT}/.SNL_Doc`;

const PACKAGES = ['alpha', 'beta', 'core', 'core-extra'];
// Two libraries with a full pair of files, one deliberately broken (no
// graph.json) to pin the best-effort semantics.
const LIBRARIES = ['lib-a', 'lib-b', 'lib-bad'];

function libraryGraph(slug: string): string {
  return JSON.stringify({
    nodes: [
      { id: `${slug}-e1`, label: 'Entry' },
      { id: `${slug}-e2`, label: 'Entry' },
      // Duplicate id + a non-Entry node: neither must inflate entryCount.
      { id: `${slug}-e1`, label: 'Entry' },
      { id: `${slug}-s1`, label: 'Section' }
    ],
    relationships: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]
  });
}

function macroPackage(bare: string): string {
  if (bare === 'core' || bare === 'core-extra') {
    // Both declare `shared.macro`; whoever is folded LAST wins
    // `metricMacroSources`. Sorting by file name puts `core-extra.json`
    // before `core.json`, so `core` must win.
    return JSON.stringify({
      name: `pkg-${bare}`,
      macros: [
        { name: 'shared.macro', source: { entries: [`${bare}-entry`], urls: [] } },
        { name: `${bare}.only`, source: { entries: [], urls: [] } }
      ]
    });
  }
  return JSON.stringify({
    name: `pkg-${bare}`,
    macros: [
      { name: `${bare}.one`, kind: 'operator' },
      { name: `${bare}.two` }
    ]
  });
}

const FILES: Record<string, string> = {
  [`${SNL}/entries.json`]: JSON.stringify([
    { id: 'e1', title: 'One' },
    { id: 'e2', title: 'Two' }
  ]),
  [`${SNL}/config.json`]: JSON.stringify({
    active_macro_packages: ['alpha', 'core', 'core-extra'],
    entry_kinds: [{ id: 'k1', label: 'Def' }],
    macro_kinds: [{ id: 'mk1', label: 'Op' }]
  }),
  [`${SNL}/relationships.json`]: JSON.stringify({
    version: 1,
    relationships: [
      { id: 'r1', from: 'e1', to: 'e2', label: 'implies' }
    ]
  })
};
for (const bare of PACKAGES) {
  FILES[`${SNL}/term_macros/${bare}.json`] = macroPackage(bare);
}
for (const slug of LIBRARIES) {
  FILES[`${SNL}/libraries/${slug}/meta.json`] = JSON.stringify({
    title: `Title ${slug}`
  });
  if (slug !== 'lib-bad') {
    FILES[`${SNL}/libraries/${slug}/graph.json`] = libraryGraph(slug);
  }
}

const DIRS = new Set([
  ROOT,
  SNL,
  `${SNL}/term_macros`,
  `${SNL}/libraries`,
  ...LIBRARIES.map((s) => `${SNL}/libraries/${s}`)
]);

vi.mock('vscode', () => {
  const FileTypeFile = 1;
  const FileTypeDir = 2;
  const encoder = new TextEncoder();
  const join = (base: { path: string }, ...parts: string[]): string =>
    [base.path, ...parts].join('/');
  return {
    Uri: {
      joinPath: (base: { path: string }, ...parts: string[]) => ({
        path: join(base, ...parts),
        fsPath: join(base, ...parts)
      }),
      file: (p: string) => ({ path: p, fsPath: p })
    },
    FileType: { File: FileTypeFile, Directory: FileTypeDir },
    window: { createOutputChannel: () => undefined },
    workspace: {
      workspaceFolders: [{ uri: { path: ROOT, fsPath: ROOT } }],
      fs: {
        readDirectory: async (uri: { path: string }) => {
          if (uri.path === `${SNL}/term_macros`) {
            return PACKAGES.map(
              (n) => [`${n}.json`, FileTypeFile] as [string, number]
            );
          }
          if (uri.path === `${SNL}/libraries`) {
            return LIBRARIES.map((s) => [s, FileTypeDir] as [string, number]);
          }
          return [];
        },
        stat: async (uri: { path: string }) => {
          if (DIRS.has(uri.path)) return { type: FileTypeDir };
          if (FILES[uri.path] !== undefined) return { type: FileTypeFile };
          throw Object.assign(new Error('ENOENT'), { code: 'FileNotFound' });
        },
        readFile: async (uri: { path: string }) => {
          const path = uri.path;
          readCounts[path] = (readCounts[path] ?? 0) + 1;
          const suffix = path.split('/').pop() ?? '';
          inFlight += 1;
          inFlightBySuffix[suffix] = (inFlightBySuffix[suffix] ?? 0) + 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          maxConcurrentBySuffix[suffix] = Math.max(
            maxConcurrentBySuffix[suffix] ?? 0,
            inFlightBySuffix[suffix]
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          inFlightBySuffix[suffix] -= 1;
          const body = FILES[path];
          if (body === undefined) {
            throw Object.assign(new Error('ENOENT'), { code: 'FileNotFound' });
          }
          return encoder.encode(body);
        }
      }
    }
  };
});

async function loadModule(): Promise<typeof import('./snlDoc')> {
  return import('./snlDoc');
}

function reset(): void {
  for (const key of Object.keys(readCounts)) delete readCounts[key];
  for (const key of Object.keys(maxConcurrentBySuffix)) {
    delete maxConcurrentBySuffix[key];
  }
  for (const key of Object.keys(inFlightBySuffix)) {
    delete inFlightBySuffix[key];
  }
  inFlight = 0;
  maxConcurrent = 0;
}

const root = { path: ROOT, fsPath: ROOT } as never;

describe('readOverview I/O cost', () => {
  it('reads each macro package file exactly once', async () => {
    reset();
    const { readOverview } = await loadModule();
    await readOverview(root);
    for (const bare of PACKAGES) {
      expect(readCounts[`${SNL}/term_macros/${bare}.json`]).toBe(1);
    }
  });

  it('reads config.json exactly once', async () => {
    reset();
    const { readOverview } = await loadModule();
    await readOverview(root);
    expect(readCounts[`${SNL}/config.json`]).toBe(1);
  });

  it('reads each library file exactly once', async () => {
    reset();
    const { readOverview } = await loadModule();
    await readOverview(root);
    for (const slug of LIBRARIES) {
      expect(readCounts[`${SNL}/libraries/${slug}/meta.json`]).toBe(1);
    }
  });

  it('reads the library graphs concurrently, not one after another', async () => {
    reset();
    const { readOverview } = await loadModule();
    await readOverview(root);
    // Serial `for (…) await readJson(graph)` peaks at 1.
    expect(maxConcurrentBySuffix['graph.json']).toBeGreaterThan(1);
  });

  it('reads the library metas concurrently, not one after another', async () => {
    reset();
    const { readOverview } = await loadModule();
    await readOverview(root);
    expect(maxConcurrentBySuffix['meta.json']).toBeGreaterThan(1);
  });

  it('overlaps the independent top-level stages', async () => {
    reset();
    const { readOverview } = await loadModule();
    await readOverview(root);
    // Fully-staged execution peaks at the widest single stage (4 packages).
    // Overlapping entries/relationships/libraries/packages must beat that.
    expect(maxConcurrent).toBeGreaterThan(PACKAGES.length);
  });
});

describe('readOverview observable semantics', () => {
  it('keeps macroPackages sorted by file name with counts and active flags', async () => {
    reset();
    const { readOverview } = await loadModule();
    const overview = await readOverview(root);
    expect(overview.macroPackages.map((p) => p.file)).toEqual([
      'alpha.json',
      'beta.json',
      'core-extra.json',
      'core.json'
    ]);
    expect(overview.macroPackages.map((p) => p.macroCount)).toEqual([2, 2, 2, 2]);
    // config lists alpha/core/core-extra — beta is on disk but inactive.
    expect(overview.macroPackages.map((p) => p.active)).toEqual([
      true,
      false,
      true,
      true
    ]);
  });

  it('keeps allMacros sorted by packageFile then id', async () => {
    reset();
    const { readOverview } = await loadModule();
    const overview = await readOverview(root);
    expect(overview.allMacros.map((m) => `${m.packageFile}#${m.id}`)).toEqual([
      'alpha.json#alpha.one',
      'alpha.json#alpha.two',
      'beta.json#beta.one',
      'beta.json#beta.two',
      'core-extra.json#core-extra.only',
      'core-extra.json#shared.macro',
      'core.json#core.only',
      'core.json#shared.macro'
    ]);
    // packageName comes from the package's own `name` field, kind is only
    // present when the macro declares one.
    expect(overview.allMacros[0]).toEqual({
      id: 'alpha.one',
      packageFile: 'alpha.json',
      packageName: 'pkg-alpha',
      kind: 'operator'
    });
    expect(overview.allMacros[1]).toEqual({
      id: 'alpha.two',
      packageFile: 'alpha.json',
      packageName: 'pkg-alpha',
      kind: 'const'
    });
  });

  it('resolves metricMacroSources collisions by FILE order (last write wins)', async () => {
    reset();
    const { readOverview } = await loadModule();
    const overview = await readOverview(root);
    // Fold order is macroPackages order: …, core-extra.json, core.json.
    // So `core` writes last and owns the shared name. Folding by BARE name
    // (`core` < `core-extra`) would silently hand it to `core-extra`.
    expect(overview.metricMacroSources['shared.macro'].source.entries).toEqual([
      'core-entry'
    ]);
  });

  it('excludes inactive packages from metricMacroSources', async () => {
    reset();
    const { readOverview } = await loadModule();
    const overview = await readOverview(root);
    expect(overview.metricMacroSources['alpha.one']).toBeDefined();
    expect(overview.metricMacroSources['beta.one']).toBeUndefined();
    // …but inactive packages still appear in the search index.
    expect(overview.allMacros.some((m) => m.packageFile === 'beta.json')).toBe(
      true
    );
  });

  it('keeps libraries sorted by slug and degrades a broken one to null', async () => {
    reset();
    const { readOverview } = await loadModule();
    const overview = await readOverview(root);
    expect(overview.libraries).toEqual([
      {
        slug: 'lib-a',
        title: 'Title lib-a',
        entryCount: 2,
        relationshipCount: 3
      },
      {
        slug: 'lib-b',
        title: 'Title lib-b',
        entryCount: 2,
        relationshipCount: 3
      },
      // graph.json missing → best-effort nulls, dashboard still renders.
      {
        slug: 'lib-bad',
        title: 'Title lib-bad',
        entryCount: null,
        relationshipCount: null
      }
    ]);
  });

  it('still returns the rest of the snapshot', async () => {
    reset();
    const { readOverview } = await loadModule();
    const overview = await readOverview(root);
    expect(overview.hasSnlDoc).toBe(true);
    expect(overview.totalEntryCount).toBe(2);
    expect(overview.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(overview.entryKinds.map((k) => k.id)).toEqual(['k1']);
    expect(overview.macroKinds.map((k) => k.id)).toEqual(['mk1']);
    expect(overview.relationships.map((r) => r.id)).toEqual(['r1']);
  });
});
