import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// `vi.mock` is hoisted above this import, so `snlDocContext` sees the stub.
import {
  SNL_DOC_CONTEXT_KEY,
  refreshSnlDocContext,
  workspaceHasSnlDoc
} from './snlDocContext';

// `snlDocContext` imports `vscode`, which has no implementation outside the
// extension host. Stub just enough to exercise the folder probe.
const folders: { uri: { fsPath: string } }[] = [];
const statted: string[] = [];
const setContextCalls: unknown[][] = [];
let statResult: 'dir' | 'file' | 'missing' = 'missing';

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/')
    })
  },
  FileType: { File: 1, Directory: 2 },
  commands: {
    executeCommand: (...args: unknown[]) => {
      setContextCalls.push(args);
      return Promise.resolve();
    }
  },
  workspace: {
    get workspaceFolders() {
      return folders;
    },
    fs: {
      stat: async (uri: { fsPath: string }) => {
        statted.push(uri.fsPath);
        if (statResult === 'missing') throw new Error('ENOENT');
        return { type: statResult === 'dir' ? 2 : 1 };
      }
    },
    createFileSystemWatcher: () => ({
      onDidCreate: () => undefined,
      onDidDelete: () => undefined,
      dispose: () => undefined
    }),
    onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined })
  }
}));


/**
 * The editor-title 🐱 button (cat 2026-07-25: 「VS Code Extension 好像默认支持
 * 在面板右上角加按钮，比如 Lean 就加了一个。不妨先放个猫脸🐱」).
 *
 * Why an SVG and not the literal emoji: `contributes.commands[].icon` only
 * accepts a `$(themeIcon)` reference or a light/dark image path pair. A raw
 * "🐱" string renders as nothing (VS Code treats it as a relative file path
 * and silently falls back to the command title in an overflow menu). There is
 * also no built-in cat ThemeIcon in the codicon set, so a 16×16 SVG cat face
 * shipped under media/icons/ is the only way to actually get a cat.
 */

const root = resolve(__dirname, '..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8')
) as {
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string; icon?: unknown }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
};

const editorTitle = manifest.contributes.menus['editor/title'] ?? [];
const navigationItem = editorTitle.find(
  (item) => item.command === 'snlDoc.openNavigation'
);
const navigationCommand = manifest.contributes.commands.find(
  (c) => c.command === 'snlDoc.openNavigation'
);
const extensionSource = readFileSync(resolve(__dirname, 'extension.ts'), 'utf8');

describe('editor-title cat navigation button', () => {
  it('contributes an editor/title item for navigation', () => {
    expect(navigationItem).toBeDefined();
    // Right-hand side of the title bar. A negative order keeps the cat before
    // language-extension actions such as Lean's ∀ so it is not the first item
    // pushed into the overflow menu when the editor title runs out of width.
    expect(navigationItem?.group).toBe('navigation@-100');
  });

  it('gates the button on the SNL context key, not on every file', () => {
    expect(navigationItem?.when).toBe(SNL_DOC_CONTEXT_KEY);
    // A bare `when: "true"` / missing clause would show it everywhere.
    expect(navigationItem?.when).not.toBe('true');
    expect(navigationItem?.when).toBeTruthy();
  });

  it('points at a real, registered command', () => {
    expect(navigationCommand).toBeDefined();
    expect(extensionSource).toMatch(
      /registerCommand\(\s*['"]snlDoc\.openNavigation['"]/
    );
  });

  it('gives the command a cat icon that actually resolves on disk', () => {
    const icon = navigationCommand?.icon as
      | { light: string; dark: string }
      | string
      | undefined;
    // Not the raw emoji — VS Code cannot render that here.
    expect(typeof icon).toBe('object');
    const pair = icon as { light: string; dark: string };
    expect(pair.light).toMatch(/cat.*\.svg$/);
    expect(pair.dark).toMatch(/cat.*\.svg$/);
    for (const p of [pair.light, pair.dark]) {
      expect(existsSync(resolve(root, p)), p).toBe(true);
      const svg = readFileSync(resolve(root, p), 'utf8');
      expect(svg).toContain('<svg');
      // Square 16px viewBox, or VS Code renders it stretched.
      expect(svg).toContain('viewBox="0 0 16 16"');
    }
    // media/webview/ is gitignored but media/icons/ must ship.
    const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
    expect(ignore.split('\n')).not.toContain('media/');
  });

  it('activates the extension in workspaces that have a .SNL_Doc tree', () => {
    // Without this, the context key is never set (extension asleep) and the
    // button never appears — the `when` clause alone is not enough.
    expect(manifest.activationEvents).toContain(
      'workspaceContains:.SNL_Doc/config.json'
    );
  });

  it('sets the context key from activate()', () => {
    expect(extensionSource).toContain('installSnlDocContextKey');
    const contextSource = readFileSync(
      resolve(__dirname, 'snlDocContext.ts'),
      'utf8'
    );
    expect(contextSource).toContain("'setContext'");
    expect(SNL_DOC_CONTEXT_KEY).toBe('snlDoc.hasSnlDoc');
  });
});

describe('snlDoc.hasSnlDoc context key', () => {
  function reset(result: 'dir' | 'file' | 'missing'): void {
    folders.length = 0;
    statted.length = 0;
    setContextCalls.length = 0;
    statResult = result;
  }

  it('is false when no folder is open', async () => {
    reset('dir');
    expect(await workspaceHasSnlDoc()).toBe(false);
    // Nothing was even probed — no folders to probe.
    expect(statted).toEqual([]);
  });

  it('is true when a folder has a .SNL_Doc DIRECTORY', async () => {
    reset('dir');
    folders.push({ uri: { fsPath: '/ws' } });
    expect(await workspaceHasSnlDoc()).toBe(true);
    expect(statted).toEqual(['/ws/.SNL_Doc']);
  });

  it('is false when .SNL_Doc is a FILE, not a directory', async () => {
    reset('file');
    folders.push({ uri: { fsPath: '/ws' } });
    expect(await workspaceHasSnlDoc()).toBe(false);
  });

  it('is false when .SNL_Doc is absent (stat throws)', async () => {
    reset('missing');
    folders.push({ uri: { fsPath: '/ws' } });
    // A thrown stat must not propagate out of activate().
    await expect(workspaceHasSnlDoc()).resolves.toBe(false);
  });

  it('pushes the answer through setContext under the right key', async () => {
    reset('dir');
    folders.push({ uri: { fsPath: '/ws' } });
    await refreshSnlDocContext();
    expect(setContextCalls).toEqual([['setContext', 'snlDoc.hasSnlDoc', true]]);

    reset('missing');
    folders.push({ uri: { fsPath: '/ws' } });
    await refreshSnlDocContext();
    expect(setContextCalls).toEqual([['setContext', 'snlDoc.hasSnlDoc', false]]);
  });
});
