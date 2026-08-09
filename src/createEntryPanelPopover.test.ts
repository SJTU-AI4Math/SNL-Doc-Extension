import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  posted: [] as Array<Record<string, unknown>>,
  entry: {
    id: 'child', package: 'logic', title: 'Child', kind: 'definition',
    content: { snl: 'x' }, contribution_info: null, pointer: null
  } as Record<string, unknown> | null,
  readError: undefined as Error | undefined,
  readCalls: [] as Array<[unknown, string | undefined, string]>,
  workspace: true
}));

vi.mock('vscode', () => ({
  window: { showErrorMessage: vi.fn() },
  commands: { executeCommand: vi.fn() },
  workspace: {},
  Uri: { joinPath: vi.fn() },
  ViewColumn: { Active: 1, Beside: 2 }
}));
vi.mock('./preferences', () => ({
  read_extension_preferences: () => ({ language: 'en' })
}));
vi.mock('./snlDoc', () => ({
  listEntryKinds: vi.fn(async () => [{ id: 'definition', name: 'Definition' }])
}));
vi.mock('./popoverEntryReader', () => ({
  readPopoverEntry: vi.fn(async (root: unknown, entryPackage: string | undefined, entryId: string) => {
    state.readCalls.push([root, entryPackage, entryId]);
    if (state.readError) throw state.readError;
    return state.entry;
  })
}));
vi.mock('./panelUtil', () => ({
  firstWorkspaceFolder: () => state.workspace ? ({ path: '/ws', fsPath: '/ws' }) : undefined,
  handlePanelNavMessage: async () => false,
  buildPanelHtml: () => '',
  installSnlDocWatcher: () => undefined
}));
vi.mock('./preferencesHost', () => ({ bind_preferences_panel_title: vi.fn() }));
vi.mock('./trace', () => ({ countPanelOpen: () => 0, startTrace: () => ({ mark: vi.fn() }) }));

async function harness(): Promise<any> {
  const { CreateEntryPanel } = await import('./createEntryPanel');
  return Object.assign(Object.create(CreateEntryPanel.prototype), {
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

describe('CreateEntryPanel live-preview popover bridge', () => {
  beforeEach(() => {
    state.posted.length = 0;
    state.entry = {
      id: 'child', package: 'logic', title: 'Child', kind: 'definition',
      content: { snl: 'x' }, contribution_info: null, pointer: null
    };
    state.readError = undefined;
    state.readCalls.length = 0;
    state.workspace = true;
  });

  it('turns a Preview request into a correlated terminal Entry payload', async () => {
    const panel = await harness();
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'child', entryPackage: 'logic',
      popoverRequestKey: 'preview-child'
    });
    expect(terminal('preview-child')).toEqual(expect.objectContaining({
      type: 'popoverEntryDetails', entryId: 'child', popoverRequestKey: 'preview-child',
      entry: expect.objectContaining({ id: 'child', package: 'logic' }),
      kind: expect.objectContaining({ id: 'definition' })
    }));
    expect(state.readCalls).toEqual([[expect.anything(), 'logic', 'child']]);
  });

  it('terminates missing and failed Preview loads instead of leaving Loading visible forever', async () => {
    const panel = await harness();
    state.entry = null;
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'missing', entryPackage: 'logic',
      popoverRequestKey: 'preview-missing'
    });
    expect(terminal('preview-missing')).toEqual({
      type: 'popoverEntryDetails', entryId: 'missing', popoverRequestKey: 'preview-missing',
      entry: null, kind: null
    });

    state.readError = new Error('bad envelope');
    await panel.handleMessage({
      type: 'requestEntryDetails', entryId: 'broken', entryPackage: 'logic',
      popoverRequestKey: 'preview-broken'
    });
    expect(terminal('preview-broken')).toEqual(expect.objectContaining({
      type: 'popoverEntryDetailsError', entryId: 'broken',
      popoverRequestKey: 'preview-broken', message: 'bad envelope'
    }));
  });
});
