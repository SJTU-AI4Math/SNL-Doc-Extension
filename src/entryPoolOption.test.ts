import { describe, expect, it } from 'vitest';
import { toEntryOption } from './entryPoolOption';

describe('toEntryOption', () => {
  it('preserves raw SNL so editor previews can resolve cross-entry bvars', () => {
    expect(
      toEntryOption({
        id: 'ctx',
        title: 'Context',
        content: { snl: 'context(@x)' }
      })
    ).toEqual({
      id: 'ctx',
      title: 'Context',
      hasContent: true,
      snl: 'context(@x)'
    });
  });

  it('preserves package identity for current-storage point-read popovers', () => {
    expect(toEntryOption({
      id: 'ctx', package: 'logic', title: 'Context', content: { snl: 'x' }
    })).toMatchObject({ id: 'ctx', package: 'logic' });
  });

  it('treats whitespace-only SNL as no content while preserving the source', () => {
    expect(
      toEntryOption({ id: 'empty', title: '', content: { snl: '   ' } })
    ).toEqual({
      id: 'empty',
      title: '',
      hasContent: false,
      snl: '   '
    });
  });
});
