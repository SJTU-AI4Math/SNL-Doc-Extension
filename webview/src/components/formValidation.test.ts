import { describe, expect, it } from 'vitest';
import {
  areEntityReferencesResolved,
  isEntityIdUnique
} from './formValidation';

const entries = [
  { id: 'ctx', title: 'Context', hasContent: true },
  { id: 'other', title: 'Other', hasContent: false }
];

describe('entity form validation', () => {
  it('rejects a duplicate create id while allowing the current edit id', () => {
    expect(isEntityIdUnique('ctx', entries)).toBe(false);
    expect(isEntityIdUnique('ctx', entries, 'ctx')).toBe(true);
    expect(isEntityIdUnique('fresh', entries)).toBe(true);
  });

  it('requires every non-empty entity reference to resolve', () => {
    expect(areEntityReferencesResolved(['ctx', ' other ', ''], entries)).toBe(true);
    expect(areEntityReferencesResolved(['ctx', 'missing'], entries)).toBe(false);
  });
});
