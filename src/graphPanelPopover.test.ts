import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entryPackageIdentities } from './popoverEntryReader';

const state = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  readDirectories: [] as string[],
  readFiles: [] as string[],
  missingEntry: false,
  malformedEntry: false,
  missingMetadata: false,
  missingOwner: false,
  entryPackages: { e1: 'logic' } as Record<string, string>
}));

vi.mock('vscode', () => {
  const encoder = new TextEncoder();
  const joinPath = (base: { path: string }, ...parts: string[]) => {
    const path = [base.path, ...parts].join('/');
    return { path, fsPath: path, toString: () => path };
  };
  return {
    Uri: { joinPath },
    ViewColumn: { Active: 1 },
    window: { showErrorMessage: vi.fn(), createWebviewPanel: vi.fn() },
    commands: { executeCommand: vi.fn() },
    workspace: {
      fs: {
        readDirectory: async (uri: { path: string }) => {
          state.readDirectories.push(uri.path);
          return [];
        },
        readFile: async (uri: { path: string }) => {
          state.readFiles.push(uri.path);
          if (uri.path.endsWith('/config.json')) {
            return encoder.encode(JSON.stringify({
              version: '0.0.7',
              ...(!state.missingMetadata ? {
                entity_storage: {
                  version: 1,
                  legacy_backup_version: '0.0.5',
                  entry_default_package: '_unpackaged',
                  receipt: {
                    legacy_backup_present: false,
                    legacy_entries_present: false,
                    entry_count: 1,
                    macro_package_count: 1,
                    macro_count: 0,
                    entries_digest: 'entries',
                    macro_packages_digest: 'packages'
                  }
                }
              } : {})
            }));
          }
          if (uri.path.includes('/entries/')) {
            if (state.missingEntry) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
            return encoder.encode(JSON.stringify(state.malformedEntry
              ? { format: 'snl-entry', version: 999, package: 'logic', entry: { id: 'e1', package: 'logic' } }
              : {
                  format: 'snl-entry', version: 1, package: 'logic',
                  entry: { id: 'e1', package: 'logic', title: 'First', kind: 'k1', content: { snl: 'x' } }
                }));
          }
          if (uri.path.includes('/packages/')) {
            if (state.missingOwner) throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
            return encoder.encode(JSON.stringify({
              format: 'snl-package', version: 1, id: 'logic', name: 'Logic', description: ''
            }));
          }
          throw new Error(`unexpected read: ${uri.path}`);
        }
      },
      createFileSystemWatcher: vi.fn()
    },
    RelativePattern: class {}
  };
});
vi.mock('./preferences', () => ({
  read_extension_preferences: () => ({ language: 'en' })
}));
vi.mock('./snlDoc', () => ({
  readEntries: vi.fn(async () => Object.entries(state.entryPackages).map(([id, entryPackage]) => ({
    id, package: entryPackage, title: id === 'e1' ? 'First' : 'Second', kind: 'k1', content: { snl: 'x' }
  }))),
  readEntryKinds: vi.fn(async () => [{
    id: 'k1', name: 'Definition', coloring: { stroke: '#111', background: '#fff' }
  }]),
  readRelationships: vi.fn(async () => Object.keys(state.entryPackages).length > 1 ? [{
    id: 'r1', from: 'e1', to: 'e2', label: 'uses', metadata: null
  }] : []),
  listLibraries: vi.fn(async () => []),
  readLibraryGraph: vi.fn(),
  readAllMacros: vi.fn(async () => ({})),
  readMacroKinds: vi.fn(async () => [])
}));
vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '',
  firstWorkspaceFolder: () => ({ path: '/ws', fsPath: '/ws', toString: () => '/ws' }),
  handlePanelNavMessage: async () => false
}));

async function harness(): Promise<any> {
  const { GraphPanel } = await import('./graphPanel');
  return Object.assign(Object.create(GraphPanel.prototype), {
    scope: { mode: 'pool' },
    graphGeneration: 0,
    panel: {
      webview: {
        postMessage: async (message: Record<string, unknown>) => {
          state.posted.push(message);
          return true;
        }
      }
    }
  });
}

function terminal(key: string): Record<string, unknown> | undefined {
  return state.posted.find((message) =>
    (message.type === 'popoverEntryDetails' || message.type === 'popoverEntryDetailsError') &&
    message.popoverRequestKey === key);
}

function expectNoEntityDirectoryScans(): void {
  expect(state.readDirectories.filter((path) =>
    path.endsWith('/entries') || path.endsWith('/packages'))).toEqual([]);
}

describe('GraphPanel correlated topology-aware popovers', () => {
  it('preserves prototype-shaped Entry ids as own package identities', () => {
    const identities = entryPackageIdentities([
      { id: '__proto__', package: 'logic' } as never
    ]);
    expect(Object.hasOwn(identities, '__proto__')).toBe(true);
    expect(identities.__proto__).toBe('logic');
  });

  beforeEach(() => {
    state.posted.length = 0;
    state.readDirectories.length = 0;
    state.readFiles.length = 0;
    state.missingEntry = false;
    state.malformedEntry = false;
    state.missingMetadata = false;
    state.missingOwner = false;
    state.entryPackages = { e1: 'logic' };
  });

  it('ships package identities in the Graph snapshot', async () => {
    const panel = await harness();
    await panel.pushGraph();
    expect(state.posted).toContainEqual(expect.objectContaining({
      type: 'graph', entryPackages: { e1: 'logic' }
    }));
  });

  it('assigns each participating node its own Entry package for clustering', async () => {
    state.entryPackages = { e1: 'logic', e2: '_unpackaged' };
    const panel = await harness();
    await panel.pushGraph();
    const graph = state.posted.find((message) => message.type === 'graph');
    expect(graph?.nodes).toEqual([
      expect.objectContaining({ id: 'e1', packageId: 'logic' }),
      expect.objectContaining({ id: 'e2', packageId: '_unpackaged' })
    ]);
  });

  it('echoes the request key after an exact current-storage success', async () => {
    const panel = await harness();
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic',
      popoverRequestKey: 'graph-success'
    });
    expect(terminal('graph-success')).toEqual(expect.objectContaining({
      type: 'popoverEntryDetails', entryId: 'e1', popoverRequestKey: 'graph-success',
      entry: expect.objectContaining({ id: 'e1', package: 'logic' }),
      kind: expect.objectContaining({ id: 'k1' })
    }));
    expect(state.readFiles.filter((path) => path.includes('/entries/'))).toHaveLength(1);
    expect(state.readFiles.filter((path) => path.includes('/packages/'))).toHaveLength(1);
    expectNoEntityDirectoryScans();
  });

  it('echoes the request key on exact current-storage not found', async () => {
    state.missingEntry = true;
    const panel = await harness();
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic',
      popoverRequestKey: 'graph-missing'
    });
    expect(terminal('graph-missing')).toEqual({
      type: 'popoverEntryDetails', entryId: 'e1', popoverRequestKey: 'graph-missing',
      entry: null, kind: null
    });
    expectNoEntityDirectoryScans();
  });

  it('echoes the request key on a terminal current-storage error', async () => {
    state.malformedEntry = true;
    const panel = await harness();
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic',
      popoverRequestKey: 'graph-error'
    });
    expect(terminal('graph-error')).toEqual(expect.objectContaining({
      type: 'popoverEntryDetailsError', entryId: 'e1', popoverRequestKey: 'graph-error',
      message: expect.stringMatching(/valid SNL Entry envelope/)
    }));
    expectNoEntityDirectoryScans();
  });

  it('fails closed with a correlated error when current metadata is missing', async () => {
    state.missingMetadata = true;
    const panel = await harness();
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic',
      popoverRequestKey: 'graph-metadata'
    });
    expect(terminal('graph-metadata')).toEqual(expect.objectContaining({
      type: 'popoverEntryDetailsError', popoverRequestKey: 'graph-metadata',
      message: expect.stringMatching(/missing.*entity_storage/i)
    }));
    expect(state.readFiles.some((path) => path.includes('/entries/'))).toBe(false);
    expectNoEntityDirectoryScans();
  });

  it('fails closed with a correlated error for an orphan owner package', async () => {
    state.missingOwner = true;
    const panel = await harness();
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'e1', entryPackage: 'logic',
      popoverRequestKey: 'graph-owner'
    });
    expect(terminal('graph-owner')).toEqual(expect.objectContaining({
      type: 'popoverEntryDetailsError', popoverRequestKey: 'graph-owner',
      message: expect.stringMatching(/missing Package manifest.*logic/i)
    }));
    expectNoEntityDirectoryScans();
  });
});
