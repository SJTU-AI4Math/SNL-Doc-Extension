import { describe, expect, it, vi } from 'vitest';

// panelUtil imports `vscode`, which only exists inside the extension host.
const handlers: Array<(uri: { path: string }) => void> = [];
vi.mock('vscode', () => ({
  RelativePattern: class {},
  workspace: {
    workspaceFolders: [{ uri: { path: '/ws', fsPath: '/ws' } }],
    createFileSystemWatcher: () => ({
      onDidCreate: (h: (uri: { path: string }) => void) => { handlers.push(h); },
      onDidChange: (h: (uri: { path: string }) => void) => { handlers.push(h); },
      onDidDelete: (h: (uri: { path: string }) => void) => { handlers.push(h); },
      dispose: () => undefined
    })
  }
}));
import {
  SNL_DOC_WATCHED_PATH,
  SNL_DOC_WATCH_DEBOUNCE_MS,
  shouldRefreshEntityDependency
} from './panelUtil';

/**
 * The `.SNL_Doc` watcher used to refresh on EVERY event under `.SNL_Doc/**`
 * with no debounce. Saving one entry rewrites several files, and each open
 * panel installs its own watcher, so a single save fanned out to
 * (files × panels) full workspace re-reads. Cat 2026-07-25: panels felt slow.
 */
describe('SNL_DOC_WATCHED_PATH', () => {
  it('matches every file the panels actually read', () => {
    const watched = [
      '/ws/.SNL_Doc/config.json',
      '/ws/.SNL_Doc/entries.json',
      '/ws/.SNL_Doc/entries/dc23c2ae0a0b9459393a.json',
      '/ws/.SNL_Doc/packages/Logic-277a664e3d2332d369d7.json',
      '/ws/.SNL_Doc/macros/Logic-dd2136b29efc47b38142.json',
      '/ws/.SNL_Doc/relationships.json',
      '/ws/.SNL_Doc/term_macros/core.json',
      '/ws/.SNL_Doc/term_macros/snl-macro.json',
      '/ws/.SNL_Doc/libraries/algebra/graph.json',
      '/ws/.SNL_Doc/libraries/algebra/meta.json'
    ];
    for (const path of watched) {
      expect(SNL_DOC_WATCHED_PATH.test(path), path).toBe(true);
    }
  });

  it('ignores churn the panels never read', () => {
    const ignored = [
      // Images and other assets — a screenshot drop must not re-read the pool.
      '/ws/.SNL_Doc/assets/diagram.png',
      '/ws/.SNL_Doc/assets/notes.md',
      // Editor scratch / atomic-save temp files.
      '/ws/.SNL_Doc/entries.json.tmp',
      '/ws/.SNL_Doc/.entries.json.swp',
      // Directories themselves.
      '/ws/.SNL_Doc/term_macros',
      // Nested deeper than any real package.
      '/ws/.SNL_Doc/term_macros/sub/dir/core.json',
      // Outside .SNL_Doc entirely.
      '/ws/src/index.ts'
    ];
    for (const path of ignored) {
      expect(SNL_DOC_WATCHED_PATH.test(path), path).toBe(false);
    }
  });

  it('coalesces bursts rather than firing per write', () => {
    expect(SNL_DOC_WATCH_DEBOUNCE_MS).toBeGreaterThan(0);
    // Long enough to swallow a multi-file save, short enough to feel instant.
    expect(SNL_DOC_WATCH_DEBOUNCE_MS).toBeLessThanOrEqual(250);
  });
});

describe('entity dependency invalidation', () => {
  const dependency = '/.SNL_Doc/entries/target.json';

  it('fails broad only before dependencies are established', () => {
    expect(shouldRefreshEntityDependency('/ws/.SNL_Doc/entries/other.json', [], false)).toBe(true);
    expect(shouldRefreshEntityDependency('/ws/.SNL_Doc/entries/other.json', [], true)).toBe(false);
  });

  it('refreshes exact dependencies and ignores unrelated entity hashes', () => {
    expect(shouldRefreshEntityDependency('/ws/.SNL_Doc/entries/target.json', [dependency], true)).toBe(true);
    expect(shouldRefreshEntityDependency('/ws/.SNL_Doc/entries/other.json', [dependency], true)).toBe(false);
    expect(shouldRefreshEntityDependency(
      '/ws/.SNL_Doc/packages/active.json',
      ['/.SNL_Doc/packages/active.json'],
      true
    )).toBe(true);
  });
});

describe('installSnlDocWatcher', () => {
  it('collapses a multi-file save into ONE refresh', async () => {
    const { installSnlDocWatcher } = await import('./panelUtil');
    handlers.length = 0;
    let refreshes = 0;
    const disposables: Array<{ dispose: () => void }> = [];
    installSnlDocWatcher(disposables as never, () => { refreshes += 1; });

    // One save rewrites several files in quick succession.
    const fire = (path: string): void => {
      for (const handler of handlers) handler({ path });
    };
    fire('/ws/.SNL_Doc/entries.json');
    fire('/ws/.SNL_Doc/term_macros/core.json');
    fire('/ws/.SNL_Doc/config.json');
    expect(refreshes).toBe(0); // nothing fires synchronously

    await new Promise((resolve) => setTimeout(resolve, SNL_DOC_WATCH_DEBOUNCE_MS + 60));
    expect(refreshes).toBe(1); // …and the burst collapses to one re-read

    for (const disposable of disposables) disposable.dispose();
  });

  it('delivers the exact changed paths so panels can invalidate dependencies precisely', async () => {
    const { installSnlDocWatcher } = await import('./panelUtil');
    handlers.length = 0;
    const batches: string[][] = [];
    const disposables: Array<{ dispose: () => void }> = [];
    installSnlDocWatcher(disposables as never, (uris) => {
      batches.push(uris.map((uri) => uri.path));
    });

    for (const handler of handlers) {
      handler({ path: '/ws/.SNL_Doc/libraries/notes/meta.json' });
      handler({ path: '/ws/.SNL_Doc/entries/dc23c2ae0a0b9459393a.json' });
    }
    await new Promise((resolve) => setTimeout(resolve, SNL_DOC_WATCH_DEBOUNCE_MS + 60));
    expect(batches).toEqual([[
      '/ws/.SNL_Doc/libraries/notes/meta.json',
      '/ws/.SNL_Doc/entries/dc23c2ae0a0b9459393a.json'
    ]]);

    for (const disposable of disposables) disposable.dispose();
  });

  it('does not refresh at all for unwatched churn', async () => {
    const { installSnlDocWatcher } = await import('./panelUtil');
    handlers.length = 0;
    let refreshes = 0;
    const disposables: Array<{ dispose: () => void }> = [];
    installSnlDocWatcher(disposables as never, () => { refreshes += 1; });

    for (const handler of handlers) handler({ path: '/ws/.SNL_Doc/assets/pic.png' });
    await new Promise((resolve) => setTimeout(resolve, SNL_DOC_WATCH_DEBOUNCE_MS + 60));
    expect(refreshes).toBe(0);

    for (const disposable of disposables) disposable.dispose();
  });
});
