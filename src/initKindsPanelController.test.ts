import { describe, expect, it } from 'vitest';
import { initKindsPanelDescriptor } from './initKindsPanelDescriptor';

describe('initKindsPanelDescriptor', () => {
  it('maps each domain to its host and webview identities', () => {
    expect(initKindsPanelDescriptor('entry')).toMatchObject({
      viewType: 'snlInitEntryKinds', entry: 'initEntryKinds', title: 'SNL Initialize Entry Kinds'
    });
    expect(initKindsPanelDescriptor('macro')).toMatchObject({
      viewType: 'snlInitMacroKinds', entry: 'initMacroKinds', title: 'SNL Initialize Macro Kinds'
    });
  });
});
