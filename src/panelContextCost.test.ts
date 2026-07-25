import { describe, expect, it, vi } from 'vitest';

/**
 * Opening a panel used to re-read the whole workspace serially, and to walk
 * every macro package TWICE — once for `readAllMacros`, then again by hand to
 * rebuild the macro-name → package map. Cat 2026-07-25: "各个 Panel 开起来都
 * 非常慢".
 *
 * `readAllMacrosWithOrigin` returns both products of a single walk. These
 * tests pin the two properties that made the difference, using the real
 * module with a stubbed `vscode` file layer.
 */

const readCounts: Record<string, number> = {};
let inFlight = 0;
let maxConcurrent = 0;

const PACKAGES = ['alpha', 'beta', 'gamma', 'delta'];
// `core.json` sorts BEFORE `core-extra.json`, but bare `core-extra` sorts
// before `core` — so the two orderings pick different collision winners.
const COLLIDING = ['core', 'core-extra'];

vi.mock('vscode', () => {
  const file = 1;
  const encoder = new TextEncoder();
  const payloadFor = (name: string): string => {
    if (name === 'config.json') {
      return JSON.stringify({ active_macro_packages: [...PACKAGES, ...COLLIDING] });
    }
    const bare = name.replace(/\.json$/, '');
    if (COLLIDING.includes(bare)) {
      // Both declare the same macro name, so ordering decides the winner.
      return JSON.stringify({ name: bare, macros: [{ name: 'shared.macro' }] });
    }
    return JSON.stringify({
      name: bare,
      macros: [{ name: `${bare}.one` }, { name: `${bare}.two` }]
    });
  };
  return {
    Uri: {
      joinPath: (base: { path: string }, ...parts: string[]) => ({
        path: [base.path, ...parts].join('/'),
        fsPath: [base.path, ...parts].join('/')
      }),
      file: (p: string) => ({ path: p, fsPath: p })
    },
    FileType: { File: file, Directory: 2 },
    window: { createOutputChannel: () => undefined },
    workspace: {
      workspaceFolders: [{ uri: { path: '/ws', fsPath: '/ws' } }],
      fs: {
        readDirectory: async () =>
          [...PACKAGES, ...COLLIDING].map(
            (name) => [`${name}.json`, file] as [string, number]
          ),
        stat: async () => ({ type: file }),
        readFile: async (uri: { path: string }) => {
          const name = uri.path.split('/').pop() ?? '';
          readCounts[name] = (readCounts[name] ?? 0) + 1;
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return encoder.encode(payloadFor(name));
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
  inFlight = 0;
  maxConcurrent = 0;
}

describe('panel context cost', () => {
  it('reads each macro package exactly once', async () => {
    reset();
    const { readAllMacrosWithOrigin } = await loadModule();
    const root = { path: '/ws', fsPath: '/ws' } as never;
    const { macros, origin } = await readAllMacrosWithOrigin(root);

    // Both products come from ONE walk.
    expect(Object.keys(macros)).toHaveLength(PACKAGES.length * 2 + 1);
    expect(origin['alpha.one']).toBe('alpha');
    for (const name of [...PACKAGES, ...COLLIDING]) {
      expect(readCounts[`${name}.json`]).toBe(1);
    }
  });

  it('reads the packages concurrently, not one after another', async () => {
    reset();
    const { readAllMacrosWithOrigin } = await loadModule();
    await readAllMacrosWithOrigin({ path: '/ws', fsPath: '/ws' } as never);
    // Serial reads would peak at 1. Anything above proves overlap.
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('keeps last-write-wins deterministic despite concurrent reads', async () => {
    reset();
    const { readAllMacrosWithOrigin } = await loadModule();
    const first = await readAllMacrosWithOrigin({ path: '/ws', fsPath: '/ws' } as never);
    const second = await readAllMacrosWithOrigin({ path: '/ws', fsPath: '/ws' } as never);
    // I/O completion order must not change which package owns a name.
    expect(second.origin).toEqual(first.origin);
  });

  it('resolves a name collision by FILE order, as it always did', async () => {
    reset();
    const { readAllMacrosWithOrigin } = await loadModule();
    const { origin } = await readAllMacrosWithOrigin({ path: '/ws', fsPath: '/ws' } as never);
    // Under localeCompare `core-extra.json` < `core.json`, so last-write-wins
    // lands on `core`. Sorting by BARE name reverses it (`core` < `core-extra`)
    // and would silently hand the macro to a different package.
    // Review 2026-07-25.
    expect(origin['shared.macro']).toBe('core');
  });
});
