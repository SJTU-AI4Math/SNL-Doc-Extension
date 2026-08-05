import { beforeEach, describe, expect, it, vi } from 'vitest';

let watchedPattern: string | undefined;

vi.mock('vscode', () => ({
  FileType: { Directory: 2 },
  Uri: {
    joinPath: (base: { path: string }, ...parts: string[]) => ({
      path: [base.path, ...parts].join('/')
    })
  },
  commands: { executeCommand: vi.fn(async () => undefined) },
  workspace: {
    workspaceFolders: [],
    fs: { stat: vi.fn() },
    createFileSystemWatcher: (pattern: string) => {
      watchedPattern = pattern;
      return {
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        dispose: vi.fn()
      };
    },
    onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() }))
  }
}));

import { installSnlDocContextKey } from './snlDocContext';

beforeEach(() => {
  watchedPattern = undefined;
});

describe('SNL Doc context watcher', () => {
  it('watches only the sentinel directory, not every entity write below it', () => {
    installSnlDocContextKey([]);
    expect(watchedPattern).toBe('**/.SNL_Doc');
  });
});
