import { describe, expect, it } from 'vitest';
import { normalizeEntryContributor } from './entryContributor';

describe('temporary Entry Contributor schema', () => {
  it('accepts exactly one string and trims surrounding whitespace', () => {
    expect(normalizeEntryContributor('  Ada Lovelace  ')).toBe('Ada Lovelace');
    expect(normalizeEntryContributor('')).toBeNull();
  });

  it('keeps entries without Contributor backward compatible', () => {
    expect(normalizeEntryContributor(undefined)).toBeNull();
    expect(normalizeEntryContributor(null)).toBeNull();
  });

  it.each([{ name: 'Ada' }, ['Ada', 'Grace'], 7])(
    'rejects object, array, and other non-string Contributor shapes',
    (value) => {
      expect(() => normalizeEntryContributor(value)).toThrow(/Contributor must be a single string/i);
    }
  );
});
