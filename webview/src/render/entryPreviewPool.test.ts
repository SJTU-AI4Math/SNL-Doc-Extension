import { describe, expect, it } from 'vitest';
import { mergeDraftIntoEntryPool } from './entryPreviewPool';

describe('mergeDraftIntoEntryPool', () => {
  it('overrides the saved entry source with the current draft for self references', () => {
    expect(mergeDraftIntoEntryPool(
      [{ id: 'self', title: 'Old', hasContent: true, snl: 'context(@old)' }],
      { id: 'self', title: 'Draft', snl: 'context(@x)' }
    )).toEqual([{ id: 'self', title: 'Draft', hasContent: true, snl: 'context(@x)' }]);
  });

  it('adds a new draft to the context pool', () => {
    expect(mergeDraftIntoEntryPool([], { id: 'new', title: 'Draft', snl: '@x' })).toHaveLength(1);
  });
});
