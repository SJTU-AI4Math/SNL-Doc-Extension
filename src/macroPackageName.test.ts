import { describe, expect, it } from 'vitest';
import { isSafeMacroPackageCommandArg } from './macroPackageName';

describe('isSafeMacroPackageCommandArg', () => {
  it('accepts dotted Package IDs with or without the command filename suffix', () => {
    expect(isSafeMacroPackageCommandArg('Lean.Syntax')).toBe(true);
    expect(isSafeMacroPackageCommandArg('Lean.Syntax.json')).toBe(true);
    expect(isSafeMacroPackageCommandArg('Mathlib.Data.Set.json')).toBe(true);
  });

  it('rejects traversal, reserved names, whitespace, and non-strings', () => {
    expect(isSafeMacroPackageCommandArg('../Lean.Syntax.json')).toBe(false);
    expect(isSafeMacroPackageCommandArg('CON.json')).toBe(false);
    expect(isSafeMacroPackageCommandArg('Lean Syntax.json')).toBe(false);
    expect(isSafeMacroPackageCommandArg(42)).toBe(false);
  });
});
