import { describe, expect, it, vi } from 'vitest';

/**
 * The trace channel is a diagnostic, so the thing worth testing is that it
 * (a) costs nothing when off, (b) produces a readable, ms-resolution
 * timeline when on, and (c) reports the DELTA between stages — the delta is
 * the number that identifies a bottleneck.
 *
 * Cat 2026-07-25 asked for exactly this instrumentation on the Entry panel.
 */

const lines: string[] = [];
let traceSetting = false;

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: (line: string) => { lines.push(line); },
      show: () => undefined
    })
  },
  workspace: {
    getConfiguration: () => ({ get: () => traceSetting })
  }
}));

async function load(): Promise<typeof import('./trace')> {
  return import('./trace');
}

describe('panel trace', () => {
  it('is a no-op until enabled', async () => {
    lines.length = 0;
    const { startTrace, refreshTraceEnabled, setTraceEnabled } = await load();
    setTraceEnabled(false);
    traceSetting = false;
    refreshTraceEnabled();

    const trace = startTrace('entryPanel:open');
    trace.mark('read:start');
    trace.mark('read:done');
    expect(lines).toEqual([]);
  });

  it('records each stage with a total and a per-stage delta', async () => {
    lines.length = 0;
    const { startTrace, setTraceEnabled } = await load();
    setTraceEnabled(true);

    const trace = startTrace('entryPanel:open', 'mode=edit id=thm-1');
    trace.mark('webview-created');
    trace.mark('read:done', 'macros=412');

    // Header carries the label and the caller's detail.
    expect(lines[0]).toContain('entryPanel:open');
    expect(lines[0]).toContain('mode=edit id=thm-1');

    // Every stage line has ms precision, a (+delta), and the stage name.
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^\[\s*\d+\.\d+ms\] \(\+\s*\d+\.\d+\)/);
    }
    expect(lines[1]).toContain('webview-created');
    expect(lines[2]).toContain('read:done');
    expect(lines[2]).toContain('macros=412');

    setTraceEnabled(false);
  });

  it('follows the snlDoc.trace setting', async () => {
    const { refreshTraceEnabled, isTraceEnabled, setTraceEnabled } = await load();
    setTraceEnabled(false);

    traceSetting = true;
    refreshTraceEnabled();
    expect(isTraceEnabled()).toBe(true);

    traceSetting = false;
    refreshTraceEnabled();
    expect(isTraceEnabled()).toBe(false);
  });

  it('measures real elapsed time, not a constant', async () => {
    lines.length = 0;
    const { startTrace, setTraceEnabled } = await load();
    setTraceEnabled(true);

    const trace = startTrace('slow');
    await new Promise((resolve) => setTimeout(resolve, 60));
    trace.mark('after-wait');

    const match = lines[1].match(/\(\+\s*([\d.]+)\)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(40);

    setTraceEnabled(false);
  });
});
