import React from 'react';
import { EntryRender, type EntryRenderProps } from './EntryRender';

/**
 * Canonical rendering exit for every Entry surface (reader, editor preview,
 * per-entry view, and recursive hover popover). Surface containers may add
 * navigation or framing, but Entry presentation always passes through here.
 */
export function EntrySurface(props: EntryRenderProps): React.ReactElement {
  return <EntryRender {...props} />;
}

export type {
  EntryData,
  EntryKind,
  EntryOption,
  EntryRenderProps
} from './EntryRender';
