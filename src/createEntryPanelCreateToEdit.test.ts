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
  listEntryKinds: async () => [{ id: 'definition', name: 'Definition' }],
  readAllMacrosWithOrigin: async () => ({ macros: {}, origin: {} }),
  readMacroKinds: async () => [],
  readMacroPackage: async () => null,
  readMacroPackages: async () => [],
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
});
