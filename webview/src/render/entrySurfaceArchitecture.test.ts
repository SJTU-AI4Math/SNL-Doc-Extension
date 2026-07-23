import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const surfaces = [
  'CreateEntryApp.tsx',
  'App.tsx',
  'EntryInfoviewApp.tsx',
  'render/HoverPopoverProvider.tsx'
];

describe('Entry rendering architecture', () => {
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
