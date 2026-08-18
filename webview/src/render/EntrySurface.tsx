import React from 'react';
import { EntryRender, type EntryRenderProps } from './EntryRender';
import { CollapsibleScope } from './CollapsibleScope';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import './EntrySurface.css';

const MESSAGES = defineUiMessages(
  'entrySurface',
  { scopeLabel: 'Entry {id}' },
  { scopeLabel: '条目 {id}' }
);

interface EntryWheelEvent {
  readonly shiftKey: boolean;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly target: EventTarget | null;
  preventDefault(): void;
}

function isHorizontalScroller(element: HTMLElement): boolean {
  const overflowX = window.getComputedStyle(element).overflowX;
  return (overflowX === 'auto' || overflowX === 'scroll') &&
    element.scrollWidth > element.clientWidth;
}

/**
 * Translate Shift+wheel into horizontal movement for the nearest real
 * horizontal scroller inside an Entry. Plain wheel events are deliberately
 * untouched so the surrounding page keeps normal vertical scrolling.
 */
export function handleEntryShiftWheel(
  event: EntryWheelEvent,
  surface: HTMLDivElement
): void {
  if (!event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const body = target.closest<HTMLElement>('[data-entry-body]');
  if (!body || !surface.contains(body)) return;

  const rawDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
    ? event.deltaX
    : event.deltaY;
  if (!Number.isFinite(rawDelta) || rawDelta === 0) return;

  const candidates: HTMLElement[] = [];
  let candidate = target instanceof HTMLElement ? target : target.parentElement;
  while (candidate && body.contains(candidate)) {
    if (candidate !== body && isHorizontalScroller(candidate)) candidates.push(candidate);
    if (candidate === body) break;
    candidate = candidate.parentElement;
  }
  if (body.scrollWidth > body.clientWidth) candidates.push(body);

  for (const scroller of candidates) {
    const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? rawDelta * 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? rawDelta * Math.max(1, scroller.clientWidth)
        : rawDelta;
    const nextScrollLeft = Math.max(
      0,
      Math.min(maxScrollLeft, scroller.scrollLeft + delta)
    );
    if (nextScrollLeft === scroller.scrollLeft) continue;
    event.preventDefault();
    scroller.scrollLeft = nextScrollLeft;
    return;
  }
}

/**
 * Canonical rendering exit for every Entry surface (reader, editor preview,
 * per-entry view, and recursive hover popover). Surface containers may add
 * navigation or framing, but Entry presentation always passes through here.
 */
export function EntrySurface(props: EntryRenderProps): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  // Layout-only tests intentionally render this wrapper with minimal mocked
  // props; production still resets by the real Entry identity.
  const entryId = (props.entry as { id?: string } | undefined)?.id ?? 'entry';

  React.useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    // React 19 delegates wheel passively, so preventDefault() in onWheel cannot
    // suppress Chromium's own Shift+wheel mapping. This listener must be native
    // and explicitly non-passive to guarantee exactly one horizontal movement.
    const onWheel = (event: WheelEvent): void => handleEntryShiftWheel(event, surface);
    surface.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => surface.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  return (
    <div ref={surfaceRef} className="snl-entry-overflow-surface">
      <CollapsibleScope resetKey={entryId} label={t('scopeLabel', { id: entryId })}>
        <EntryRender {...props} />
      </CollapsibleScope>
    </div>
  );
}

export type {
  EntryData,
  EntryKind,
  EntryOption,
  EntryRenderProps
} from './EntryRender';
export { isEntryDataPayload, isEntryKindPayload } from './EntryRender';
