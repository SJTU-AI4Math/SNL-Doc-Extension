import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMacroEnvelope, makePackageManifest, macroEntityPath, packageManifestPath } from './entityStorage';

const PACKAGE_COUNT = 24;
const packageIds = Array.from({ length: PACKAGE_COUNT }, (_, index) => `pkg-${String(index).padStart(2, '0')}`);
const jsonByPath = new Map<string, unknown>();
function seedCurrentTopology(): void {
  jsonByPath.clear();
  for (const id of packageIds) {
    jsonByPath.set(`packages/${packageManifestPath(id).slice('packages/'.length)}`, makePackageManifest(id, id.toUpperCase(), ''));
    const name = `macro.${id}`;
    jsonByPath.set(`macros/${macroEntityPath(id, name).slice('macros/'.length)}`, makeMacroEnvelope(id, {
      name,
      description: '',
      source: { entries: [], urls: [] },
      dynamic_arity: false,
      kind: 'const',
      styles: [{ style_name: 'default', mode: 'formula_inline', template: name, tags: [] }],
      tags: []
    }));
  }
  jsonByPath.set('config.json', {
    version: '0.0.8',
    macro_kinds: [],
    active_macro_packages: packageIds
  });
}
seedCurrentTopology();

const state = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => Promise<void>) | undefined,
  posted: [] as Array<Record<string, unknown>>,
  snapshotCalls: 0,
  directoryReads: [] as string[],
  entityReads: [] as string[],
  entityInFlight: 0,
  maxEntityInFlight: 0
}));

function relativePath(uri: { path: string }): string {
  return uri.path.replace(/^\/ws\/.SNL_Doc\/?/, '');
}

vi.mock('vscode', () => ({
  ColorThemeKind: { Dark: 2 },
  FileType: { File: 1, Directory: 2 },
  env: { language: 'en' },
  Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
  ViewColumn: { Active: -1 },
  RelativePattern: class {},
  commands: { executeCommand: async () => undefined },
  window: {
    activeColorTheme: { kind: 2 },
    createOutputChannel: () => undefined,
    createWebviewPanel: () => ({
      webview: {
        html: '',
        postMessage: async (message: Record<string, unknown>) => { state.posted.push(message); return true; },
        onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
          state.receive = handler;
          return { dispose: () => undefined };
        }
      },
      reveal: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      dispose: () => undefined
    }),
    showWarningMessage: async () => undefined
  },
  workspace: {
    fs: {
      stat: async (uri: { path: string }) => {
        const relative = relativePath(uri);
        if (
          relative === 'config.json' || jsonByPath.has(relative) ||
          [...jsonByPath.keys()].some((path) => path.startsWith(`${relative}/`))
        ) return {};
        throw new Error(`ENOENT: ${relative}`);
      },
      readDirectory: async (uri: { path: string }) => {
        const directory = relativePath(uri);
        state.directoryReads.push(directory);
        return [...jsonByPath.keys()]
          .filter((path) => path.startsWith(`${directory}/`))
          .map((path) => [path.slice(directory.length + 1), 1] as [string, number]);
      },
      readFile: async (uri: { path: string }) => {
        const relative = relativePath(uri);
        state.entityReads.push(relative);
        state.entityInFlight += 1;
        state.maxEntityInFlight = Math.max(state.maxEntityInFlight, state.entityInFlight);
        await new Promise((resolve) => setTimeout(resolve, relative.includes('pkg-00') ? 3 : 1));
        state.entityInFlight -= 1;
        return new TextEncoder().encode(JSON.stringify(jsonByPath.get(relative)));
      }
    },
    getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  }
}));

vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/ws' }),
  handlePanelNavMessage: async () => false,
  installSnlDocWatcher: () => undefined
}));

vi.mock('./snlDoc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snlDoc')>();
  return {
    ...actual,
    readPackageMacroSnapshot: async (...args: Parameters<typeof actual.readPackageMacroSnapshot>) => {
      state.snapshotCalls += 1;
      return actual.readPackageMacroSnapshot(...args);
    },
    readPackagePanelSnapshot: async () => {
      state.snapshotCalls += 1;
      return {
        selected: { status: 'ok', pkg: { version: '8', name: 'Current', macros: {} }, macros: [] },
        workspaceMacros: {},
        macroKinds: [],
        active: ['current', 'alpha', 'beta'],
        otherPackages: [{ file: 'alpha', name: 'ALPHA' }, { file: 'beta', name: 'BETA' }]
      };
    },
    readMacroPackage: async () => { throw new Error('PackagePanel must not perform per-package reads'); },
    readAllMacros: async () => { throw new Error('PackagePanel must not start a second macro scan'); },
    resolveActiveMacroPackages: async () => { throw new Error('PackagePanel must derive active packages from its snapshot'); },
    readMacroKinds: async () => { throw new Error('PackagePanel must derive macro kinds from its snapshot config'); },
    readEntries: async () => [],
    setMacroPackageActive: async () => undefined,
    batchDeleteMacros: async () => ({ status: 'ok' }),
    batchMoveMacros: async () => ({ status: 'ok' }),
    batchCopyMacros: async () => ({ status: 'ok' }),
    batchPackageAsNew: async () => ({ status: 'ok' }),
    batchMoveToNewPackage: async () => ({ status: 'ok' })
  };
});

const extensionUri = { path: '/ext' } as never;

describe('PackagePanel read cost', () => {
  beforeEach(() => {
    seedCurrentTopology();
    state.receive = undefined;
    state.posted.length = 0;
    state.snapshotCalls = 0;
    state.directoryReads.length = 0;
    state.entityReads.length = 0;
    state.entityInFlight = 0;
    state.maxEntityInFlight = 0;
  });

  it('uses one operation-local snapshot for the selected package and all derived package data', async () => {
    const { PackagePanel } = await import('./packagePanel');
    (PackagePanel as unknown as { panels: Map<string, unknown> }).panels.clear();
    PackagePanel.createOrShow(extensionUri, 'current.json');

    await state.receive?.({ type: 'ready' });

    expect(state.snapshotCalls).toBe(1);
    const payload = state.posted.find(({ type }) => type === 'package');
    expect(payload?.otherPackages).toEqual([
      { file: 'alpha', name: 'ALPHA' },
      { file: 'beta', name: 'BETA' }
    ]);
  });

  it('uses one current-storage Package/Macro snapshot per SNoogL query', async () => {
    const { SnoogLPanel } = await import('./snooglPanel');
    (SnoogLPanel as unknown as { instance: { dispose(): void } | null }).instance?.dispose();
    SnoogLPanel.open(extensionUri, 'macro');

    await state.receive?.({ type: 'ready' });

    expect(state.snapshotCalls).toBe(1);
    expect(state.directoryReads.filter((path) => path === 'packages')).toHaveLength(1);
    expect(state.directoryReads.filter((path) => path === 'macros')).toHaveLength(1);
    expect(state.entityReads.filter((path) => path.startsWith('packages/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.entityReads.filter((path) => path.startsWith('macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('lists and reads every Package/Macro entity at most once with bounded fan-out', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');
    const snapshot = await actual.readPackagePanelSnapshot({ path: '/ws' } as never, 'pkg-00');

    expect(snapshot.selected.status).toBe('ok');
    expect(Object.keys(snapshot.workspaceMacros)).toHaveLength(PACKAGE_COUNT);
    expect(state.directoryReads.sort()).toEqual(['macros', 'packages']);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.entityReads.filter((path) => path.startsWith('packages/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.entityReads.filter((path) => path.startsWith('macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.maxEntityInFlight).toBeGreaterThan(1);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('gives readAllMacros the same single-snapshot P-package/M-macro read cost', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const macros = await actual.readAllMacros({ path: '/ws' } as never);

    expect(Object.keys(macros)).toHaveLength(PACKAGE_COUNT);
    expect(state.directoryReads.sort()).toEqual(['macros', 'packages']);
    expect(state.entityReads.filter((path) => path.startsWith('packages/'))).toHaveLength(PACKAGE_COUNT);
    expect(state.entityReads.filter((path) => path.startsWith('macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('folds collisions deterministically in file order and exposes the winning origin', async () => {
    jsonByPath.clear();
    jsonByPath.set('config.json', {
      version: '0.0.8', macro_kinds: [], active_macro_packages: ['core', 'core-extra']
    });
    for (const id of ['core', 'core-extra']) {
      jsonByPath.set(`packages/${packageManifestPath(id).slice('packages/'.length)}`, makePackageManifest(id, id, ''));
      jsonByPath.set(`macros/${macroEntityPath(id, 'Shared.name').slice('macros/'.length)}`, makeMacroEnvelope(id, {
        name: 'Shared.name',
        description: id,
        source: { entries: [], urls: [] },
        dynamic_arity: false,
        kind: 'const',
        styles: [{ style_name: 'default', mode: 'formula_inline', template: id, tags: [] }],
        tags: []
      }));
    }
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readPackageMacroSnapshot({ path: '/ws' } as never);

    expect(snapshot.activePackages.map(({ file }) => file)).toEqual(['core-extra', 'core']);
    expect(snapshot.macroOrigins['Shared.name']).toBe('core');
    expect(snapshot.workspaceMacros['Shared.name'].description).toBe('core');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.workspaceMacros)).toBe(true);
  });

  it('uses the same one-read snapshot contract for legacy package files', async () => {
    jsonByPath.clear();
    const legacyIds = Array.from({ length: PACKAGE_COUNT }, (_, index) => `legacy-${String(index).padStart(2, '0')}`);
    jsonByPath.set('config.json', {
      version: '0.0.5',
      macro_kinds: [],
      active_macro_packages: legacyIds
    });
    for (const id of legacyIds) {
      jsonByPath.set(`term_macros/${id}.json`, {
        version: '8',
        name: id.toUpperCase(),
        macros: {
          [`macro.${id}`]: {
            description: '',
            source: { entries: [], urls: [] },
            dynamic_arity: false,
            default_style: { en: 'default' },
            styles: [{ style_name: 'default', mode: 'formula_inline', template: id, tags: [] }],
            tags: []
          }
        }
      });
    }
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readPackagePanelSnapshot({ path: '/ws' } as never, legacyIds[0]);

    expect(snapshot.selected.status).toBe('ok');
    expect(Object.keys(snapshot.workspaceMacros)).toHaveLength(PACKAGE_COUNT);
    expect(state.directoryReads).toEqual(['term_macros']);
    expect(state.entityReads.filter((path) => path.startsWith('term_macros/'))).toHaveLength(PACKAGE_COUNT);
    expect(new Set(state.entityReads).size).toBe(state.entityReads.length);
    expect(state.maxEntityInFlight).toBeLessThanOrEqual(8);
  });

  it('keeps a missing selected package as noFile while deriving the effective active set', async () => {
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    const snapshot = await actual.readPackagePanelSnapshot({ path: '/ws' } as never, 'missing');

    expect(snapshot.selected).toEqual({ status: 'noFile' });
    expect(snapshot.active).toEqual(packageIds);
  });

  it('fails closed when an active Macro entity is corrupt', async () => {
    const corruptPath = [...jsonByPath.keys()].find((path) => path.startsWith('macros/'))!;
    jsonByPath.set(corruptPath, { format: 'snl-macro', version: 1, package: packageIds[0], macro: null });
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    await expect(
      actual.readPackagePanelSnapshot({ path: '/ws' } as never, packageIds[0])
    ).rejects.toThrow('is not a valid SNL Macro envelope');
  });

  it('fails closed when a configured active package has no manifest', async () => {
    jsonByPath.set('config.json', {
      version: '0.0.8',
      macro_kinds: [],
      active_macro_packages: [...packageIds, 'missing-active']
    });
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    await expect(
      actual.readPackagePanelSnapshot({ path: '/ws' } as never, packageIds[0])
    ).rejects.toThrow('Active Macro Package "missing-active" has no Package manifest.');
  });

  it('fails closed when a Macro owner has no manifest', async () => {
    const name = 'macro.orphan';
    jsonByPath.set(`macros/${macroEntityPath('orphan', name).slice('macros/'.length)}`, makeMacroEnvelope('orphan', {
      name,
      description: '',
      source: { entries: [], urls: [] },
      dynamic_arity: false,
      kind: 'const',
      styles: [{ style_name: 'default', mode: 'formula_inline', template: name, tags: [] }],
      tags: []
    }));
    const actual = await vi.importActual<typeof import('./snlDoc')>('./snlDoc');

    await expect(
      actual.readPackagePanelSnapshot({ path: '/ws' } as never, packageIds[0])
    ).rejects.toThrow('Macro entity references missing Package orphan.');
  });
});
