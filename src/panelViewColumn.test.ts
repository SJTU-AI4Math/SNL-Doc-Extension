import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which editor column a panel opens in, per panel type.
 *
 * HISTORICAL NOTE — the performance theory this file was written to track is
 * DEAD. Both of its premises were refuted:
 *
 *   1. '`Beside` is faster than `Active`.' Measured 2026-07-25:
 *      Active 1077ms vs Beside 1096ms. If anything Beside is slower.
 *   2. 'The Infoview is fast on its first open.' Refuted by cat 2026-07-26:
 *      '首次开 Infoview -> Libraries 列表页面不快, 从 Libraries 进 单个
 *      Library 的 Infoview 面板快.' Only the Infoview's INNER navigation is
 *      fast, because drilling into a library is a postMessage inside a webview
 *      that is already standing. Its first open pays the same ~1.09s.
 *
 * So ViewColumn does not explain anything, and the Infoview is not a special
 * fast panel. The real variable is simply whether an action calls
 * `createWebviewPanel` at all. Do not resurrect the ViewColumn theory.
 *
 * The test is kept because the column split is still a real UX decision worth
 * pinning against silent drift — the Infoview opens beside so it can sit next
 * to the document you are reading, and editor panels take over the active
 * group. That is layout intent now, not a performance claim.
 */

const SRC = join(__dirname);

function panelSources(): Array<{ file: string; text: string }> {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }))
    .filter((f) => f.text.includes('createWebviewPanel('));
}

describe('panel view column', () => {
  it('finds the panel sources (guards against a broken scan)', () => {
    const files = panelSources().map((f) => f.file);
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('infoviewPanel.ts');
    expect(files).toContain('createEntryPanel.ts');
  });

  it('opens the Infoview beside, never taking over the active group', () => {
    const infoview = panelSources().find((f) => f.file === 'infoviewPanel.ts');
    expect(infoview).toBeTruthy();
    expect(infoview!.text).toContain('ViewColumn.Beside');
    // Layout intent: the reading surface sits beside your document rather
    // than replacing it. Not a performance claim — see the header note.
    expect(infoview!.text).not.toContain('ViewColumn.Active');
  });

  it('documents that every other panel takes over the active column', () => {
    // `webviewCostProbe.ts` is excluded: it is a diagnostic that opens empty
    // throwaway webviews Beside (so it never steals the editor the author is
    // looking at) and disposes them at once. It is not a panel and carries no
    // layout intent.
    const others = panelSources().filter(
      (f) => f.file !== 'infoviewPanel.ts' && f.file !== 'webviewCostProbe.ts'
    );
    const usingActive = others.filter((f) => f.text.includes('ViewColumn.Active'));
    expect(usingActive.length).toBe(others.length);
  });
});
