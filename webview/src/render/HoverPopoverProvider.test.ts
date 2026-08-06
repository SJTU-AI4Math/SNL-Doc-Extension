import { describe, expect, it } from 'vitest';
import { entryDetailsRequest } from './HoverPopoverProvider';
import type { EntryOption } from './EntrySurface';

describe('popover Entry identity requests', () => {
  it('includes the stable package identity from the Entry option', () => {
    const entries: EntryOption[] = [
      { id: 'entry-1', package: 'logic', title: 'One', hasContent: true }
    ];

    expect(entryDetailsRequest('entry-1', entries)).toEqual({
      type: 'requestEntryDetails',
      entryId: 'entry-1',
      entryPackage: 'logic'
    });
  });

  it('keeps an id-only request for legacy option payloads', () => {
    expect(entryDetailsRequest('legacy', [
      { id: 'legacy', title: 'Legacy', hasContent: true }
    ])).toEqual({ type: 'requestEntryDetails', entryId: 'legacy' });
  });
});