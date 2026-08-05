import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After a successful macro CREATE the panel must become the EDIT panel for
 * the macro just created — same panel, in place (cat 2026-07-27).
 *
 * Two hazards are pinned here:
 *  1. REKEY: `instances` is keyed by `${mode}:${file}:${macroName}`. If the
 *     flip does not move the Map entry, `editOrShow()` for the same macro
 *     builds a SECOND panel and dispose() leaks a stale `create:` key.
 *  2. isDuplicate: the re-pushed context contains the new name in
 *     `existingNames`; only a context with mode==='edit' keeps the webview's
 *     Save button enabled.
 */

const created: Array<{ title: string; disposed: boolean }> = [];
const posted: unknown[] = [];
let revealCount = 0;
let handlers: Array<(e: unknown) => void> = [];

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
      const record = { title, disposed: false };
      created.push(record);
      return {
        get title() { return record.title; },
        set title(next: string) { record.title = next; },
        webview: {
          html: '',
          asWebviewUri: (u: { path: string }) => ({ toString: () => u.path }),
          cspSource: 'vscode-webview://x',
          postMessage: (m: unknown) => { posted.push(m); },
          onDidReceiveMessage: (h: (e: unknown) => void) => {
            handlers.push(h);
            return { dispose: () => undefined };
          }
        },
        reveal: () => { revealCount += 1; },
        onDidDispose: () => ({ dispose: () => undefined }),
        dispose: () => { record.disposed = true; }
      };
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { path: '/ws', fsPath: '/ws' } }],
    getConfiguration: () => ({ get: () => undefined }),
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidChange: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    })
  }
}));

const macros: Array<{ name: string; styles: unknown[] }> = [];

vi.mock('./snlDoc', () => ({
  entityRevision: () => 'test-revision',
  addMacro: async (_r: unknown, _f: string, macro: { name: string }) => {
    macros.push({ name: macro.name, styles: [] });
    return { status: 'ok', name: macro.name };
  },
  updateMacro: async (_r: unknown, _f: string, macro: { name: string }) => ({
    status: 'updated',
    name: macro.name
  }),
  readEntries: async () => [],
  readAllMacros: async () => ({ activeDependency: { name: 'activeDependency', tags: [], styles: [] } }),
  readMacroKinds: async () => [],
  readMacroPackage: async () => ({
    status: 'ok',
    pkg: { name: 'pkg' },
    macros
  })
}));

const extUri = { path: '/ext', fsPath: '/ext' } as never;

type Ctx = {
  type: string;
  mode?: string;
  existing?: unknown;
  existingNames?: string[];
  prefill?: unknown;
  workspaceMacros?: Record<string, unknown>;
};

function contexts(): Ctx[] {
  return posted.filter(
    (m): m is Ctx =>
      typeof m === 'object' && m !== null &&
      (m as { type?: string }).type === 'context'
  );
}

function reset(): void {
  created.length = 0;
  posted.length = 0;
  handlers = [];
  revealCount = 0;
  macros.length = 0;
}

describe('macro panel create -> edit flip', () => {
  beforeEach(() => {
    reset();
    vi.resetModules();
  });

  it('opens Copy Macro in a separate Create panel instead of reusing a dirty blank form', async () => {
    const source = {
      name: 'source',
      description: 'description',
      source: { entries: [], urls: [] },
      dynamic_arity: false,
      tags: [],
      styles: []
    };
    macros.push(source);
    const { CreateMacroPanel } = await import('./createMacroPanel');

    CreateMacroPanel.createOrShow(extUri, 'algebra.json');
    CreateMacroPanel.createOrShow(extUri, 'algebra.json', { copyFrom: 'source' });

    expect(created).toHaveLength(2);
    expect(handlers).toHaveLength(2);
    await handlers[1]({ type: 'ready' });
    expect(contexts().at(-1)?.prefill).toEqual({
      macro: { ...source, name: '' }
    });
    expect(contexts().at(-1)?.workspaceMacros).toMatchObject({
      activeDependency: { name: 'activeDependency' },
      source: { name: 'source' }
    });
  });

  it('resolves a copy prefill from the target package and clears only its name', async () => {
    const source = {
      name: 'source',
      description: 'description',
      source: { entries: ['entry'], urls: ['https://example.com'] },
      kind: 'operator',
      dynamic_arity: false,
      tags: ['macro-tag'],
      styles: [{
        style_name: 'default',
        mode: 'formula_inline',
        template: '#0',
        tags: ['style-tag']
      }]
    };
    macros.push(source);

    const { CreateMacroPanel } = await import('./createMacroPanel');
    CreateMacroPanel.createOrShow(extUri, 'algebra.json', { copyFrom: 'source' });
    await handlers[0]({ type: 'ready' });

    expect(contexts().at(-1)?.mode).toBe('create');
    expect(contexts().at(-1)?.prefill).toEqual({
      macro: { ...source, name: '' }
    });
  });

  it('flips mode/name/title and pushes an edit-mode context', async () => {
    const { CreateMacroPanel } = await import('./createMacroPanel');
    CreateMacroPanel.createOrShow(extUri, 'algebra.json');
    expect(created).toHaveLength(1);
    expect(created[0].title).toContain('Create Macro');

    await handlers[0]({ type: 'create', macro: { name: 'foo', styles: [] } });

    expect(posted.some(
      (m) => (m as { type?: string }).type === 'created'
    )).toBe(true);

    // Title now advertises edit mode for the created macro.
    expect(created[0].title).toBe('SNL Edit Macro — foo (algebra)');

    const last = contexts().at(-1)!;
    expect(last.mode).toBe('edit');
    expect(last.existing).not.toBeNull();
    expect((last.existing as { name: string }).name).toBe('foo');
    // The self-duplicate trap: the new name IS in existingNames, which is
    // exactly why mode must be 'edit' for the webview to keep Save enabled.
    expect(last.existingNames).toContain('foo');
  });

  it('rekeys instances: editOrShow reveals, never builds a second panel', async () => {
    const { CreateMacroPanel } = await import('./createMacroPanel');
    CreateMacroPanel.createOrShow(extUri, 'algebra.json');
    await handlers[0]({ type: 'create', macro: { name: 'foo', styles: [] } });

    revealCount = 0;
    CreateMacroPanel.editOrShow(extUri, 'algebra.json', 'foo');
    expect(created).toHaveLength(1);
    expect(revealCount).toBe(1);

    // The stale `create:` key must be gone too — otherwise createOrShow
    // would resurrect a panel that is now in edit mode.
    const map = (CreateMacroPanel as unknown as {
      instances: Map<string, unknown>;
    }).instances;
    expect([...map.keys()]).toEqual(['edit:algebra:foo']);
  });

  it('dispose() removes the post-flip key, leaving no stale entry', async () => {
    const { CreateMacroPanel } = await import('./createMacroPanel');
    CreateMacroPanel.createOrShow(extUri, 'algebra.json');
    await handlers[0]({ type: 'create', macro: { name: 'foo', styles: [] } });

    const map = (CreateMacroPanel as unknown as {
      instances: Map<string, { dispose(): void }>;
    }).instances;
    map.get('edit:algebra:foo')!.dispose();
    expect(map.size).toBe(0);

    // And a subsequent editMacro genuinely builds a fresh panel.
    CreateMacroPanel.editOrShow(extUri, 'algebra.json', 'foo');
    expect(created).toHaveLength(2);
  });

  it('a second save updates instead of creating a duplicate', async () => {
    const { CreateMacroPanel } = await import('./createMacroPanel');
    CreateMacroPanel.createOrShow(extUri, 'algebra.json');
    await handlers[0]({ type: 'create', macro: { name: 'foo', styles: [] } });

    posted.length = 0;
    // The webview posts `update` post-flip; the host forces identity from
    // this.macroName.
    await handlers[0]({ type: 'update', macro: { name: 'foo', styles: [] } });

    expect(posted.some(
      (m) => (m as { type?: string }).type === 'updated'
    )).toBe(true);
    expect(posted.some(
      (m) => (m as { type?: string }).type === 'duplicate'
    )).toBe(false);
    expect(macros).toHaveLength(1);
  });
});
