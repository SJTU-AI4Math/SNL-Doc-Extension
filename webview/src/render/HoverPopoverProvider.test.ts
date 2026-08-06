import { describe, expect, it } from 'vitest';
import {
  entryDetailsRequest,
  popoverTerminalDetail
} from './HoverPopoverProvider';
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

  it('uses operation-local package identity when the target is outside the rendered pool', () => {
    expect(entryDetailsRequest('cross-library', [], {
      'cross-library': 'analysis'
    })).toEqual({
      type: 'requestEntryDetails',
      entryId: 'cross-library',
      entryPackage: 'analysis'
    });
  });
});

describe('popover terminal responses', () => {
  it('preserves a correlated host failure as a failure instead of loading forever', () => {
    expect(popoverTerminalDetail({
      type: 'popoverEntryDetailsError',
      entryId: 'broken',
      message: 'malformed entity envelope'
    }, 'broken')).toEqual({
      entry: null,
      kind: null,
      error: 'malformed entity envelope'
    });
  });

  it('rejects malformed success messages so they cannot masquerade as not-found', () => {
    expect(popoverTerminalDetail({
      type: 'popoverEntryDetails',
      entryId: 'broken'
    }, 'broken')).toBeNull();
  });
});