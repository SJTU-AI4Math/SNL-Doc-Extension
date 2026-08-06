// Fetch one Entry's full record from the extension host, promise-shaped.
//
// ── Why reuse `requestEntryDetails` instead of adding a bulk message ─────────
//
// The host already answers `{type:'requestEntryDetails', entryId}` with
// `{type:'popoverEntryDetails', entryId, entry, kind}` (see
// `src/infoviewPanel.ts`), which is EXACTLY the record a popover needs — the
// panel's own popovers are built on it. Adding a "send me everything" message
// would mean a second host code path answering the same question, and it could
// not be used anyway: the closure is discovered incrementally (an Entry's
// references are only known once it has been rendered), so there is no id list
// to bulk-request up front. Driving the existing per-id channel keeps one
// source of truth and needed no host change at all.
//
// The one thing missing from the raw channel is a correlation handle, since
// replies arrive as global window messages. This module adds that.

import type { EntryData, EntryKind, EntryOption } from '../render/EntrySurface';
import { entryDetailsRequest } from '../render/HoverPopoverProvider';

export interface EntryDetail {
  entry: EntryData | null;
  kind: EntryKind | null;
}

export interface DetailBridgeOptions {
  postMessage: (msg: unknown) => void;
  /** Injected in tests. */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** A host that never answers must not hang the whole export. */
  timeoutMs?: number;
  /** Stable identities for exact current-storage reads. */
  entries?: EntryOption[];
  /** Operation-local identities for Entries omitted from the rendered pool. */
  entryPackages?: Readonly<Record<string, string>>;
}

export const DETAIL_TIMEOUT_MS = 5000;

/**
 * Build a memoised `entryId → EntryDetail` loader.
 *
 * Memoisation matters twice over: cycles in the reference graph would
 * otherwise re-ask forever, and a diamond (A→B, A→C, B→D, C→D) would ask for
 * D twice.
 */
export function createEntryDetailLoader(
  options: DetailBridgeOptions
): (entryId: string) => Promise<EntryDetail> {
  const target = options.target ?? window;
  const timeoutMs = options.timeoutMs ?? DETAIL_TIMEOUT_MS;
  const cache = new Map<string, Promise<EntryDetail>>();

  return (entryId: string): Promise<EntryDetail> => {
    const hit = cache.get(entryId);
    if (hit) return hit;

    const pending = new Promise<EntryDetail>((resolve) => {
      let done = false;
      const finish = (detail: EntryDetail): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        target.removeEventListener('message', onMessage as EventListener);
        resolve(detail);
      };
      function onMessage(event: MessageEvent): void {
        const msg = event.data as
          | { type?: string; entryId?: string; entry?: EntryData | null; kind?: EntryKind | null }
          | undefined;
        if (!msg || msg.type !== 'popoverEntryDetails' || msg.entryId !== entryId) return;
        finish({ entry: msg.entry ?? null, kind: msg.kind ?? null });
      }
      // Treat silence as "unknown Entry" rather than an error: a missing
      // popover is a degraded export, a rejected promise is a failed one.
      const timer = setTimeout(() => finish({ entry: null, kind: null }), timeoutMs);
      target.addEventListener('message', onMessage as EventListener);
      options.postMessage(entryDetailsRequest(
        entryId,
        options.entries ?? [],
        options.entryPackages
      ));
    });

    cache.set(entryId, pending);
    return pending;
  };
}
