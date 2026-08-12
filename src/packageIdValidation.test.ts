import { describe, expect, it } from 'vitest';
import { validatePackageId } from './packageIdValidation';

describe('Package ID validation', () => {
  it.each(['con', 'PRN', 'LPT1'])('rejects Windows-reserved ID %s on every OS', (id) => {
    expect(validatePackageId(id)).toBe('reserved-windows-name');
  });

  it.each(['../bad', 'bad.json', '', 'with space'])('rejects malformed ID %s', (id) => {
    expect(validatePackageId(id)).toBe('invalid-format');
  });

  it.each(['logic', 'logic.valid-1', '_unpackaged'])('accepts valid ID %s', (id) => {
    expect(validatePackageId(id)).toBeNull();
  });
});
