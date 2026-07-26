import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which editor column a panel opens in, per panel type.
 *
 * Cat 2026-07-25 reported that the Infoview is fast **on its first open**,
 * while every editor panel takes ~1.09s — and that first-open speed rules
 * out the singleton/retain explanation. The only structural difference left
 * between them is the `ViewColumn` they pass to `createWebviewPanel`:
 *
 *   Infoview        -> ViewColumn.Beside   (opens a NEW editor group)
 *   everything else -> ViewColumn.Active   (takes over the CURRENT group)
 *
 * Bundle size, CSS size, @font-face count and webview options are otherwise
 * near-identical (main.js 668KB / createEntry.js 788KB, both ~37KB CSS with
 * the same 59 KaTeX font files), so those cannot explain the gap.
 *
 * This test does not assert that `Beside` is *faster* — that is cat's
 * observation to confirm with a trace. It pins the split so the correlation
 * stays visible and cannot drift silently while we investigate.
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
    // If this ever flips to Active, the Infoview should be re-timed: it is
    // the one panel cat reports as fast on first open.
    expect(infoview!.text).not.toContain('ViewColumn.Active');
  });

  it('documents that every other panel takes over the active column', () => {
    const others = panelSources().filter((f) => f.file !== 'infoviewPanel.ts');
    const usingActive = others.filter((f) => f.text.includes('ViewColumn.Active'));
    // Every non-Infoview panel currently uses Active. This is the population
    // cat reports as slow.
    expect(usingActive.length).toBe(others.length);
  });
});
