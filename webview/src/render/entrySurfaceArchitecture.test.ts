import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const surfaces = [
  'CreateEntryApp.tsx',
  'reader/LibraryReader.tsx',
  'reader/EntryReader.tsx',
  'render/HoverPopoverProvider.tsx'
];

describe('Entry rendering architecture', () => {
  it('keeps Extension and browser adapters on the same reader surfaces', () => {
    for (const [adapter, surface] of [
      ['App.tsx', 'renderCurrentView'], ['EntryInfoviewApp.tsx', 'EntryReader'],
      ['reader/BrowserReader.tsx', 'LibraryLayer'], ['reader/BrowserReader.tsx', 'EntryReader']
    ]) {
      const source = readFileSync(resolve(root, adapter), 'utf8');
      expect(source, adapter).toContain(surface === 'renderCurrentView' ? 'renderCurrentView(view,' : '<' + surface);
      if (adapter === 'App.tsx') expect(source).toContain("from './reader/LibraryReader'");
      expect(source, adapter).not.toContain('<EntrySurface');
    }
  });
  it('routes editor preview, infoview and popovers through EntrySurface', () => {
    for (const file of surfaces) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, file).toContain('<EntrySurface');
      expect(source, file).not.toMatch(/<EntryRender\b/);
    }
  });

  it('delegates Entry presentation to SNL-Basics and keeps only adapter interactions locally', () => {
    const source = readFileSync(resolve(root, 'render/EntryRender.tsx'), 'utf8');
    expect(source).toContain('EntrySurface as BasicsEntrySurface');
    expect(source).toContain('<BasicsEntrySurface');
    expect(source).not.toContain('<SnlSyntaxTreeView');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
