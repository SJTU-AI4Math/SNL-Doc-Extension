import { describe, expect, it } from 'vitest';
import { maxMacroTemplateChildIndex } from './macroPreviewPlaceholders';

describe('Macro preview placeholder grammar', () => {
  it('uses the shared escape-aware renderer grammar', () => {
    expect(maxMacroTemplateChildIndex('#0 + #12')).toBe(12);
    expect(maxMacroTemplateChildIndex('\\#99 + #1')).toBe(1);
    expect(maxMacroTemplateChildIndex('#100')).toBe(-1);
  });
});
