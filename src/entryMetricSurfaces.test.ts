import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('SNL Structural Index surfaces', () => {
  it('keeps the single structural index badge on the Entry editor and library outline', () => {
    for (const file of [
      'webview/src/CreateEntryApp.tsx',
      'webview/src/CreateLibraryApp.tsx'
    ]) {
      const text = source(file);
      expect(text).toContain('metric="structuralIndex"');
      expect(text).not.toContain('metric="semanticFreedom"');
      expect(text).not.toContain('metric="structuredRatio"');
    }
  });

  it('omits package-management SSI where package-local approximation is forbidden', () => {
    for (const file of [
      'webview/src/DashboardApp.tsx',
      'webview/src/EntryPackagePanelApp.tsx'
    ]) {
      expect(source(file)).not.toContain('metric="structuralIndex"');
    }
  });

  it('refreshes an open Entry editor when SSI threshold settings change', () => {
    const host = source('src/createEntryPanel.ts');
    expect(host).toContain("affectsConfiguration('snlDoc.metrics')");
    expect(host).toMatch(/affectsConfiguration\('snlDoc\.metrics'\)[\s\S]{0,160}pushContext\(\)/);
  });

  it('precomputes the whole library instead of recalculating inside each row', () => {
    const text = source('webview/src/CreateLibraryApp.tsx');
    expect(text).toContain('computeEntryMetricsForIds(');
    expect(text).not.toContain('const metrics = computeEntryMetrics(');
  });
});
