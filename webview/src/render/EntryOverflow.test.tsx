// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./EntryRender', () => ({
  EntryRender: () => (
    <section data-entry-id="wide">
      <div data-entry-body="snl">
        <div data-overflow-visible style={{ overflowX: 'visible' }}>
          <span data-wide-content>wide content</span>
        </div>
        <pre data-inner-scroll><span data-inner-content>wide code</span></pre>
      </div>
    </section>
  )
}));

import { EntrySurface, handleEntryShiftWheel } from './EntrySurface';

const entrySurfaceCss = readFileSync(
  path.join(process.cwd(), 'webview/src/render/EntrySurface.css'),
  'utf8'
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWideEntry(): {
  body: HTMLElement;
  content: HTMLElement;
} {
  const props = {} as React.ComponentProps<typeof EntrySurface>;
  const view = render(<EntrySurface {...props} />);
  const body = view.container.querySelector<HTMLElement>('[data-entry-body]')!;
  const content = view.container.querySelector<HTMLElement>('[data-wide-content]')!;
  Object.defineProperties(body, {
    clientWidth: { configurable: true, value: 200 },
    scrollWidth: { configurable: true, value: 800 }
  });
  body.scrollLeft = 0;
  return { body, content };
}

describe('EntrySurface horizontal overflow', () => {
  it('keeps overflow local and hides the horizontal scrollbar', () => {
    expect(entrySurfaceCss).toContain('[data-entry-body]');
    expect(entrySurfaceCss).toContain('overflow-x: auto');
    expect(entrySurfaceCss).toContain('scrollbar-width: none');
    expect(entrySurfaceCss).toContain('[data-entry-body] .snl-markdown-body pre');
    expect(entrySurfaceCss).not.toMatch(/\[data-entry-body\]\s+pre\s*\{/);
    expect(entrySurfaceCss).toContain('::-webkit-scrollbar');
  });

  it('wraps only defensive plain and textual leaves while preserving code and formulas', () => {
    expect(entrySurfaceCss).toMatch(
      /\[data-entry-body\]\s*>\s*pre\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*pre-wrap/s
    );
    expect(entrySurfaceCss).toMatch(
      /\.snl-text:not\(pre \*\):not\(\.katex \*\)\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s
    );
    expect(entrySurfaceCss).toMatch(
      /\.snl-markdown-body\s+p\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s
    );
    expect(entrySurfaceCss).not.toMatch(/\.snl-markdown-body\s+pre\s*\{[^}]*white-space:\s*pre-wrap/s);
    expect(entrySurfaceCss).not.toMatch(/\.katex\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  });

  it('resets inherited emergency wrapping inside nested formula and code islands', () => {
    expect(entrySurfaceCss).toMatch(
      /\.snl-text\s+:is\([^)]*\.katex[^)]*\.katex \*[^)]*pre[^)]*code[^)]*\)\s*\{[^}]*overflow-wrap:\s*normal[^}]*word-break:\s*normal/s
    );
  });

  it('keeps ordinary EntrySurface wrappers out of the sequential tab order', () => {
    const { content } = renderWideEntry();
    const surface = content.closest<HTMLDivElement>('.snl-entry-overflow-surface')!;
    expect(surface.hasAttribute('tabindex')).toBe(false);
    expect(surface.tabIndex).toBe(-1);

    content.tabIndex = 0;
    content.focus();
    expect(document.activeElement).toBe(content);
  });

  it('registers a non-passive native wheel listener', () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    renderWideEntry();
    expect(add.mock.calls.some(([type, _listener, options]) =>
      type === 'wheel' &&
      typeof options === 'object' &&
      options !== null &&
      options.capture === true &&
      options.passive === false
    )).toBe(true);
  });

  it('uses Shift+wheel to scroll the Entry body horizontally', () => {
    const { body, content } = renderWideEntry();
    fireEvent.wheel(content, { shiftKey: true, deltaY: 120 });
    expect(body.scrollLeft).toBe(120);

    fireEvent.wheel(content, { shiftKey: true, deltaY: 1000 });
    expect(body.scrollLeft).toBe(600);
    fireEvent.wheel(content, { shiftKey: true, deltaY: -1000 });
    expect(body.scrollLeft).toBe(0);
  });

  it('prevents browser fallback only when Shift+wheel is consumed', () => {
    const { body, content } = renderWideEntry();
    const surface = content.closest<HTMLDivElement>('.snl-entry-overflow-surface')!;
    const preventDefault = vi.fn();
    handleEntryShiftWheel({
      shiftKey: true,
      deltaX: 75,
      deltaY: 0,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      target: content,
      preventDefault
    }, surface);
    expect(body.scrollLeft).toBe(75);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('normalizes line and page wheel deltas', () => {
    const { body, content } = renderWideEntry();
    const surface = content.closest<HTMLDivElement>('.snl-entry-overflow-surface')!;
    const base = {
      shiftKey: true,
      deltaX: 0,
      target: content,
      preventDefault: vi.fn()
    };
    handleEntryShiftWheel({
      ...base,
      deltaY: 2,
      deltaMode: WheelEvent.DOM_DELTA_LINE
    }, surface);
    expect(body.scrollLeft).toBe(32);

    body.scrollLeft = 0;
    handleEntryShiftWheel({
      ...base,
      deltaY: 1,
      deltaMode: WheelEvent.DOM_DELTA_PAGE
    }, surface);
    expect(body.scrollLeft).toBe(200);
  });

  it('skips overflow-visible KaTeX-style wrappers', () => {
    const { body, content } = renderWideEntry();
    const visible = content.parentElement!;
    Object.defineProperties(visible, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 700 }
    });

    fireEvent.wheel(content, { shiftKey: true, deltaY: 90 });
    expect(visible.scrollLeft).toBe(0);
    expect(body.scrollLeft).toBe(90);
  });

  it('prefers a nested overflowing code block under the pointer', () => {
    const { body } = renderWideEntry();
    const inner = body.querySelector<HTMLElement>('[data-inner-scroll]')!;
    const innerContent = inner.querySelector<HTMLElement>('[data-inner-content]')!;
    inner.style.overflowX = 'auto';
    Object.defineProperties(inner, {
      clientWidth: { configurable: true, value: 150 },
      scrollWidth: { configurable: true, value: 500 }
    });
    inner.scrollLeft = 0;

    fireEvent.wheel(innerContent, { shiftKey: true, deltaY: 80 });
    expect(inner.scrollLeft).toBe(80);
    expect(body.scrollLeft).toBe(0);
  });

  it('chains from a nested scroller boundary to the Entry body', () => {
    const { body } = renderWideEntry();
    const inner = body.querySelector<HTMLElement>('[data-inner-scroll]')!;
    const innerContent = inner.querySelector<HTMLElement>('[data-inner-content]')!;
    inner.style.overflowX = 'auto';
    Object.defineProperties(inner, {
      clientWidth: { configurable: true, value: 150 },
      scrollWidth: { configurable: true, value: 500 }
    });

    inner.scrollLeft = 350;
    body.scrollLeft = 0;
    fireEvent.wheel(innerContent, { shiftKey: true, deltaY: 80 });
    expect(inner.scrollLeft).toBe(350);
    expect(body.scrollLeft).toBe(80);

    inner.scrollLeft = 0;
    body.scrollLeft = 100;
    fireEvent.wheel(innerContent, { shiftKey: true, deltaY: -60 });
    expect(inner.scrollLeft).toBe(0);
    expect(body.scrollLeft).toBe(40);
  });

  it('does not consume Shift+wheel when no horizontal scroller can move', () => {
    const { body, content } = renderWideEntry();
    const surface = content.closest<HTMLDivElement>('.snl-entry-overflow-surface')!;
    body.scrollLeft = 600;
    const preventDefault = vi.fn();
    handleEntryShiftWheel({
      shiftKey: true,
      deltaX: 0,
      deltaY: 50,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      target: content,
      preventDefault
    }, surface);
    expect(body.scrollLeft).toBe(600);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('leaves ordinary vertical wheel scrolling untouched', () => {
    const { body, content } = renderWideEntry();
    expect(fireEvent.wheel(content, { deltaY: 120 })).toBe(true);
    expect(body.scrollLeft).toBe(0);
  });
});
