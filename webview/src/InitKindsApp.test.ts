import { describe, expect, it } from 'vitest';
import { kindInitializationCopy } from './InitKindsApp';

describe('kindInitializationCopy', () => {
  it('derives entry and macro copy from one descriptor', () => {
    expect(kindInitializationCopy('entry')).toMatchObject({
      title: 'Initialize Entry Kinds',
      configKey: 'entry_kinds',
      singular: 'entry kind'
    });
    expect(kindInitializationCopy('macro')).toMatchObject({
      title: 'Initialize Macro Kinds',
      configKey: 'macro_kinds',
      singular: 'macro kind'
    });
  });
});
