import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));
import { entryMatchesMacroFilter, macroMatchesEntryFilter } from './snooglCrossDomainFilter';
import type { EntryData, MacroPackageEntry } from './snlDoc';

const entry = (snl: string): EntryData => ({
  id: 'entry-a', kind: 'definition', title: '', content: { snl },
  contribution_info: null, pointer: null
});

const macro = (sources: string[]): MacroPackageEntry => ({
  name: 'Logic.rule', description: '', source: { entries: sources, urls: [] },
  dynamic_arity: false, styles: [], tags: []
});

describe('SNoogL cross-domain filters', () => {
  it('filters Entries by exact Macro ID references in SNL', () => {
    expect(entryMatchesMacroFilter(entry('Logic.rule(x)'), 'Logic.rule')).toBe(true);
    expect(entryMatchesMacroFilter(entry('Logic.ruleExtra(x)'), 'Logic.rule')).toBe(false);
    expect(entryMatchesMacroFilter(entry('%Logic.rule%'), 'Logic.rule')).toBe(false);
    expect(entryMatchesMacroFilter(entry('anything'), '')).toBe(true);
  });

  it('filters Macros by exact source Entry ID', () => {
    expect(macroMatchesEntryFilter(macro(['entry-a', 'entry-b']), 'entry-a')).toBe(true);
    expect(macroMatchesEntryFilter(macro(['entry-ab']), 'entry-a')).toBe(false);
    expect(macroMatchesEntryFilter(macro([]), '')).toBe(true);
  });
});
