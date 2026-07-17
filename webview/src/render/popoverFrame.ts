import type React from 'react';

/** EntryRender reveals a 5px paint-only outline on hover. */
export const POPOVER_ENTRY_FRAME_INSET_PX = 5;

/** Reserve an inner gutter so a scrolling popover does not clip that outline. */
export function popoverFrameStyle(): React.CSSProperties {
  return {
    padding: `${POPOVER_ENTRY_FRAME_INSET_PX}px`,
    boxSizing: 'border-box'
  };
}
