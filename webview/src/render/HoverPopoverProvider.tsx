// Hover-preview popover stack for SNL renders.
//
// Popovers can be spawned from ANY EntryRender instance — including from
// EntryRenders that are themselves inside a popover (recursion). The stack
// state therefore lives at the top level of each webview entry (above all
// EntryRender instances) via React context, and popovers are portal-mounted to
// document.body so they escape any container's overflow / stacking context.
//
// Two contexts are exported:
//  - useHoverPopovers()   → the stack API (spawn / follow / freeze / dismiss).
//  - useCurrentPopoverId() → the id of the popover the caller is rendered
//    inside (null at the top level). Used so a nested spawn records its parent.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import {
  EntryRender,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './EntryRender';
import type { SnlMacroDb } from '@snl-basics/react';

/** Life-cycle phase of a popover — used to drive fade-in/out. */
export type PopoverPhase = 'opening' | 'visible' | 'closing';

/** One live popover in the stack. */
export interface PopoverInstance {
  id: string;
  entryId: string;
  originRect: DOMRect;
  x: number;
  y: number;
  frozen: boolean;
  spawnedFromPopoverId: string | null;
  /**
   * 'opening'  — spawned, waiting out the hover delay + entry-details fetch;
   *              rendered with opacity 0 so nothing shows yet.
   * 'visible'  — fade-in complete, fully rendered.
   * 'closing'  — dismiss triggered, fade-out playing; will be swept after
   *              FADE_MS and stops accepting further updates.
   */
  phase: PopoverPhase;
}

export interface HoverPopoverContextValue {
  /** Spawn a popover for `entryId`; returns its new id. */
  spawn: (
    entryId: string,
    originRect: DOMRect,
    pointerX: number,
    pointerY: number,
    spawnedFromPopoverId: string | null
  ) => string;
  /** Move an unfrozen popover to follow the pointer (no-op once frozen). */
  updatePointer: (popoverId: string, pointerX: number, pointerY: number) => void;
  /** Pin a popover at its current position (3s-dwell freeze). */
  freeze: (popoverId: string) => void;
  /** Dismiss a popover only if it hasn't frozen yet. */
  cancelUnfrozen: (popoverId: string) => void;
  /** Dismiss every live popover. */
  dismissAll: () => void;
  /** Whether a popover id is still in the stack. */
  isAlive: (popoverId: string) => boolean;
}

const NOOP_CONTEXT: HoverPopoverContextValue = {
  spawn: () => '',
  updatePointer: () => undefined,
  freeze: () => undefined,
  cancelUnfrozen: () => undefined,
  dismissAll: () => undefined,
  isAlive: () => false
};

const HoverPopoverContext =
  createContext<HoverPopoverContextValue>(NOOP_CONTEXT);
const CurrentPopoverContext = createContext<string | null>(null);

export function useHoverPopovers(): HoverPopoverContextValue {
  return useContext(HoverPopoverContext);
}

export function useCurrentPopoverId(): string | null {
  return useContext(CurrentPopoverContext);
}

const POPOVER_OFFSET = 12;
const VIEWPORT_MARGIN = 8;
/** Cap on popover width — half a typical editor pane feels right. */
const POPOVER_MAX_WIDTH = 720;
/** Delay before an unfrozen popover appears (matches SNL-Basics tooltip UX). */
const HOVER_OPEN_DELAY_MS = 1000;
/** Fade duration for opacity transitions (in ms). */
const FADE_MS = 150;

interface HoverPopoverProviderProps {
  children: React.ReactNode;
  /** Webview→host bridge (for lazy entry-detail requests + openEntryInfoview). */
  postMessage: (msg: unknown) => void;
  /** Entry pool forwarded to popover EntryRenders for macro-source resolution. */
  entries: EntryOption[];
  /** User macro DB forwarded to popover EntryRenders (so popovers render user macros too). */
  userMacros?: SnlMacroDb;
}

let popoverCounter = 0;
function nextPopoverId(): string {
  popoverCounter += 1;
  return `popover-${popoverCounter}`;
}

function clampPointer(pointerX: number, pointerY: number): { x: number; y: number } {
  return { x: pointerX + POPOVER_OFFSET, y: pointerY + POPOVER_OFFSET };
}

export function HoverPopoverProvider({
  children,
  postMessage,
  entries,
  userMacros
}: HoverPopoverProviderProps): React.ReactElement {
  const [popovers, setPopovers] = useState<PopoverInstance[]>([]);
  // Live mirror for stable callbacks / document listeners (avoids stale reads).
  const popoversRef = useRef<PopoverInstance[]>([]);
  popoversRef.current = popovers;

  // Lazily-fetched full details (SNL + kind) keyed by entryId.
  const [details, setDetails] = useState<
    Record<string, { entry: EntryData; kind: EntryKind | null }>
  >({});
  const requestedRef = useRef<Set<string>>(new Set());

  // Live popover DOM elements for accurate hit-testing (post-clamp rects).
  const elementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const registerElement = useCallback(
    (id: string, el: HTMLElement | null): void => {
      if (el) {
        elementsRef.current.set(id, el);
      } else {
        elementsRef.current.delete(id);
      }
    },
    []
  );

  // Host replies with popover entry details.
  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type?: string;
            entryId?: string;
            entry?: EntryData | null;
            kind?: EntryKind | null;
          }
        | undefined;
      if (!msg || msg.type !== 'popoverEntryDetails') {
        return;
      }
      if (typeof msg.entryId === 'string' && msg.entry) {
        const entry = msg.entry;
        const kind = msg.kind ?? null;
        setDetails((prev) => ({ ...prev, [msg.entryId as string]: { entry, kind } }));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const requestDetails = useCallback(
    (entryId: string): void => {
      if (requestedRef.current.has(entryId)) {
        return;
      }
      requestedRef.current.add(entryId);
      postMessage({ type: 'requestEntryDetails', entryId });
    },
    [postMessage]
  );

  // Per-popover timers: delay-open timer + fade-out unmount timer.
  const timersRef = useRef<Map<string, { open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>>(new Map());
  const clearTimerBucket = useCallback((popoverId: string, keys: Array<'open' | 'close'>): void => {
    const bucket = timersRef.current.get(popoverId);
    if (!bucket) return;
    for (const k of keys) {
      const t = bucket[k];
      if (t) {
        clearTimeout(t);
        bucket[k] = undefined;
      }
    }
    if (!bucket.open && !bucket.close) {
      timersRef.current.delete(popoverId);
    }
  }, []);

  const setPhase = useCallback((popoverId: string, phase: PopoverPhase): void => {
    setPopovers((prev) =>
      prev.map((p) => (p.id === popoverId ? { ...p, phase } : p))
    );
  }, []);

  const spawn = useCallback(
    (
      entryId: string,
      originRect: DOMRect,
      pointerX: number,
      pointerY: number,
      spawnedFromPopoverId: string | null
    ): string => {
      const id = nextPopoverId();
      const { x, y } = clampPointer(pointerX, pointerY);
      requestDetails(entryId);
      setPopovers((prev) => [
        ...prev,
        {
          id,
          entryId,
          originRect,
          x,
          y,
          frozen: false,
          spawnedFromPopoverId,
          phase: 'opening'
        }
      ]);
      // Schedule the delay-open transition. If the popover is dismissed
      // before this fires, the corresponding `setPhase` becomes a no-op
      // (id no longer in state) and we clear the timer bookkeeping.
      const openTimer = setTimeout(() => {
        setPhase(id, 'visible');
        const bucket = timersRef.current.get(id);
        if (bucket) bucket.open = undefined;
      }, HOVER_OPEN_DELAY_MS);
      timersRef.current.set(id, { open: openTimer });
      return id;
    },
    [requestDetails, setPhase]
  );

  const updatePointer = useCallback(
    (popoverId: string, pointerX: number, pointerY: number): void => {
      const { x, y } = clampPointer(pointerX, pointerY);
      setPopovers((prev) =>
        prev.map((p) =>
          p.id === popoverId && !p.frozen && p.phase !== 'closing'
            ? { ...p, x, y }
            : p
        )
      );
    },
    []
  );

  const freeze = useCallback((popoverId: string): void => {
    setPopovers((prev) =>
      prev.map((p) =>
        p.id === popoverId && p.phase !== 'closing' ? { ...p, frozen: true } : p
      )
    );
  }, []);

  // Compute the doomed-subtree for a given root id, using the current state.
  const collectSubtree = useCallback(
    (rootId: string, list: PopoverInstance[]): Set<string> => {
      const doomed = new Set<string>([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of list) {
          if (
            p.spawnedFromPopoverId &&
            doomed.has(p.spawnedFromPopoverId) &&
            !doomed.has(p.id)
          ) {
            doomed.add(p.id);
            grew = true;
          }
        }
      }
      return doomed;
    },
    []
  );

  // Dismiss a popover (and its descendants). 'opening' popovers are removed
  // immediately (they were never visible); everything else transitions to
  // 'closing' first so the CSS opacity transition can play, then is swept
  // from state after FADE_MS.
  const dismissSubtree = useCallback(
    (popoverId: string): void => {
      const list = popoversRef.current;
      const doomed = collectSubtree(popoverId, list);
      const toRemoveNow: string[] = [];
      const toFade: string[] = [];
      for (const p of list) {
        if (!doomed.has(p.id)) continue;
        if (p.phase === 'opening') {
          toRemoveNow.push(p.id);
        } else if (p.phase !== 'closing') {
          toFade.push(p.id);
        }
      }
      if (toRemoveNow.length > 0) {
        for (const id of toRemoveNow) {
          clearTimerBucket(id, ['open', 'close']);
          elementsRef.current.delete(id);
        }
        setPopovers((prev) => prev.filter((p) => !toRemoveNow.includes(p.id)));
      }
      if (toFade.length > 0) {
        // Cancel any pending open-delay for popovers that are now closing.
        for (const id of toFade) {
          clearTimerBucket(id, ['open']);
        }
        setPopovers((prev) =>
          prev.map((p) =>
            toFade.includes(p.id) ? { ...p, phase: 'closing' as const } : p
          )
        );
        for (const id of toFade) {
          const closeTimer = setTimeout(() => {
            elementsRef.current.delete(id);
            setPopovers((prev) => prev.filter((p) => p.id !== id));
            clearTimerBucket(id, ['close']);
          }, FADE_MS);
          const existing = timersRef.current.get(id) ?? {};
          existing.close = closeTimer;
          timersRef.current.set(id, existing);
        }
      }
    },
    [clearTimerBucket, collectSubtree]
  );

  const cancelUnfrozen = useCallback(
    (popoverId: string): void => {
      const target = popoversRef.current.find((p) => p.id === popoverId);
      if (target && !target.frozen && target.phase !== 'closing') {
        dismissSubtree(popoverId);
      }
    },
    [dismissSubtree]
  );

  const dismissAll = useCallback((): void => {
    const ids = popoversRef.current
      .filter((p) => p.phase !== 'closing')
      .map((p) => p.id);
    for (const id of ids) {
      dismissSubtree(id);
    }
  }, [dismissSubtree]);

  const isAlive = useCallback((popoverId: string): boolean => {
    return popoversRef.current.some(
      (p) => p.id === popoverId && p.phase !== 'closing'
    );
  }, []);

  // Cleanup all pending timers on provider unmount so stale timeouts can't
  // fire against a torn-down component tree.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const bucket of timers.values()) {
        if (bucket.open) clearTimeout(bucket.open);
        if (bucket.close) clearTimeout(bucket.close);
      }
      timers.clear();
    };
  }, []);

  // Document-level union hit-test: pointer position vs the union of every
  // live popover's originating-macro rect + its own rect (post-portal).
  // When the pointer is outside the union, dismiss any UNFROZEN popover
  // (they were following the pointer and lost it). Frozen popovers get
  // dismissed en masse only when NO popover in the stack — frozen or not —
  // is under the pointer, matching the spec: "leave the union of all live
  // popover rects and originating-macro rects → dismiss".
  //
  // Runs unconditionally (not gated on "any frozen") because the pre-freeze
  // window is exactly when the pointer needs to be able to bridge from the
  // origin macro onto the portal-mounted popover DOM. Without this we'd
  // never let the user reach the popover to read it.
  useEffect(() => {
    function onDocPointerMove(e: PointerEvent): void {
      const live = popoversRef.current.filter((p) => p.phase !== 'closing');
      if (live.length === 0) {
        return;
      }
      const px = e.clientX;
      const py = e.clientY;
      // Inflate hit rects to bridge the pointer→popover offset gap so
      // moving from a macro toward its popover doesn't fall into a dead
      // zone and dismiss the stack prematurely.
      const pad = POPOVER_OFFSET + 8;
      const inside = (r: {
        left: number;
        top: number;
        right: number;
        bottom: number;
      }): boolean =>
        px >= r.left - pad &&
        px <= r.right + pad &&
        py >= r.top - pad &&
        py <= r.bottom + pad;

      // Which popovers is the pointer currently in the influence area of?
      const insideIds = new Set<string>();
      for (const p of live) {
        if (inside(p.originRect)) {
          insideIds.add(p.id);
          continue;
        }
        const el = elementsRef.current.get(p.id);
        if (el && inside(el.getBoundingClientRect())) {
          insideIds.add(p.id);
        }
      }

      if (insideIds.size === 0) {
        // Outside everything → kill the whole stack.
        dismissAll();
        return;
      }

      // Inside at least one popover's influence area: unfrozen popovers
      // that lost the pointer (are neither under it nor an ancestor of one
      // that is) should die. Ancestors of any inside popover are kept alive
      // because the recursion invariant says the parent's popover stays
      // as long as any descendant is in play.
      const keepAlive = new Set<string>(insideIds);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of live) {
          if (
            keepAlive.has(p.id) &&
            p.spawnedFromPopoverId &&
            !keepAlive.has(p.spawnedFromPopoverId)
          ) {
            keepAlive.add(p.spawnedFromPopoverId);
            grew = true;
          }
        }
      }
      for (const p of live) {
        if (!keepAlive.has(p.id) && !p.frozen) {
          dismissSubtree(p.id);
        }
      }
    }
    document.addEventListener('pointermove', onDocPointerMove);
    return () => document.removeEventListener('pointermove', onDocPointerMove);
  }, [dismissAll, dismissSubtree]);

  const ctx = useMemo<HoverPopoverContextValue>(
    () => ({
      spawn,
      updatePointer,
      freeze,
      cancelUnfrozen,
      dismissAll,
      isAlive
    }),
    [spawn, updatePointer, freeze, cancelUnfrozen, dismissAll, isAlive]
  );

  return (
    <HoverPopoverContext.Provider value={ctx}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <>
            {popovers.map((p, index) => (
              <PopoverView
                key={p.id}
                instance={p}
                zIndex={1000 + index}
                registerElement={registerElement}
              >
                <CurrentPopoverContext.Provider value={p.id}>
                  {details[p.entryId] ? (
                    <EntryRender
                      entry={details[p.entryId].entry}
                      kind={details[p.entryId].kind}
                      entries={entries}
                      postMessage={postMessage}
                      userMacros={userMacros}
                      counterLabel={undefined}
                      disableTitleJump={false}
                      onTitleCtrlClick={(entryId) =>
                        postMessage({ type: 'openEntryInfoview', entryId })
                      }
                    />
                  ) : (
                    <div
                      style={{
                        padding: '0.6rem 0.8rem',
                        color: '#333',
                        fontFamily: 'var(--vscode-editor-font-family, monospace)',
                        fontSize: '0.85rem',
                        minWidth: '18rem'
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>
                        Loading entry…
                      </div>
                      <div>id: <code>{p.entryId}</code></div>
                      <div>
                        request sent: {requestedRef.current.has(p.entryId) ? 'yes' : 'no'}
                      </div>
                      <div>
                        details map keys: [{Object.keys(details).join(', ') || '—'}]
                      </div>
                    </div>
                  )}
                </CurrentPopoverContext.Provider>
              </PopoverView>
            ))}
          </>,
          document.body
        )}
    </HoverPopoverContext.Provider>
  );
}

function PopoverView({
  instance,
  zIndex,
  registerElement,
  children
}: {
  instance: PopoverInstance;
  zIndex: number;
  registerElement: (id: string, el: HTMLElement | null) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: instance.x,
    top: instance.y
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    let left = instance.x;
    let top = instance.y;
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - rect.width);
    }
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - rect.height);
    }
    setPos({ left, top });
  }, [instance.x, instance.y]);

  useEffect(() => {
    const el = ref.current;
    registerElement(instance.id, el);
    return () => registerElement(instance.id, null);
  }, [instance.id, registerElement]);

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex,
        // Width is content-driven, capped at POPOVER_MAX_WIDTH so a very long
        // SNL body still stays bounded. Height is capped at 80vh with scroll.
        maxWidth: POPOVER_MAX_WIDTH,
        width: 'max-content',
        background: '#ffffff',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        borderRadius: 0,
        overflow: 'auto',
        maxHeight: '80vh',
        // Fade-in/out. Never render a closing popover at full opacity, and
        // never render an opening popover before its delay-open fires.
        opacity: instance.phase === 'visible' ? 1 : 0,
        transition: `opacity ${FADE_MS}ms ease-in-out`,
        // While opening/closing don't intercept pointer events — the origin
        // macro or the enclosing document should still receive them.
        pointerEvents: instance.phase === 'visible' ? 'auto' : 'none'
      }}
    >
      {children}
    </div>
  );
}
