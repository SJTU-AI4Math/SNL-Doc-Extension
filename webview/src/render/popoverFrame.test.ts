import { describe, expect, it } from 'vitest';
import { POPOVER_OUTER_GUTTER_PX, popoverFrameStyle } from './popoverFrame';

describe('popoverFrameStyle', () => {
  it('does not draw a white shell gutter around an inset-framed Entry', () => {
    const style = popoverFrameStyle();
    expect(POPOVER_OUTER_GUTTER_PX).toBe(0);
    expect(style.padding).toBe(0);
    expect(style.boxSizing).toBe('border-box');
  });
});
