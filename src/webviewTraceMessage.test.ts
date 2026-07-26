import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  RelativePattern: class {},
  Uri: { joinPath: (b: { path: string }, ...p: string[]) => ({ path: [b.path, ...p].join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    createFileSystemWatcher: () => undefined,
    getConfiguration: () => ({ get: () => undefined })
  },
  window: { createOutputChannel: () => undefined }
}));

import { handleWebviewTraceMessage } from './panelUtil';

/**
 * Trace marks reported by a webview must be foldable into any panel's
 * timeline, not just the Entry panel's.
 *
 * Cat 2026-07-25: the Infoview opens fast on its FIRST open while editor
 * panels take ~1.09s. Only the Entry panel was instrumented, so the two
 * could not be compared — every explanation was inference. This helper is
 * what puts them on one timeline.
 */
describe('webview trace message handling', () => {
  it('folds a mark into the panel trace and swallows the message', () => {
    const marks: Array<[string, string | undefined]> = [];
    const trace = { mark: (s: string, d?: string) => { marks.push([s, d]); } };

    const handled = handleWebviewTraceMessage(
      { type: 'trace', stage: 'head-start', ms: 1006.14 },
      trace as never
    );

    expect(handled).toBe(true);
    expect(marks).toHaveLength(1);
    expect(marks[0][0]).toBe('webview:head-start');
    // The webview's own clock is the load-bearing number: it says how much
    // time was burned before our HTML ran at all.
    expect(marks[0][1]).toContain('1006.1');
  });

  it('passes non-trace messages through untouched', () => {
    const trace = { mark: () => { throw new Error('must not mark'); } };
    expect(handleWebviewTraceMessage({ type: 'selectEntry', id: 'x' }, trace as never)).toBe(false);
    expect(handleWebviewTraceMessage(undefined, trace as never)).toBe(false);
    expect(handleWebviewTraceMessage({ type: 'trace' }, trace as never)).toBe(false);
  });

  it('is inert when tracing is off (no trace object)', () => {
    // Still reports "handled" so the message is not mistaken for a command.
    expect(
      handleWebviewTraceMessage({ type: 'trace', stage: 'x', ms: 1 }, undefined)
    ).toBe(true);
  });

  it('survives a mark without a numeric clock', () => {
    const marks: Array<[string, string | undefined]> = [];
    const trace = { mark: (s: string, d?: string) => { marks.push([s, d]); } };
    handleWebviewTraceMessage({ type: 'trace', stage: 'dom-ready' }, trace as never);
    expect(marks[0]).toEqual(['webview:dom-ready', undefined]);
  });
});
