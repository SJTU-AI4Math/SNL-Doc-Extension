import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('GUI Editor (Canvas) placement', () => {
  it('lives beside the inductive editor inside the Entry Edit panel', () => {
    const entryEditor = read('../CreateEntryApp.tsx');
    expect(entryEditor).toContain('GUI Editor (Inductive)');
    expect(entryEditor).toContain('GUI Editor (Canvas)');
    expect(entryEditor).toContain("setSnlMode('canvas')");
  });

  it('is not exposed as a global Dashboard or command-palette panel', () => {
    const pkg = JSON.parse(read('../../../package.json')) as {
      contributes: { commands: Array<{ command: string }> };
    };
    expect(pkg.contributes.commands.some((item) => item.command === 'snlDoc.openGuiEditor')).toBe(false);
    expect(read('../DashboardApp.tsx')).not.toContain("postMessage({ type: 'openGuiEditor' })");
    expect(existsSync(new URL('../../../src/guiEditorPanel.ts', import.meta.url))).toBe(false);
  });
});
