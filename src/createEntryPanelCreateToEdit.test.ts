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
const panelRecord: { title: string; postMessage?: ReturnType<typeof vi.fn> } = { title: '' };
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
      const postMessage = vi.fn(async (m: any) => {
        posted.push(m);
        events.push(`post:${String(m?.type)}`);
        return true;
      });
      panelRecord.postMessage = postMessage;
      return {
        get title() { return panelRecord.title; },
        set title(next: string) { panelRecord.title = next; },
        webview: {
          html: '',
          asWebviewUri: (u: { path: string }) => ({ toString: () => u.path }),
          cspSource: 'vscode-webview://x',
          postMessage,
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
let releaseAddEntry: (() => void) | undefined;
let delayAddEntry = false;
let releaseUpdateEntry: (() => void) | undefined;
let delayUpdateEntry = false;
let updateEntryFailure: Error | undefined;

vi.mock('./snlDoc', () => ({
  entityRevision: () => 'test-revision',
  addEntry: vi.fn(async (_root: unknown, entry: any) => {
    events.push('save:create');
    if (delayAddEntry) {
      await new Promise<void>((resolve) => { releaseAddEntry = resolve; });
    }
    stored.push({ ...entry });
    return { status: 'ok', id: entry.id };
  }),
  updateEntry: vi.fn(async (_root: unknown, id: string) => {
    events.push('save:update');
    if (delayUpdateEntry) {
      await new Promise<void>((resolve) => { releaseUpdateEntry = resolve; });
    }
    if (updateEntryFailure) throw updateEntryFailure;
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
    delayAddEntry = false;
    releaseAddEntry = undefined;
    delayUpdateEntry = false;
    releaseUpdateEntry = undefined;
    updateEntryFailure = undefined;
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

  it('does not let a stale create completion hijack a retargeted panel', async () => {
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    posted.length = 0;
    delayAddEntry = true;

    const pending = messageHandler!({
      type: 'create',
      entry: { id: 'slow-a', kind: 'definition', title: 'Slow A', content: {} }
    });
    await vi.waitFor(() => expect(events).toContain('save:create'));
    CreateEntryPanel.editOrShow(extUri, 'entry-b');
    releaseAddEntry!();
    await pending;

    expect(posted.some((message) => message?.type === 'created' && message.id === 'slow-a'))
      .toBe(false);
    expect(panelRecord.title).toBe('SNL Edit Entry — entry-b');
    expect(contexts().at(-1)?.id).toBe('entry-b');
  });

  it('does not leak a rejected create regeneration after its committed target retargets', async () => {
    const snlDoc = await import('./snlDoc');
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    posted.length = 0;
    let rejectRegeneration!: (error: Error) => void;
    vi.mocked(snlDoc.regenerateDependencyRelationships).mockImplementationOnce(
      () => new Promise((_, reject) => { rejectRegeneration = reject; })
    );

    const pending = messageHandler!({
      type: 'create',
      entry: { id: 'committed-a', kind: 'definition', title: 'Committed A', content: {} }
    });
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'createCommitted', id: 'committed-a'
    })));
    CreateEntryPanel.editOrShow(extUri, 'entry-b');
    rejectRegeneration(new Error('stale regeneration exploded'));
    await pending;

    expect(posted.some((message) =>
      message?.type === 'error' && message.message === 'stale regeneration exploded'
    )).toBe(false);
    expect(panelRecord.title).toBe('SNL Edit Entry — entry-b');
    expect(contexts().at(-1)?.id).toBe('entry-b');
  });

  it('retries committed ownership before error/context when its first delivery rejects', async () => {
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    await messageHandler!({ type: 'ready' });
    posted.length = 0;
    panelRecord.postMessage!.mockRejectedValueOnce(
      new Error('createCommitted transport failed')
    );

    await messageHandler!({
      type: 'create',
      entry: { id: 'committed-retry', kind: 'definition', title: 'Committed retry', content: {} }
    });

    const committed = posted.find((message) =>
      message?.type === 'createCommitted' && message.id === 'committed-retry'
    );
    const error = posted.find((message) =>
      message?.type === 'error' && message.message === 'createCommitted transport failed'
    );
    const context = contexts().at(-1);
    expect(committed).toBeTruthy();
    expect(error).toBeTruthy();
    expect(context).toMatchObject({ mode: 'edit', id: 'committed-retry' });
    expect(posted.indexOf(committed)).toBeLessThan(posted.indexOf(error));
    expect(posted.indexOf(error)).toBeLessThan(posted.indexOf(context));
  });

  it('rechecks target ownership after a pending createCommitted retry', async () => {
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    await messageHandler!({ type: 'ready' });
    posted.length = 0;
    let resolveRetry!: () => void;
    panelRecord.postMessage!
      .mockRejectedValueOnce(new Error('stale ownership transport failed'))
      .mockImplementationOnce((message: any) => new Promise<boolean>((resolve) => {
        resolveRetry = () => {
          posted.push(message);
          events.push(`post:${String(message?.type)}`);
          resolve(true);
        };
      }));

    const pending = messageHandler!({
      type: 'create',
      entry: { id: 'ownership-a', kind: 'definition', title: 'Ownership A', content: {} }
    });
    await vi.waitFor(() => expect(typeof resolveRetry).toBe('function'));
    CreateEntryPanel.editOrShow(extUri, 'entry-b');
    resolveRetry();
    await pending;

    const staleCommitted = posted.find((message) =>
      message?.type === 'createCommitted' && message.id === 'ownership-a'
    );
    const currentContext = contexts().at(-1);
    expect(staleCommitted?.targetGeneration).toEqual(expect.any(Number));
    expect(currentContext?.targetGeneration).toBeGreaterThan(staleCommitted.targetGeneration);
    expect(posted.some((message) =>
      message?.type === 'error' && message.message === 'stale ownership transport failed'
    )).toBe(false);
    expect(panelRecord.title).toBe('SNL Edit Entry — entry-b');
    expect(contexts().at(-1)?.id).toBe('entry-b');
  });

  it('does not publish a stale update completion into a retargeted panel', async () => {
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'entry-a');
    posted.length = 0;
    events.length = 0;
    delayUpdateEntry = true;

    const pending = messageHandler!({
      type: 'update',
      entry: { id: 'entry-a', kind: 'definition', title: 'Slow update', content: {} }
    });
    await vi.waitFor(() => expect(events).toContain('save:update'));
    CreateEntryPanel.editOrShow(extUri, 'entry-b');
    releaseUpdateEntry!();
    await pending;

    expect(posted.some((message) => message?.type === 'updated' && message.id === 'entry-a'))
      .toBe(false);
    expect(panelRecord.title).toBe('SNL Edit Entry — entry-b');
    expect(contexts().at(-1)?.id).toBe('entry-b');
  });

  it('does not leak a rejected stale update into a retargeted panel', async () => {
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'entry-a');
    posted.length = 0;
    events.length = 0;
    delayUpdateEntry = true;
    updateEntryFailure = new Error('stale update exploded');

    const pending = messageHandler!({
      type: 'update',
      entry: { id: 'entry-a', kind: 'definition', title: 'Slow update', content: {} }
    });
    await vi.waitFor(() => expect(events).toContain('save:update'));
    CreateEntryPanel.editOrShow(extUri, 'entry-b');
    releaseUpdateEntry!();
    await pending;

    expect(posted.some((message) =>
      message?.type === 'error' && message.message === 'stale update exploded'
    )).toBe(false);
    expect(panelRecord.title).toBe('SNL Edit Entry — entry-b');
    expect(contexts().at(-1)?.id).toBe('entry-b');
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
    const committed = posted.find((message) => message?.type === 'createCommitted');
    expect(committed).toMatchObject({
      type: 'createCommitted',
      id: 'saved-despite-regen-error',
      targetGeneration: expect.any(Number)
    });
    const error = posted.find((message) => message?.type === 'error');
    const context = contexts().at(-1);
    expect(error?.message).toContain('relationships write failed');
    expect(context).toMatchObject({
      mode: 'edit',
      id: 'saved-despite-regen-error',
      existing: { id: 'saved-despite-regen-error' }
    });
    expect(posted.indexOf(committed)).toBeLessThan(posted.indexOf(error));
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
