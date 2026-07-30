// Behavioural tests for hover popovers in an EXPORTED document.
//
// Same discipline as `exportRuntimeBehavior.test.tsx`: read the real
// `media/exportRuntime.js` and EXECUTE it, because the bug class this feature
// exists to fix ("the exported file has no popovers at all") is invisible to
// any assertion made against source text.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPORT_RUNTIME_JS = readFileSync(
  resolve(__dirname, '../../../media/exportRuntime.js'),
  'utf8'
);

/** Matches the runtime's own open delay; kept local so a drift shows up. */
const OPEN_DELAY_MS = 1000;

const BODY = `
<main class="snl-export">
  <section data-entry-id="root">
    <div data-entry-body="snl">
      <span id="ref-a" data-src="entry-a">A</span>
      <span id="ref-missing" data-src="entry-absent">?</span>
    </div>
  </section>
</main>`;

const POPOVERS: Record<string, string> = {
  'entry-a': `<section data-entry-id="entry-a"><div data-entry-body="snl">
      <b id="a-body">body of A</b>
      <span id="ref-b" data-src="entry-b">B</span>
    </div></section>`,
  'entry-b': `<section data-entry-id="entry-b"><div data-entry-body="snl">
      <b id="b-body">body of B</b>
    </div></section>`
};

function boot(payload: Record<string, string> | undefined): void {
  document.body.innerHTML = BODY;
  if (payload === undefined) {
    delete (window as unknown as Record<string, unknown>).__SNL_POPOVERS__;
  } else {
    (window as unknown as Record<string, unknown>).__SNL_POPOVERS__ = payload;
  }
  // eslint-disable-next-line no-eval
  (0, eval)(EXPORT_RUNTIME_JS);
}

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

function mouseover(el: Element, x = 40, y = 40): void {
  el.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y })
  );
}
function mouseout(el: Element, related: Element | null = null): void {
  const event = new MouseEvent('mouseout', { bubbles: true });
  Object.defineProperty(event, 'relatedTarget', { value: related });
  el.dispatchEvent(event);
}

const panels = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.snl-export-popover'));

describe('exported document popovers, executed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    delete (window as unknown as Record<string, unknown>).__SNL_POPOVERS__;
  });

  it('shows the pre-rendered fragment after the hover delay', () => {
    boot(POPOVERS);
    mouseover(byId('ref-a'));
    expect(panels()).toHaveLength(0); // not before the delay
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(1);
    expect(panels()[0].querySelector('#a-body')?.textContent).toBe('body of A');
    expect(panels()[0].getAttribute('data-snl-popover')).toBe('entry-a');
  });

  it('opens nothing for a reference the payload does not carry', () => {
    boot(POPOVERS);
    mouseover(byId('ref-missing'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(0);
  });

  it('degrades silently when the document ships without a payload', () => {
    boot(undefined);
    mouseover(byId('ref-a'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(0);
    // Collapse/highlight wiring must still have installed.
    expect(document.querySelector('.snl-export')).not.toBeNull();
  });

  it('stays open while the pointer is over the popover itself', () => {
    boot(POPOVERS);
    mouseover(byId('ref-a'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    const panel = panels()[0];
    // Leaving the anchor towards the panel, then entering the panel.
    mouseout(byId('ref-a'), panel);
    panel.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    expect(panels()).toHaveLength(1);
  });

  it('does not open after the pointer has already left the reference', () => {
    boot(POPOVERS);
    const anchor = byId('ref-a');
    mouseover(anchor);
    // The destination is still inside the delegated main container. Treating
    // that as "still over the anchor" was the production bug.
    mouseout(anchor, byId('ref-missing'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(0);
  });

  it('closes when the pointer leaves a reference for ordinary document content', () => {
    boot(POPOVERS);
    const anchor = byId('ref-a');
    mouseover(anchor);
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(1);

    mouseout(anchor, byId('ref-missing'));
    vi.advanceTimersByTime(2000);
    expect(panels()).toHaveLength(0);
  });

  it('closes once the pointer leaves anchor and popover both', () => {
    boot(POPOVERS);
    mouseover(byId('ref-a'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    panels()[0].dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(2000);
    expect(panels()).toHaveLength(0);
  });

  it('stacks a second popover for a reference INSIDE the first', () => {
    boot(POPOVERS);
    mouseover(byId('ref-a'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    const nestedRef = panels()[0].querySelector('#ref-b');
    expect(nestedRef).not.toBeNull();
    mouseover(nestedRef as Element, 200, 200);
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(2);
    expect(panels()[1].getAttribute('data-snl-popover')).toBe('entry-b');
    expect(panels()[1].querySelector('#b-body')).not.toBeNull();
  });

  it('disposes the child stack when the pointer returns to the base level', () => {
    boot(POPOVERS);
    mouseover(byId('ref-a'));
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    mouseover(panels()[0].querySelector('#ref-b') as Element, 200, 200);
    vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
    expect(panels()).toHaveLength(2);

    // Leave the whole first popover: level 0 and everything above it goes.
    panels()[0].dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(2000);
    expect(panels()).toHaveLength(0);
  });

  it('keeps the panel inside the viewport instead of overflowing right', () => {
    boot(POPOVERS);
    // jsdom reports zero-size rects, so pin a width the placement can use.
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return { width: 600, height: 200, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      mouseover(byId('ref-a'), window.innerWidth - 5, 10);
      vi.advanceTimersByTime(OPEN_DELAY_MS + 10);
      const left = parseFloat(panels()[0].style.left);
      expect(left + 600).toBeLessThanOrEqual(window.innerWidth);
      expect(left).toBeGreaterThanOrEqual(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });
});
