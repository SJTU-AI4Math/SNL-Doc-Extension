import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('SNL Structural Index surfaces', () => {
  it('uses the single structural index badge on Dashboard and library outlines', () => {
    for (const file of [
      'webview/src/DashboardApp.tsx',
      'webview/src/CreateLibraryApp.tsx'
    ]) {
      const text = source(file);
      expect(text).toContain('metric="structuralIndex"');
      expect(text).not.toContain('metric="semanticFreedom"');
      expect(text).not.toContain('metric="structuredRatio"');
    }
  });

  it('precomputes the whole library instead of recalculating inside each row', () => {
    const text = source('webview/src/CreateLibraryApp.tsx');
    expect(text).toContain('computeEntryMetricsForIds(');
    expect(text).not.toContain('const metrics = computeEntryMetrics(');
  });
});
