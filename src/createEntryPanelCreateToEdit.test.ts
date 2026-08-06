import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After a successful create the panel must BECOME the Edit panel for the
 * entry that was just created — same panel, same webview, no reload.
 *
 * Cat 2026-07-27: "after creating something the normal next action is to keep
 * editing that same thing, not to create another one."
 */

const posted: any[] = [];
const events: string[] = [];
const panelRecord = { title: '' };
let messageHandler: ((e: any) => unknown) | undefined;

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (b: { path: string }, ...p: string[]) => ({
      path: [b.path, ...p].join('/'),
      fsPath: [b.path, ...p].join('/')
    })
  },
  ViewColumn: { Active: -1, Beside: -2 },
  FileType: { File: 1, Directory: 2 },
  RelativePattern: class {},
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  env: { language: 'en' },
  commands: { executeCommand: async () => undefined },
  window: {
    activeColorTheme: { kind: 2 },
    onDidChangeActiveColorTheme: () => ({ dispose: () => undefined }),
    createOutputChannel: () => undefined,
    showErrorMessage: () => undefined,
    showWarningMessage: () => undefined,
    showInformationMessage: () => undefined,
    createWebviewPanel: (_type: string, title: string) => {
      panelRecord.title = title;
      return {
        get title() { return panelRecord.title; },
        set title(next: string) { panelRecord.title = next; },
        webview: {
          html: '',
          asWebviewUri: (u: { path: string }) => ({ toString: () => u.path }),
          cspSource: 'vscode-webview://x',
          postMessage: async (m: any) => {
            posted.push(m);
            events.push(`post:${String(m?.type)}`);
            return true;
          },
          onDidReceiveMessage: (h: (e: any) => unknown) => {
            messageHandler = h;
            return { dispose: () => undefined };
          }
        },
        reveal: () => undefined,
        onDidDispose: () => ({ dispose: () => undefined }),
        dispose: () => undefined
      };
    }
  },
  workspace: {
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  }
}));

const stored: any[] = [];
const packageFiles = ['core.json'];

vi.mock('./snlDoc', () => ({
  entityRevision: () => 'test-revision',
  addEntry: vi.fn(async (_root: unknown, entry: any) => {
    events.push('save:create');
    stored.push({ ...entry });
    return { status: 'ok', id: entry.id };
  }),
  updateEntry: vi.fn(async (_root: unknown, id: string) => {
    events.push('save:update');
    return { status: 'updated', id };
  }),
  regenerateDependencyRelationships: vi.fn(async (_root: unknown, scope: { entryIds: Set<string> }) => {
    events.push(`regenerate:${Array.from(scope.entryIds).join(',')}`);
    return { status: 'ok', report: {} };
  }),
  createMacroPackage: vi.fn(async (_root: unknown, file: string) => {
    packageFiles.push(`${file}.json`);
    return { status: 'ok', file: `${file}.json` };
  }),
  listEntryKinds: async () => [{ id: 'definition', name: 'Definition' }],
  readAllMacrosWithOrigin: async () => ({ macros: {}, origin: {} }),
  readMacroKinds: async () => [],
  readMacroPackage: async () => null,
  readMacroPackages: async () => packageFiles.map((file) => ({ file })),
  resolveActiveMacroPackages: async () => [],
  readEntries: async () => stored,
  readRelationships: async () => []
}));

vi.mock('./panelUtil', () => ({
  buildPanelHtml: () => '<html></html>',
  firstWorkspaceFolder: () => ({ path: '/ws', fsPath: '/ws' }),
  handlePanelNavMessage: async () => false,
  installSnlDocWatcher: () => undefined
}));

const extUri = { path: '/ext', fsPath: '/ext' } as never;

function contexts(): any[] {
  return posted.filter((m) => m && m.type === 'context');
}

describe('CreateEntryPanel create -> edit flip', () => {
  beforeEach(() => {
    posted.length = 0;
    events.length = 0;
    packageFiles.splice(0, packageFiles.length, 'core.json');
  });

  it('flips mode/id/title and pushes an edit context after a successful create', async () => {
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    expect(messageHandler).toBeTruthy();
    posted.length = 0;

    await messageHandler!({
      type: 'create',
      entry: { id: 'thm-new', kind: 'definition', title: 'Brand New', content: { snl: 'root(child)' } }
    });

    const created = posted.find((m) => m?.type === 'created');
    expect(created?.id).toBe('thm-new');

    // No `retarget`: that path blanks the webview form.
    expect(posted.some((m) => m?.type === 'retarget')).toBe(false);

    // Panel title now advertises the entry it edits.
    expect(panelRecord.title).toBe('SNL Edit Entry — thm-new');

    // …and the follow-up context is an EDIT context for the new id.
    const context = contexts().at(-1);
    expect(context.mode).toBe('edit');
    expect(context.id).toBe('thm-new');
    expect(context.seedId).toBeUndefined();
    expect(context.existing?.id).toBe('thm-new');
    expect(context.entryPackages).toContain('_unpackaged');
    expect(posted.some((message) => message?.type === 'kinds')).toBe(false);
    // `created` must precede the context so the webview can mark the target.
    expect(posted.indexOf(created)).toBeLessThan(posted.indexOf(context));
    expect(events.indexOf('save:create')).toBeLessThan(events.indexOf('regenerate:thm-new'));
    expect(events.indexOf('regenerate:thm-new')).toBeLessThan(events.indexOf('post:created'));
    expect(events.indexOf('post:created')).toBeLessThan(events.indexOf('post:context'));
  });

  it('routes the next save to updateEntry instead of creating a duplicate', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    posted.length = 0;
    vi.mocked(snlDoc.addEntry).mockClear();
    vi.mocked(snlDoc.updateEntry).mockClear();

    await messageHandler!({
      type: 'create',
      entry: { id: 'thm-second', kind: 'definition', title: 'Second', content: {} }
    });
    expect(snlDoc.addEntry).toHaveBeenCalledTimes(1);

    await messageHandler!({
      type: 'update',
      entry: {
        id: 'thm-second', kind: 'definition', title: 'Second edited', content: {},
        contribution_info: 'Grace Hopper'
      }
    });
    expect(snlDoc.addEntry).toHaveBeenCalledTimes(1);
    expect(snlDoc.updateEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(snlDoc.updateEntry).mock.calls[0][1]).toBe('thm-second');
    expect(vi.mocked(snlDoc.updateEntry).mock.calls[0][2]).toMatchObject({
      contribution_info: 'Grace Hopper'
    });
    expect(events.indexOf('save:update')).toBeLessThan(events.lastIndexOf('regenerate:thm-second'));
    expect(events.lastIndexOf('regenerate:thm-second')).toBeLessThan(events.lastIndexOf('post:updated'));
  });

  it('reports dependency regeneration failure as terminal error and refreshes saved state', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    posted.length = 0;
    events.length = 0;
    vi.mocked(snlDoc.regenerateDependencyRelationships).mockResolvedValueOnce({
      status: 'error',
      message: 'relationships write failed'
    });

    await messageHandler!({
      type: 'create',
      entry: { id: 'saved-despite-regen-error', kind: 'definition', title: 'Saved', content: {} }
    });

    expect(posted.some((message) => message?.type === 'created')).toBe(false);
    const error = posted.find((message) => message?.type === 'error');
    const context = contexts().at(-1);
    expect(error?.message).toContain('relationships write failed');
    expect(context).toMatchObject({
      mode: 'edit',
      id: 'saved-despite-regen-error',
      existing: { id: 'saved-despite-regen-error' }
    });
    expect(posted.indexOf(error)).toBeLessThan(posted.indexOf(context));
  });

  it('uses canonical Package creation and confirms the refreshed Package to the webview', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    posted.length = 0;
    vi.mocked(snlDoc.createMacroPackage).mockClear();

    await messageHandler!({
      type: 'createPackage', packageId: 'Algebra', requestId: 'request-1'
    });

    expect(snlDoc.createMacroPackage).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/ws' }),
      'Algebra',
      'Algebra'
    );
    const confirmation = posted.find((message) => message?.type === 'packageCreated');
    expect(confirmation).toEqual({
      type: 'packageCreated', packageId: 'Algebra', requestId: 'request-1'
    });
    const refreshed = contexts().at(-1);
    expect(refreshed.entryPackages).toContain('Algebra');
    expect(posted.indexOf(confirmation)).toBeLessThan(posted.indexOf(refreshed));
  });

  it('does not apply a completed Package request after the singleton retargets', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'entry-a');
    posted.length = 0;
    let finish!: () => void;
    vi.mocked(snlDoc.createMacroPackage).mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => {
        packageFiles.push('Deferred.json');
        resolve({ status: 'ok', file: 'Deferred.json' });
      };
    }));

    const pending = messageHandler!({
      type: 'createPackage', packageId: 'Deferred', requestId: 'request-a'
    });
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    CreateEntryPanel.editOrShow(extUri, 'entry-b');
    finish();
    await pending;

    expect(posted.some((message) =>
      message?.type === 'packageCreated' && message?.requestId === 'request-a'
    )).toBe(false);
    const refreshed = contexts().at(-1);
    expect(refreshed.id).toBe('entry-b');
    expect(refreshed.entryPackages).toContain('Deferred');
  });

  it('reports canonical Package creation exceptions without dropping the request', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    posted.length = 0;
    vi.mocked(snlDoc.createMacroPackage).mockRejectedValueOnce(new Error('disk full'));

    await messageHandler!({
      type: 'createPackage', packageId: 'Algebra', requestId: 'request-error'
    });

    expect(posted.find((message) => message?.type === 'packageCreateFailed')).toEqual({
      type: 'packageCreateFailed',
      requestId: 'request-error',
      message: 'Could not create Package: disk full'
    });
  });
});
