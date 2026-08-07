import { describe, expect, it, vi } from 'vitest';

/**
 * The Entry editor is a SINGLETON that retargets, not a panel-per-entry.
 *
 * Cat 2026-07-25 measured a fresh panel at ~1.09s, essentially all of it VS
 * Code standing the webview host up before our bundle is even requested
 * (`html-set` → `document-start` = 1090ms; the 803KB bundle itself was 29ms).
 * That cost is per-panel and unavoidable, so opening a second entry must
 * reuse the live webview instead of paying it again.
 *
 * These tests pin the observable consequences: exactly one panel is ever
 * created, navigating retargets it, and the retarget resets the form so one
 * entry's text is never shown against another's id.
 */

const created: Array<{ title: string; disposed: boolean }> = [];
const posted: unknown[] = [];
let revealCount = 0;

vi.mock('vscode', () => {
  const listeners: Array<(e: unknown) => void> = [];
  return {
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
              listeners.push(h);
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
  };
});

function reset(): void {
  created.length = 0;
  posted.length = 0;
  revealCount = 0;
}

const extUri = { path: '/ext', fsPath: '/ext' } as never;

describe('entry panel singleton', () => {
  it('creates one panel and retargets it for a different entry', async () => {
    reset();
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'thm-1');
    expect(created).toHaveLength(1);

    CreateEntryPanel.editOrShow(extUri, 'thm-2');
    // The whole point: no second webview host is stood up.
    expect(created).toHaveLength(1);
    expect(revealCount).toBeGreaterThan(0);

    // …and the panel now advertises the new entry.
    expect(created[0].title).toContain('thm-2');
  });

  it('forwards registered shortcut actions to the singleton webview', async () => {
    reset();
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'thm-1');
    posted.length = 0;
    CreateEntryPanel.dispatchShortcut('inductive.indent');
    expect(posted).toContainEqual({ type: 'shortcutAction', action: 'inductive.indent' });
  });

  it('tells the webview to reset when the target changes', async () => {
    reset();
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'thm-1');
    posted.length = 0;
    CreateEntryPanel.editOrShow(extUri, 'thm-2');

    const retarget = posted.find(
      (m): m is { type: string; id: string } =>
        typeof m === 'object' && m !== null &&
        (m as { type?: string }).type === 'retarget'
    );
    expect(retarget).toBeTruthy();
    expect(retarget!.id).toBe('thm-2');
  });

  it('does not reset when re-opening the entry already shown', async () => {
    reset();
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.editOrShow(extUri, 'thm-1');
    posted.length = 0;
    CreateEntryPanel.editOrShow(extUri, 'thm-1');

    // Re-opening the same entry must not clobber in-progress edits.
    const retarget = posted.find(
      (m) => typeof m === 'object' && m !== null &&
        (m as { type?: string }).type === 'retarget'
    );
    expect(retarget).toBeUndefined();
    expect(revealCount).toBeGreaterThan(0);
  });

  it('switches between create and edit on the same panel', async () => {
    // NOTE: the singleton lives at module scope, so the panel created by the
    // earlier tests is still alive here. That is exactly the behaviour under
    // test — this must retarget it, not build another.
    reset();
    const { CreateEntryPanel } = await import('./createEntryPanel');
    CreateEntryPanel.createOrShow(extUri);
    expect(created).toHaveLength(0);
    expect(revealCount).toBeGreaterThan(0);
  });
});
