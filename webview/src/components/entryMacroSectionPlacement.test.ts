import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('Entry Macro section placement', () => {
  it('is mounted only by the dedicated Entry panel, not the Library outline', () => {
    const dedicatedEntryPanel = source('../EntryInfoviewApp.tsx');
    const libraryInfoview = source('../App.tsx');

    expect(dedicatedEntryPanel).toContain('<EntryMacroSection');
    expect(libraryInfoview).not.toContain('EntryMacroSection');
  });
});
