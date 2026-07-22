import type React from 'react';

/**
 * Entry hover feedback is painted inside EntryRender, so the popover shell
 * must not reserve a white gutter around it.
 */
export const POPOVER_OUTER_GUTTER_PX = 0;

export function popoverFrameStyle(): React.CSSProperties {
  return {
    padding: POPOVER_OUTER_GUTTER_PX,
    boxSizing: 'border-box'
  };
}
