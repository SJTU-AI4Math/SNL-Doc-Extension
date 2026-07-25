import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MacroIdInput } from './MacroIdInput';

describe('MacroIdInput', () => {
  it('provides one shared single-line Macro ID input', () => {
    const onChange = vi.fn();
    const view = render(
      <MacroIdInput value="foo" onChange={onChange} aria-label="Macro ID" />
    );
    const input = view.getByRole('textbox', { name: 'Macro ID' });
    fireEvent.change(input, { target: { value: 'bar' } });
    expect(onChange).toHaveBeenCalledWith('bar');
    expect(input.tagName).toBe('INPUT');
  });

  it('supports an auto-sized multiline SNL editing mode', () => {
    const view = render(
      <MacroIdInput
        multiline
        autoSize
        value={'root(\n  child\n)'}
        onChange={() => undefined}
        aria-label="Focused SNL"
      />
    );
    const textarea = view.getByRole('textbox', { name: 'Focused SNL' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.style.width).toContain('ch');
    expect(textarea.getAttribute('rows')).toBe('3');
  });
});
