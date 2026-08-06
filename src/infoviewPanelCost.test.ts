import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entryEntityPath } from './entityStorage';

/**
 * Infoview is the main READING surface, so it is the panel cat opens most.
 * Its pushes used to walk the workspace with a long serial `await` chain
 * (entries → kinds → counters → macros …), and `findActiveMacroPackage`
 * additionally read EVERY active macro package twice: once inside
 * `readMacroPackages` (which parses each file just to compute a macroCount it
 * then throws away) and once more in the per-package loop.
 *
 * Cat 2026-07-25: "各个 Panel 开起来都非常慢".
 *
 * These tests measure the real module against a stubbed `vscode` file layer:
 *  - `readCounts` proves no file is read twice per push.
 *  - `maxConcurrent` proves the independent reads actually overlap; a serial
 *    chain can never exceed 1.
 *  - the collision test pins the historical "last write wins" ordering, which
 *    is resolved on the FILE name (`core.json` < `core-extra.json`), NOT the
 *    bare name (`core-extra` < `core`). Concurrency must not flip it.
 */

const readCounts: Record<string, number> = {};
const directoryReadCounts: Record<string, number> = {};
let inFlight = 0;
let maxConcurrent = 0;
let entityMode = false;
let malformedEntityEnvelope = false;
let emptySecondEntitySnl = false;
let missingSecondEntity = false;
/** Messages the panel posted to its webview. */
const posted: Array<Record<string, unknown>> = [];
/** Commands the panel executed (used to observe findActiveMacroPackage). */
const commands: Array<{ command: string; args: unknown[] }> = [];
let dashboardGate: Promise<void> | null = null;
/** The panel's `onDidReceiveMessage` handler, captured at construction. */
let onMessage: ((message: unknown) => unknown) | null = null;
let panelTitle = '';
let configurationHandlers: Array<(event: { affectsConfiguration(key: string): boolean }) => void> = [];

const PACKAGES = ['alpha', 'beta', 'gamma', 'delta'];
// `core.json` sorts BEFORE `core-extra.json`, but bare `core-extra` sorts
// before `core` — the two orderings pick different collision winners.
const COLLIDING = ['core', 'core-extra'];
const ALL_PACKAGES = [...PACKAGES, ...COLLIDING];
const LIBRARY = 'algebra';

vi.mock('vscode', () => {
  const FileType = { File: 1, Directory: 2 };
  const encoder = new TextEncoder();

  const payloadFor = (path: string): string => {
    const name = path.split('/').pop() ?? '';
    if (path.includes('/term_macros/')) {
      const bare = name.replace(/\.json$/, '');
      if (COLLIDING.includes(bare)) {
        // Both declare the same macro name, so ordering decides the winner.
        return JSON.stringify({ name: bare, macros: [{ name: 'shared.macro' }] });
      }
      return JSON.stringify({
        name: bare,
        macros: [{ name: `${bare}.one` }, { name: `${bare}.two` }]
      });
    }
    switch (name) {
      case 'config.json':
        return JSON.stringify({
          version: entityMode ? '0.0.6' : '0.0.4',
          active_macro_packages: entityMode ? [] : ALL_PACKAGES,
          entry_kinds: [{ id: 'k1', name: 'Definition', defaultCounterName: 'c' }],
          macro_kinds: [{ id: 'mk1', name: 'Operator' }]
        });
      case 'entries.json':
        return JSON.stringify([
          { id: 'e1', title: 'First', kind: 'k1', content: { snl: 'x' } },
          { id: 'e2', title: 'Second', kind: 'k1', content: { snl: 'y' } }
        ]);
      case 'relationships.json':
        return JSON.stringify({
          version: 1,
          relationships: [
            { id: 'r1', from: 'e1', to: 'e2', label: 'depends' }
          ]
        });
      case 'meta.json':
        return JSON.stringify({ title: 'Algebra', description: 'demo' });
      case 'graph.json':
        return JSON.stringify({
          nodes: [{ id: 'n1', label: 'Entry', props: { entryId: 'e1' } }],
          relationships: []
        });
      case 'counters.json':
        return JSON.stringify({ counters: [{ id: 'c', name: 'c', children: [] }] });
      default:
        if (path.includes('/entries/')) {
          const e1File = entryEntityPath('logic', 'e1').split('/').pop();
          const id = name === e1File ? 'e1' : 'e2';
          return JSON.stringify(malformedEntityEnvelope
            ? { format: 'snl-entry', version: 999, package: 'logic', entry: { id, package: 'logic' } }
            : {
                format: 'snl-entry', version: 1, package: 'logic',
                entry: { id, package: 'logic', title: id === 'e1' ? 'First' : 'Second', kind: 'k1', content: { snl: id === 'e1' ? 'x' : emptySecondEntitySnl ? '' : 'y' } }
              });
        }
        return '{}';
    }
  };

  const joinPath = (base: { path: string }, ...parts: string[]) => {
    const path = [base.path, ...parts].join('/');
    return { path, fsPath: path, toString: () => path };
  };

  return {
    Uri: { joinPath, file: (p: string) => ({ path: p, fsPath: p, toString: () => p }) },
    FileType,
    ViewColumn: { Beside: 2, One: 1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    env: { language: 'en' },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        commands.push({ command, args });
        if (command === 'snlDoc.openDashboard' && dashboardGate) {
          await dashboardGate;
        }
      }
    },
    window: {
      activeColorTheme: { kind: 2 },
      createOutputChannel: () => ({ appendLine: () => undefined }),
      showErrorMessage: (msg: string) => {
        throw new Error(`unexpected showErrorMessage: ${msg}`);
      },
      showWarningMessage: async () => undefined,
      onDidChangeActiveColorTheme: () => ({ dispose: () => undefined }),
      createWebviewPanel: (_type: string, title: string) => {
        panelTitle = title;
        return {
        get title() { return panelTitle; },
        set title(value: string) { panelTitle = value; },
        webview: {
          html: '',
          cspSource: 'vscode-webview:',
          asWebviewUri: (u: { toString(): string }) => u,
          postMessage: (m: Record<string, unknown>) => {
            posted.push(m);
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (h: (message: unknown) => unknown) => {
            onMessage = h;
            return { dispose: () => undefined };
          }
        },
        onDidDispose: () => ({ dispose: () => undefined }),
        reveal: () => undefined,
        dispose: () => undefined
        };
      }
    },
    workspace: {
      workspaceFolders: [{ uri: { path: '/ws', fsPath: '/ws', toString: () => '/ws' } }],
      getConfiguration: () => ({ get: () => undefined }),
      onDidChangeConfiguration: (handler: (event: { affectsConfiguration(key: string): boolean }) => void) => {
        configurationHandlers.push(handler);
        return { dispose: () => undefined };
      },
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose: () => undefined }),
        onDidChange: () => ({ dispose: () => undefined }),
        onDidDelete: () => ({ dispose: () => undefined }),
        dispose: () => undefined
      }),
      fs: {
        readDirectory: async (uri: { path: string }) => {
          directoryReadCounts[uri.path] = (directoryReadCounts[uri.path] ?? 0) + 1;
          if (uri.path.endsWith('/entries') && entityMode) {
            return [
              [entryEntityPath('logic', 'e1').split('/').pop()!, FileType.File],
              [entryEntityPath('logic', 'e2').split('/').pop()!, FileType.File]
            ] as Array<[string, number]>;
          }
          if (uri.path.endsWith('/term_macros')) {
            return ALL_PACKAGES.map(
              (name) => [`${name}.json`, FileType.File] as [string, number]
            );
          }
          if (uri.path.endsWith('/libraries')) {
            return [[LIBRARY, FileType.Directory] as [string, number]];
          }
          return [];
        },
        stat: async () => ({ type: FileType.File }),
        readFile: async (uri: { path: string }) => {
          const name = uri.path.split('/').pop() ?? '';
          readCounts[name] = (readCounts[name] ?? 0) + 1;
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          if (missingSecondEntity && uri.path.includes('/entries/') &&
              name === entryEntityPath('logic', 'e2').split('/').pop()) {
            throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
          }
          return encoder.encode(payloadFor(uri.path));
        }
      }
    }
  };
});

async function loadPanel(): Promise<typeof import('./infoviewPanel')> {
  return import('./infoviewPanel');
}

const extensionUri = { path: '/ext', fsPath: '/ext', toString: () => '/ext' } as never;

function reset(): void {
  for (const key of Object.keys(readCounts)) delete readCounts[key];
  for (const key of Object.keys(directoryReadCounts)) delete directoryReadCounts[key];
  inFlight = 0;
  maxConcurrent = 0;
  entityMode = false;
  malformedEntityEnvelope = false;
  emptySecondEntitySnl = false;
  missingSecondEntity = false;
  posted.length = 0;
  commands.length = 0;
  dashboardGate = null;
  onMessage = null;
  panelTitle = '';
  configurationHandlers = [];
}

/** Open the singleton browser panel fresh and return its message pump. */
async function openBrowser(initialLibrarySlug?: string): Promise<(message: unknown) => Promise<void>> {
  const { InfoviewPanel } = await loadPanel();
  // The browser panel is a singleton; drop any instance a prior test left.
  (InfoviewPanel as unknown as { browserPanel: unknown }).browserPanel = undefined;
  InfoviewPanel.createOrShow(extensionUri, initialLibrarySlug);
  const handler = onMessage;
  if (!handler) throw new Error('panel did not register a message handler');
  return async (message: unknown) => {
    await handler(message);
  };
}

describe('infoview panel read cost', () => {
  beforeEach(() => {
    reset();
  });

  it('keeps the resolved Entry display title across a locale refresh', async () => {
    const { InfoviewPanel } = await loadPanel();
    InfoviewPanel.panels.clear();
    InfoviewPanel.createOrShowForEntry(extensionUri, 'e1');
    if (!onMessage) throw new Error('entry panel did not register a message handler');
    await onMessage({ type: 'ready' });
    expect(panelTitle).toBe('SNL — First');

    configurationHandlers.at(-1)?.({ affectsConfiguration: (key) => key === 'snlDoc.locale' });
    expect(panelTitle).toBe('SNL — First');
  });

  it('opens a requested Library directly on first ready', async () => {
    const send = await openBrowser(LIBRARY);
    reset();
    await send({ type: 'ready' });
    expect(posted.some((message) => message.type === 'libraryEntries' && message.slug === LIBRARY)).toBe(true);
    expect(posted.some((message) => message.type === 'libraries')).toBe(false);
  });

  it('clears direct Library navigation when the Infoview goes back', async () => {
    const send = await openBrowser(LIBRARY);
    await send({ type: 'ready' });
    reset();

    await send({ type: 'back' });
    expect(posted.some((message) => message.type === 'libraries')).toBe(true);
    expect(posted.some((message) => message.type === 'libraryEntries')).toBe(false);

    reset();
    await send({ type: 'ready' });
    expect(posted.some((message) => message.type === 'libraries')).toBe(true);
    expect(posted.some((message) => message.type === 'libraryEntries')).toBe(false);
  });

  it('reads no file twice when pushing a library outline', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'selectLibrary', slug: LIBRARY });

    expect(posted.some((m) => m.type === 'libraryEntries')).toBe(true);
    for (const [name, count] of Object.entries(readCounts)) {
      // config.json legitimately backs several independent catalogs
      // (entry_kinds / macro_kinds / active packages); everything else must
      // be read exactly once per push.
      if (name === 'config.json') continue;
      expect(count, `${name} read ${count}x`).toBe(1);
    }
  });

  it('overlaps the independent reads of a library outline', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'selectLibrary', slug: LIBRARY });
    // A serial `await` chain can never push more than one read in flight.
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('overlaps the independent reads of the single-entry payload', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'selectEntry', id: 'e1' });
    expect(posted.some((m) => m.type === 'entryDetails')).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('overlaps the independent reads of a popover payload', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'requestEntryDetails', entryId: 'e1' });
    expect(posted.some((m) => m.type === 'popoverEntryDetails')).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('point-reads exactly one current-storage entity for a popover', async () => {
    const send = await openBrowser();
    reset();
    entityMode = true;

    await send({ type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic' });

    const entityPath = entryEntityPath('logic', 'e1');
    expect(posted).toContainEqual(expect.objectContaining({
      type: 'popoverEntryDetails', entryId: 'e1',
      entry: expect.objectContaining({ id: 'e1', package: 'logic' })
    }));
    expect(readCounts[entityPath.split('/').pop()!]).toBe(1);
    expect(directoryReadCounts['/ws/.SNL_Doc/entries'] ?? 0).toBe(0);
  });

  it('ships package identity for current-storage Entries outside the Library outline', async () => {
    const send = await openBrowser();
    reset();
    entityMode = true;

    await send({ type: 'selectLibrary', slug: LIBRARY });

    expect(posted).toContainEqual(expect.objectContaining({
      type: 'libraryEntries',
      // e2 is in the shared pool but deliberately absent from graph.json.
      entryPackages: { e1: 'logic', e2: 'logic' }
    }));
  });

  it('ships package identity for Entries omitted from the per-entry SNL-only pool', async () => {
    const { InfoviewPanel } = await loadPanel();
    reset();
    entityMode = true;
    emptySecondEntitySnl = true;
    InfoviewPanel.panels.clear();
    InfoviewPanel.createOrShowForEntry(extensionUri, 'e1');
    if (!onMessage) throw new Error('entry panel did not register a message handler');

    await onMessage({ type: 'ready' });

    const payload = posted.find((message) => message.type === 'entryDetails');
    expect(payload?.entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'e2' })
    ]));
    expect(payload?.entryPackages).toEqual({ e1: 'logic', e2: 'logic' });
  });

  it('posts a terminal error for a current-storage request missing package identity', async () => {
    const send = await openBrowser();
    reset();
    entityMode = true;

    await expect(send({ type: 'requestEntryDetails', entryId: 'e2' }))
      .rejects.toThrow(/missing its package identity/);

    expect(posted).toContainEqual(expect.objectContaining({
      type: 'popoverEntryDetailsError',
      entryId: 'e2',
      message: expect.stringMatching(/missing its package identity/)
    }));
    expect(directoryReadCounts['/ws/.SNL_Doc/entries'] ?? 0).toBe(0);
  });

  it('posts a correlated terminal not-found response when the exact entity is missing', async () => {
    const send = await openBrowser();
    reset();
    entityMode = true;
    missingSecondEntity = true;

    await send({
      type: 'requestEntryDetails', entryId: 'e2', entryPackage: 'logic'
    });

    expect(posted).toContainEqual({
      type: 'popoverEntryDetails', entryId: 'e2', entry: null, kind: null
    });
    expect(directoryReadCounts['/ws/.SNL_Doc/entries'] ?? 0).toBe(0);
  });

  it('posts one correlated terminal response for every concurrent request', async () => {
    const send = await openBrowser();
    reset();
    entityMode = true;

    await Promise.all([
      send({ type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic' }),
      send({ type: 'requestEntryDetails', entryId: 'e2', entryPackage: 'logic' })
    ]);

    expect(posted.filter((message) => message.type === 'popoverEntryDetails')
      .map((message) => message.entryId).sort()).toEqual(['e1', 'e2']);
    expect(directoryReadCounts['/ws/.SNL_Doc/entries'] ?? 0).toBe(0);
  });

  it('fails closed when the exact current-storage entity has a malformed envelope', async () => {
    const send = await openBrowser();
    reset();
    entityMode = true;
    malformedEntityEnvelope = true;

    await expect(send({
      type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic'
    })).rejects.toThrow(/valid SNL Entry envelope/);

    expect(posted).toContainEqual(expect.objectContaining({
      type: 'popoverEntryDetailsError',
      entryId: 'e1',
      message: expect.stringMatching(/valid SNL Entry envelope/)
    }));
    expect(posted.some((message) => message.type === 'popoverEntryDetails')).toBe(false);
    expect(directoryReadCounts['/ws/.SNL_Doc/entries'] ?? 0).toBe(0);
  });

  it('waits for the Dashboard before opening the Entry editor', async () => {
    const send = await openBrowser();
    let releaseDashboard!: () => void;
    dashboardGate = new Promise<void>((resolve) => { releaseDashboard = resolve; });

    const navigation = send({ type: 'openDashboardForEntry', entryId: 'e1' });
    await Promise.resolve();
    expect(commands.map(({ command }) => command)).toEqual(['snlDoc.openDashboard']);

    releaseDashboard();
    await navigation;
    expect(commands.map(({ command }) => command)).toEqual([
      'snlDoc.openDashboard',
      'snlDoc.editEntry'
    ]);
  });

  it('reads each macro package once when resolving a macro owner', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'editMacro', name: 'alpha.one' });

    expect(commands.map((c) => c.command)).toContain('snlDoc.editMacro');
    for (const name of ALL_PACKAGES) {
      // The old path read every package twice: once inside readMacroPackages
      // (to compute a discarded macroCount) and once in the resolution loop.
      expect(readCounts[`${name}.json`], `${name}.json`).toBe(1);
    }
  });

  it('reads the macro packages concurrently when resolving a macro owner', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'editMacro', name: 'alpha.one' });
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('resolves a macro-name collision by FILE order, as it always did', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'editMacro', name: 'shared.macro' });

    const call = commands.find((c) => c.command === 'snlDoc.editMacro');
    expect(call).toBeDefined();
    // `readMacroPackages` sorted on `summary.file`, so under localeCompare
    // `core-extra.json` < `core.json` and last-write-wins landed on `core`.
    // Sorting the bare names instead reverses it and silently hands the macro
    // to a different package. Review 2026-07-25.
    expect(call?.args[0]).toBe('core');
  });

  it('is stable across repeated resolutions despite concurrent I/O', async () => {
    const send = await openBrowser();
    for (let i = 0; i < 4; i++) {
      reset();
      await send({ type: 'editMacro', name: 'shared.macro' });
      expect(
        commands.find((c) => c.command === 'snlDoc.editMacro')?.args[0]
      ).toBe('core');
    }
  });

  it('still resolves nothing for an unknown macro name', async () => {
    const send = await openBrowser();
    reset();
    await send({ type: 'editMacro', name: 'no.such.macro' });
    expect(commands.find((c) => c.command === 'snlDoc.editMacro')).toBeUndefined();
  });
});
