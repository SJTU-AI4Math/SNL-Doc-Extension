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

/** One live popover in the stack. */
export interface PopoverInstance {
  id: string;
  entryId: string;
  originRect: DOMRect;
  x: number;
  y: number;
  frozen: boolean;
  spawnedFromPopoverId: string | null;
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
const MAX_POPOVER_WIDTH = 460;

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
        { id, entryId, originRect, x, y, frozen: false, spawnedFromPopoverId }
      ]);
      return id;
    },
    [requestDetails]
  );

  const updatePointer = useCallback(
    (popoverId: string, pointerX: number, pointerY: number): void => {
      const { x, y } = clampPointer(pointerX, pointerY);
      setPopovers((prev) =>
        prev.map((p) =>
          p.id === popoverId && !p.frozen ? { ...p, x, y } : p
        )
      );
    },
    []
  );

  const freeze = useCallback((popoverId: string): void => {
    setPopovers((prev) =>
      prev.map((p) => (p.id === popoverId ? { ...p, frozen: true } : p))
    );
  }, []);

  // Dismiss a popover (and any descendants spawned from it).
  const dismissSubtree = useCallback((popoverId: string): void => {
    setPopovers((prev) => {
      const doomed = new Set<string>([popoverId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of prev) {
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
      for (const id of doomed) {
        elementsRef.current.delete(id);
      }
      return prev.filter((p) => !doomed.has(p.id));
    });
  }, []);

  const cancelUnfrozen = useCallback(
    (popoverId: string): void => {
      const target = popoversRef.current.find((p) => p.id === popoverId);
      if (target && !target.frozen) {
        dismissSubtree(popoverId);
      }
    },
    [dismissSubtree]
  );

  const dismissAll = useCallback((): void => {
    elementsRef.current.clear();
    setPopovers([]);
  }, []);

  const isAlive = useCallback((popoverId: string): boolean => {
    return popoversRef.current.some((p) => p.id === popoverId);
  }, []);

  // Frozen-popover batch dismissal: once any popover has frozen, leaving the
  // union of (all origin-macro rects + all live popover rects) kills the stack.
  useEffect(() => {
    function onDocPointerMove(e: PointerEvent): void {
      const live = popoversRef.current;
      if (!live.some((p) => p.frozen)) {
        return;
      }
      const px = e.clientX;
      const py = e.clientY;
      // Inflate hit rects to bridge the pointer→popover offset gap so moving
      // from a frozen popover's origin macro toward the popover doesn't fall
      // into a dead zone and dismiss the stack prematurely.
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

      for (const p of live) {
        if (inside(p.originRect)) {
          return;
        }
        const el = elementsRef.current.get(p.id);
        if (el && inside(el.getBoundingClientRect())) {
          return;
        }
      }
      dismissAll();
    }
    document.addEventListener('pointermove', onDocPointerMove);
    return () => document.removeEventListener('pointermove', onDocPointerMove);
  }, [dismissAll]);

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
                    <div style={{ padding: '0.6rem 0.8rem', color: '#333' }}>
                      Loading…
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
        maxWidth: MAX_POPOVER_WIDTH,
        background: '#ffffff',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        borderRadius: 0,
        overflow: 'auto',
        maxHeight: '80vh'
      }}
    >
      {children}
    </div>
  );
}
