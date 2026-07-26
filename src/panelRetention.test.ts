import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Webview panel retention policy — REVERSED on 2026-07-25.
 *
 * The original policy forced `retainContextWhenHidden: false` everywhere: a
 * dozen hidden KaTeX / graph / editor webviews kept alive is real memory, and
 * back then the trade looked bad.
 *
 * Cat 2026-07-25 explicitly chose the other side of that trade: 「目前 Panel
 * 不激活时依然休眠，打开还要重新加载，关掉，放后台还开着。应该吃不了多少内存？」
 * i.e. pay the memory to get instant tab switching instead of a full webview
 * teardown + React remount + KaTeX re-render on every hide/show cycle.
 *
 * So the policy is now the inverse: every panel that calls
 * `createWebviewPanel` MUST pass `retainContextWhenHidden: true`, and none may
 * pass `false`. If you ever want to walk this back, change it here first — a
 * silent per-panel drift is what this test exists to prevent.
 *
 * Note this does NOT make the draft-persistence machinery
 * (webview/src/components/draftState.ts) redundant: it still guards against a
 * real dispose (window reload, VS Code restart, panel close), which retention
 * does not cover.
 */

const src = resolve(__dirname);

/**
 * Files that create a webview but are deliberately NOT user-facing panels, so
 * the retention policy does not apply to them.
 *
 * `webviewCostProbe.ts` stands up throwaway EMPTY webviews purely to measure
 * what `createWebviewPanel` costs, then disposes each one immediately. It must
 * pass `retainContextWhenHidden: false`: retaining a panel we are about to
 * dispose would both leak the thing the probe promises to clean up and warm
 * state that the next sample is supposed to pay for cold. Exempting it here is
 * the honest fix — bending the probe to satisfy the policy would silently
 * corrupt the measurement the probe exists to produce.
 */
const NON_PANEL_WEBVIEWS = new Set(['webviewCostProbe.ts']);

/** Every source file that actually creates a user-facing webview panel. */
function panelSources(): { name: string; text: string }[] {
  return readdirSync(src)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !NON_PANEL_WEBVIEWS.has(name))
    .map((name) => ({ name, text: readFileSync(resolve(src, name), 'utf8') }))
    .filter((f) => f.text.includes('createWebviewPanel('));
}

describe('webview panel retention policy', () => {
  it('finds the panel-creating sources at all (guards the scan itself)', () => {
    const names = panelSources().map((f) => f.name);
    // A typo'd filter that matched nothing would make every other assertion
    // below vacuously pass, so pin the population explicitly.
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain('dashboardPanel.ts');
    expect(names).toContain('kindPanelController.ts');
    expect(names).toContain('initKindsPanelController.ts');
  });

  it('retains context on every hidden webview (cat 2026-07-25: memory for speed)', () => {
    const offenders = panelSources()
      .filter((f) => !f.text.includes('retainContextWhenHidden: true'))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('leaves no panel still opted OUT of retention', () => {
    const offenders = panelSources()
      .filter((f) => f.text.includes('retainContextWhenHidden: false'))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('sets the flag once per createWebviewPanel call, so no call site is missed', () => {
    for (const f of panelSources()) {
      const creations = f.text.match(/createWebviewPanel\(/g)?.length ?? 0;
      const retentions = f.text.match(/retainContextWhenHidden: true/g)?.length ?? 0;
      expect(retentions, f.name).toBe(creations);
    }
  });
});
