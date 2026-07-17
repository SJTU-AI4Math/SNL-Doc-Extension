import { describe, expect, it } from 'vitest';
import { kindPanelDescriptor } from './kindPanelDescriptor';

describe('kindPanelDescriptor', () => {
  it('maps both kind editors to their panel identities', () => {
    expect(kindPanelDescriptor('entry')).toMatchObject({ viewType: 'snlCreateEntryKind', entry: 'createEntryKind' });
    expect(kindPanelDescriptor('macro')).toMatchObject({ viewType: 'snlCreateMacroKind', entry: 'createMacroKind' });
  });
});
