import { describe, expect, it, vi } from 'vitest';

// `classifyProbe` is pure, but its module imports `vscode` at the top level,
// which does not exist outside the extension host. `vi.mock` is hoisted above
// the imports, so the static import below resolves against this stub. Same
// approach the other host-side tests in this folder use.
vi.mock('vscode', () => ({
  window: {},
  workspace: {},
  commands: {},
  ViewColumn: { Beside: 2, Active: -1 },
  ProgressLocation: { Notification: 15 }
}));

import { createHostTranslator } from './hostI18n';
import { classifyProbe, UI_MESSAGES, type ProbeSample } from './webviewCostProbe';

/**
 * The probe's verdict picks between two mutually exclusive fixes for the
 * ~1.09s panel open cost (cat 2026-07-25/26): PREWARM a hidden webview if the
 * cost is a one-time per-window host boot, or POOL panels if every
 * `createWebviewPanel` pays it. Getting the classification backwards would
 * send the whole effort down the wrong road, so the thresholds are pinned
 * here rather than eyeballed from the output channel.
 */

const samples = (...ms: number[]): ProbeSample[] =>
  ms.map((value, index) => ({ index: index + 1, ms: value }));

describe('classifyProbe', () => {
  it('calls a steep decay per-window and prescribes prewarming', () => {
    // Panel #1 boots the webview host; the rest are nearly free.
    const result = classifyProbe(samples(1090, 55, 61, 48, 58));
    expect(result.verdict).toBe('per-window');
    expect(result.first).toBe(1090);
    expect(result.restMedian).toBe(56.5);
    expect(result.decayRatio).toBeLessThan(0.4);
    expect(result.advice).toContain('PREWARM');
  });

  it('calls a flat cost per-panel and prescribes pooling', () => {
    // Every panel stands up its own renderer: no decay at all.
    const result = classifyProbe(samples(1090, 1070, 1105, 1080, 1095));
    expect(result.verdict).toBe('per-panel');
    expect(result.restMedian).toBe(1087.5);
    expect(result.decayRatio).toBeGreaterThan(0.7);
    expect(result.advice).toContain('POOLING');
  });

  it('refuses to guess when the decay is partial', () => {
    // Halfway between the two stories — demanding a re-run is the honest
    // answer, since either fix would be half-wasted.
    const result = classifyProbe(samples(1000, 550, 540, 560));
    expect(result.verdict).toBe('inconclusive');
    expect(result.advice).toContain('Re-run');
  });

  it('takes a true median over an even number of trailing samples', () => {
    // Four trailing samples -> average the middle two, not pick one.
    const result = classifyProbe(samples(1000, 100, 200, 300, 400));
    expect(result.restMedian).toBe(250);
    expect(result.decayRatio).toBeCloseTo(0.25, 5);
  });

  it('is unswayed by ordering of the trailing samples', () => {
    const ascending = classifyProbe(samples(1000, 40, 50, 60));
    const shuffled = classifyProbe(samples(1000, 60, 40, 50));
    expect(shuffled.restMedian).toBe(ascending.restMedian);
    expect(shuffled.verdict).toBe(ascending.verdict);
  });

  it('reports inconclusive rather than dividing by a lone sample', () => {
    const result = classifyProbe(samples(1090));
    expect(result.verdict).toBe('inconclusive');
    expect(result.first).toBe(1090);
    expect(result.advice).toContain('at least 2');
  });

  it('handles an empty run without throwing', () => {
    const result = classifyProbe([]);
    expect(result.verdict).toBe('inconclusive');
    expect(result.first).toBe(0);
  });

  it('does not divide by zero when the first sample is degenerate', () => {
    // A 0ms first sample means the probe misfired; the ratio must stay finite
    // so the report prints a number instead of NaN/Infinity.
    const result = classifyProbe(samples(0, 100, 100));
    expect(Number.isFinite(result.decayRatio)).toBe(true);
    expect(result.decayRatio).toBe(1);
  });

  it('localizes diagnostic advice for Chinese output', () => {
    const result = classifyProbe(
      samples(1090, 55, 61),
      createHostTranslator('zh-CN', UI_MESSAGES)
    );
    expect(result.advice).toContain('预热');
    expect(result.advice).not.toContain('PREWARM');
  });
});
