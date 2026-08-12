import { describe, expect, it } from 'vitest';
import {
  entryDetailsRequest,
  popoverRequestIdentity,
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

  it('re-keys a moved Entry and a fixed Entry snapshot without changing within one snapshot', () => {
    const first = popoverRequestIdentity('entry-1', [], { 'entry-1': 'logic' }, 4);
    const repeated = popoverRequestIdentity('entry-1', [], { 'entry-1': 'logic' }, 4);
    const moved = popoverRequestIdentity('entry-1', [], { 'entry-1': 'analysis' }, 5);
    const fixed = popoverRequestIdentity('entry-1', [], { 'entry-1': 'analysis' }, 6);

    expect(repeated).toEqual(first);
    expect(moved.key).not.toBe(first.key);
    expect(fixed.key).not.toBe(moved.key);
    expect(moved.request).toMatchObject({ entryPackage: 'analysis' });
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

  it('accepts localized Entry Kind labels and rejects malformed maps', () => {
    const entry = { id: 'entry-1', kind: 'definition', title: 'Entry', content: { text: 'Body' }, pointer: null };
    const coloring = {
      light: { stroke: '#111111', background: '#eeeeee' },
      dark: { stroke: '#dddddd', background: '#222222' }
    };
    const localized = {
      type: 'popoverEntryDetails', entryId: 'entry-1', entry,
      kind: {
        id: 'definition',
        name: { type: 'i18n', default_language: 'en', values: { en: 'Definition', 'zh-CN': '定义' } },
        description: { type: 'i18n', default_language: 'en', values: { en: 'Term', 'zh-CN': '术语' } },
        coloring, style: ''
      }
    };
    expect(popoverTerminalDetail(localized, 'entry-1')).toMatchObject({ kind: localized.kind });
    expect(popoverTerminalDetail({
      ...localized,
      kind: { ...localized.kind, name: {
        type: 'i18n', default_language: 'en', values: { en: '  ', 'zh-CN': '' }
      } }
    }, 'entry-1')).toBeNull();
  });

  it('rejects a terminal response from an older snapshot of the same Entry', () => {
    expect(popoverTerminalDetail({
      type: 'popoverEntryDetails',
      entryId: 'entry-1',
      popoverRequestKey: 'old',
      entry: null,
      kind: null
    }, 'entry-1', 'new')).toBeNull();
  });
});
