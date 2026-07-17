import { describe, expect, it } from 'vitest';
import { POPOVER_ENTRY_FRAME_INSET_PX, popoverFrameStyle } from './popoverFrame';

describe('popoverFrameStyle', () => {
  it('reserves room inside the scrolling popover for EntryRender hover stroke', () => {
    const style = popoverFrameStyle();
    expect(POPOVER_ENTRY_FRAME_INSET_PX).toBe(5);
    expect(style.padding).toBe(`${POPOVER_ENTRY_FRAME_INSET_PX}px`);
    expect(style.boxSizing).toBe('border-box');
  });
});
