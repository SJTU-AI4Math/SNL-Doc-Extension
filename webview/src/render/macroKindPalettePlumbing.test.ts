import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..', '..');

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('Macro Kind palette plumbing', () => {
  it('threads host macroKinds through every EntrySurface and popover bundle', () => {
    for (const host of [
      'src/infoviewPanel.ts',
      'src/createEntryPanel.ts',
      'src/graphPanel.ts'
    ]) {
      expect(source(host), host).toContain('macroKinds');
    }

    for (const webview of [
      'webview/src/App.tsx',
      'webview/src/EntryInfoviewApp.tsx',
      'webview/src/CreateEntryApp.tsx',
      'webview/src/SnlGraphApp.tsx'
    ]) {
      const text = source(webview);
      expect(text, webview).toContain('macroKindsToPalette');
      expect(text, webview).toContain('kindPalette=');
    }

    expect(source('webview/src/render/HoverPopoverProvider.tsx')).toContain(
      'kindPalette={kindPalette}'
    );
    expect(source('webview/src/render/EntryRender.tsx')).toContain(
      'kindPalette={kindPalette}'
    );
  });
});
