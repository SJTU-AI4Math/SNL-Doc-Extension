import React from 'react';
import { cleanup, createEvent, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MacroDataDriver, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import {
  GuiCanvasEditor,
  canvasBoundsForBlocks,
  canvasExtentForBlocks,
  canvasInitialPosition,
  canvasLogicalViewportWidth,
  canvasVisualDeltaToLogical,
  canvasZoomFromWheel,
  resolveCanvasPointerTarget
} from '../CreateEntryApp';
import { createCanvasHole } from './canvasForest';

let readingHoverCount = 0;
let readingClickCount = 0;

vi.mock('@sjtu-ai4math/snl-basics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sjtu-ai4math/snl-basics')>();
  const ReactModule = await import('react');
  const renderNode = (tree: SnlSyntaxTree, path: number[] = []): React.ReactElement => {
    if (tree.macro_name === 'matrix') {
      return ReactModule.createElement(
        'section',
        { key: path.join('.') || 'matrix-root', className: 'dynamic-shell' },
        tree.children.map((child: SnlSyntaxTree, index: number) => renderNode(child, [...path, index]))
      );
    }
    return ReactModule.createElement(
      'div',
      {
        key: path.join('.') || 'root',
        'data-tree-path': path.join('.'),
        'data-kind': tree.kind,
        className: tree.kind === 'argPlaceholder' ? 'snlArgPlaceholder' : undefined
      },
      tree.macro_name,
      tree.children.map((child: SnlSyntaxTree, index: number) => renderNode(child, [...path, index]))
    );
  };
  return {
    ...actual,
    SnlSyntaxTreeView: ({ tree }: { tree: SnlSyntaxTree }) => ReactModule.createElement(
      'div',
      {
        className: 'katex-html',
        onMouseMove: () => { readingHoverCount += 1; },
        onClick: () => { readingClickCount += 1; }
      },
      renderNode(tree)
    )
  };
});

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({
  macro_name,
  kind: '',
  mdata: null,
  children
});

const driver = new MacroDataDriver({
  queries: { query_macro: async () => null }
});

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => true }
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
  readingHoverCount = 0;
  readingClickCount = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'elementsFromPoint');
});

afterAll(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
});

describe('GuiCanvasEditor', () => {
  it('maps wheel direction to bounded Canvas zoom', () => {
    expect(canvasZoomFromWheel(1, -100)).toBeGreaterThan(1);
    expect(canvasZoomFromWheel(1, 100)).toBeLessThan(1);
    expect(canvasZoomFromWheel(2, -1000)).toBe(2);
    expect(canvasZoomFromWheel(0.5, 1000)).toBe(0.5);
    expect(canvasLogicalViewportWidth(800, 1.25)).toBe(800);
    expect(canvasLogicalViewportWidth(800, 0.5)).toBe(1600);
    expect(canvasVisualDeltaToLogical(80, 2)).toBe(40);
    expect(canvasVisualDeltaToLogical(80, 0.5)).toBe(160);
  });

  it('anchors zoom to the bordered viewport content box', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 },
      clientLeft: { configurable: true, value: 6 },
      clientTop: { configurable: true, value: 4 }
    });
    viewport.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 520,
      width: 800, height: 500, toJSON: () => undefined
    });
    viewport.scrollLeft = 100;
    viewport.scrollTop = 60;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    canvas.getBoundingClientRect = () => ({
      x: 10, y: 30, left: 10, top: 30, right: 810, bottom: 542,
      width: 800, height: 512, toJSON: () => undefined
    });
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    expect(canvas.style.zoom).toBe('1');

    const wheel = createEvent.wheel(viewport, {
      deltaY: -120,
      clientX: 160,
      clientY: 120,
      cancelable: true
    });
    fireEvent(viewport, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    const expectedZoom = canvasZoomFromWheel(1, -120);
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(expectedZoom));
    expect(canvas.style.width).toBe('800px');
    const pointerX = 160 - 10 - 6;
    const pointerY = 120 - 20 - 4;
    expect(viewport.scrollLeft).toBeCloseTo((100 + pointerX) * expectedZoom - pointerX);
    expect(viewport.scrollTop).toBeCloseTo((60 + pointerY) * expectedZoom - pointerY);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('keeps the Canvas frame fixed while only the inner world zooms', () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    expect(viewport.style.height).toBe('32rem');
    expect(viewport.style.border).toContain('1px solid');
    expect(canvas.style.border).toBe('');
  });

  it('preserves the pointer anchor across wheel events that arrive before commit', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 }
    });
    viewport.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 520,
      width: 800, height: 500, toJSON: () => undefined
    });
    viewport.scrollLeft = 100;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    canvas.getBoundingClientRect = () => ({
      x: 10, y: 30, left: 10, top: 30, right: 810, bottom: 542,
      width: 800, height: 512, toJSON: () => undefined
    });
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const first = createEvent.wheel(viewport, {
      deltaY: -120, clientX: 160, clientY: 120, cancelable: true
    });
    const second = createEvent.wheel(viewport, {
      deltaY: -120, clientX: 260, clientY: 120, cancelable: true
    });
    viewport.dispatchEvent(first);
    viewport.dispatchEvent(second);

    const firstZoom = canvasZoomFromWheel(1, -120);
    const firstScroll = (100 + 150) * firstZoom - 150;
    const finalZoom = canvasZoomFromWheel(firstZoom, -120);
    const finalScroll = ((firstScroll + 250) / firstZoom) * finalZoom - 250;
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(finalZoom));
    expect(viewport.scrollLeft).toBeCloseTo(finalScroll);
  });

  it('preserves pan from same-frame inverse zooms at different pointer centres', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas-viewport]')!;
    viewport.getBoundingClientRect = () => new DOMRect(10, 20, 800, 500);
    viewport.scrollLeft = 300;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    const firstPointer = 150;
    const secondPointer = 250;
    viewport.dispatchEvent(createEvent.wheel(viewport, {
      deltaY: -120, clientX: 10 + firstPointer, clientY: 120, cancelable: true
    }));
    viewport.dispatchEvent(createEvent.wheel(viewport, {
      deltaY: 120, clientX: 10 + secondPointer, clientY: 120, cancelable: true
    }));
    const middleZoom = canvasZoomFromWheel(1, -120);
    const middleScroll = (300 + firstPointer) * middleZoom - firstPointer;
    const finalZoom = canvasZoomFromWheel(middleZoom, 120);
    const finalScroll = ((middleScroll + secondPointer) / middleZoom) * finalZoom - secondPointer;
    expect(finalZoom).toBe(1);
    await waitFor(() => expect(viewport.scrollLeft).toBeCloseTo(finalScroll));
    expect(Number(canvas.style.zoom)).toBe(finalZoom);
    expect(viewport.scrollLeft).not.toBe(300);
  });

  it('preserves same-frame wheel order when a delta is clamped at a zoom bound', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));

    const clampedZoomIn = createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    });
    const followingZoomOut = createEvent.wheel(viewport, {
      deltaY: 1000, clientX: 50, clientY: 50, cancelable: true
    });
    viewport.dispatchEvent(clampedZoomIn);
    viewport.dispatchEvent(followingZoomOut);
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(0.5));
  });

  it('normalizes line and page wheel deltas but leaves editable descendants alone', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 500 });
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;

    const lineWheel = createEvent.wheel(viewport, {
      deltaY: -1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX: 50,
      clientY: 50,
      cancelable: true
    });
    fireEvent(viewport, lineWheel);
    const lineZoom = canvasZoomFromWheel(1, -16);
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(lineZoom));

    const pageWheel = createEvent.wheel(viewport, {
      deltaY: 0.1,
      deltaMode: WheelEvent.DOM_DELTA_PAGE,
      clientX: 50,
      clientY: 50,
      cancelable: true
    });
    fireEvent(viewport, pageWheel);
    const pageZoom = canvasZoomFromWheel(lineZoom, 50);
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(pageZoom));

    const input = document.createElement('input');
    viewport.append(input);
    const inputWheel = createEvent.wheel(input, {
      deltaY: -1000,
      clientX: 50,
      clientY: 50,
      cancelable: true
    });
    fireEvent(input, inputWheel);
    expect(inputWheel.defaultPrevented).toBe(false);
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(Number(canvas.style.zoom)).toBe(pageZoom);
  });

  it('cancels a queued wheel frame when the Canvas unmounts', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 42);
    const cancelAnimationFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -120, clientX: 50, clientY: 50, cancelable: true
    }));
    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });

  it('fills the viewport on zoom-out and keeps context-menu coordinates logical', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 800 });
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: 1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(0.5));
    expect(Number.parseFloat(canvas.style.width)).toBeGreaterThanOrEqual(1600);

    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    canvas.getBoundingClientRect = () => ({
      x: 100, y: 200, left: 100, top: 200, right: 1700, bottom: 1224,
      width: 1600, height: 1024, toJSON: () => undefined
    });
    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 400 });
    const menu = view.container.querySelector<HTMLElement>('[data-canvas-menu]')!;
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('100px');
  });

  it('centres the first root in the visible viewport using logical coordinates after zoom', async () => {
    const mutationObservers: Array<{
      callback: MutationCallback;
      observed: Set<Node>;
      disconnected: boolean;
      observer: MutationObserver;
    }> = [];
    class TrackingMutationObserver implements MutationObserver {
      private readonly record: (typeof mutationObservers)[number];
      constructor(callback: MutationCallback) {
        this.record = { callback, observed: new Set(), disconnected: false, observer: this };
        mutationObservers.push(this.record);
      }
      observe(target: Node): void { this.record.observed.add(target); }
      disconnect(): void { this.record.disconnected = true; }
      takeRecords(): MutationRecord[] { return []; }
    }
    vi.stubGlobal('MutationObserver', TrackingMutationObserver);
    const centringResizeObservers: Array<{
      observed: Set<Element>;
      disconnected: boolean;
    }> = [];
    class TrackingResizeObserver implements ResizeObserver {
      private readonly record = { observed: new Set<Element>(), disconnected: false };
      constructor(_callback: ResizeObserverCallback) {
        centringResizeObservers.push(this.record);
      }
      observe(target: Element): void { this.record.observed.add(target); }
      unobserve(target: Element): void { this.record.observed.delete(target); }
      disconnect(): void { this.record.disconnected = true; }
    }
    vi.stubGlobal('ResizeObserver', TrackingResizeObserver);
    const emptyProps = {
      forest: [] as SnlSyntaxTree[],
      macroDataDriver: driver,
      kindPalette: undefined,
      onForestChange: () => undefined,
      onResetFromSnl: () => undefined
    };
    const view = render(<GuiCanvasEditor {...emptyProps} />);
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 500 }
    });
    viewport.getBoundingClientRect = () => new DOMRect(10, 20, 802, 502);
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    canvas.getBoundingClientRect = () => new DOMRect(-190, -80, 1600, 1000);
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 300, clientY: 200, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    viewport.scrollLeft = 200;
    viewport.scrollTop = 100;

    const first = node('root');
    view.rerender(<GuiCanvasEditor {...emptyProps} forest={[first]} />);
    const block = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!
    );
    const notifyBlockMutation = (): void => {
      mutationObservers
        .filter(({ observed, disconnected }) => observed.has(block) && !disconnected)
        .forEach(({ callback, observer }) => callback([], observer));
    };
    let blockRect = new DOMRect(0, 0, 200, 100);
    block.getBoundingClientRect = () => blockRect;
    view.rerender(<GuiCanvasEditor {...emptyProps} forest={[first]} />);

    await waitFor(() => expect(block.style.left).toBe('250px'));
    expect(block.style.top).toBe('150px');

    // A click-like pointer gesture does not transfer position ownership. Even
    // if the parent rerenders, renderer-owned geometry must still settle.
    fireEvent.pointerDown(block, { pointerId: 201, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(block, { pointerId: 201, clientX: 10, clientY: 10 });
    view.rerender(<GuiCanvasEditor {...emptyProps} forest={[first]} />);

    // The production renderer resolves asynchronously; recenter until this
    // initial root's own DOM settles, without treating visual pixels as logical.
    blockRect = new DOMRect(0, 0, 100, 50);
    block.appendChild(document.createElement('span'));
    notifyBlockMutation();
    await waitFor(() => expect(block.style.left).toBe('275px'));
    expect(block.style.top).toBe('163px');

    // A candidate gesture freezes renderer-owned centring before it crosses
    // the drag threshold; otherwise a queued ResizeObserver can move the card
    // between pointer-down and the first active move.
    blockRect = new DOMRect(0, 0, 50, 25);
    fireEvent.pointerDown(block, { pointerId: 201, button: 0, clientX: 10, clientY: 10 });
    mutationObservers
      .filter(({ observed }) => observed.has(block))
      .forEach(({ callback }) => callback([], {} as MutationObserver));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(block.style.left).toBe('275px');
    expect(block.style.top).toBe('163px');
    fireEvent.pointerUp(block, { pointerId: 201, clientX: 10, clientY: 10 });

    // Crossing the drag threshold transfers ownership. Later renderer changes
    // must not yank the block back to a newly calculated centre, and the
    // now-useless initial-centering observers must be disconnected immediately.
    const centringObservers = mutationObservers.filter(({ observed }) => observed.has(block));
    const centringResize = centringResizeObservers.filter(({ observed }) =>
      observed.has(block) && !observed.has(viewport)
    );
    blockRect = new DOMRect(-190 + 275 * 2, -80 + 163 * 2, 100, 50);
    const dragClientX = blockRect.left + 10;
    const dragClientY = blockRect.top + 10;
    fireEvent.pointerDown(block, {
      pointerId: 202, button: 0, clientX: dragClientX, clientY: dragClientY
    });
    fireEvent.pointerMove(block, {
      pointerId: 202, clientX: dragClientX + 20, clientY: dragClientY + 20
    });
    fireEvent.pointerUp(block, {
      pointerId: 202, clientX: dragClientX + 20, clientY: dragClientY + 20
    });
    await waitFor(() => expect(block.style.left).toBe('285px'));
    expect(block.style.top).toBe('173px');
    expect(centringObservers.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(centringObservers.every(({ disconnected }) => disconnected)).toBe(true)
    );
    expect(centringResize.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(centringResize.every(({ disconnected }) => disconnected)).toBe(true)
    );

    blockRect = new DOMRect(0, 0, 50, 25);
    block.appendChild(document.createElement('span'));
    notifyBlockMutation();
    // A callback already queued before disconnect must also fail closed against
    // the transferred ownership ref.
    centringObservers.forEach(({ callback, observer }) => callback([], observer));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(block.style.left).toBe('285px');
    expect(block.style.top).toBe('173px');
  });

  it('keeps blank-space root insertion at its logical invocation point', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <>
          <output data-testid="anchored-root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            macroCandidates={[{ id: 'Add.add', labels: [] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    canvas.getBoundingClientRect = () => new DOMRect(100, 200, 1600, 1024);

    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 400 });
    const menu = await view.findByRole('menu', { name: 'Canvas block actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Add root Macro/ }));
    const search = await waitFor(() => view.getByRole('textbox', { name: 'Search macros in SNoogL' }));
    expect(document.activeElement).toBe(search);
    const inputHost = search.closest<HTMLElement>('[data-macro-id-control]')!;
    expect(inputHost.style.left).toBe('100px');
    expect(inputHost.style.top).toBe('100px');

    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });
    await waitFor(() => expect(view.getByTestId('anchored-root-count').textContent).toBe('1'));
    const block = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    expect(block.style.left).toBe('100px');
    expect(block.style.top).toBe('100px');
  });

  it('keeps wheel events inside the Canvas at the zoom bounds', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() =>
      expect(Number(view.getByLabelText('GUI Editor canvas').style.zoom)).toBe(2)
    );
    const atMaximum = createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    });
    fireEvent(viewport, atMaximum);
    expect(atMaximum.defaultPrevented).toBe(true);
  });

  it('converts pointer movement back to logical coordinates while zoomed', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    const block = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    const leftBefore = Number.parseFloat(block.style.left);
    const topBefore = Number.parseFloat(block.style.top);

    fireEvent.pointerDown(block, { pointerId: 101, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { pointerId: 101, clientX: 90, clientY: 50 });
    fireEvent.pointerUp(block, { pointerId: 101, clientX: 90, clientY: 50 });

    await waitFor(() => expect(Number.parseFloat(block.style.left)).toBe(leftBefore + 40));
    expect(Number.parseFloat(block.style.top)).toBe(topBefore + 20);
  });

  it('keeps a subtree from a wrapperless root under the pointer across zoom and card inset', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('matrix', [node('cell')])]);
      return (
        <>
          <output data-testid="coordinate-root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }

    const view = render(<Harness />);
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));

    const sourceBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    const rootContent = sourceBlock.firstElementChild as HTMLElement;
    const child = sourceBlock.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    canvas.getBoundingClientRect = () => new DOMRect(100, 200, 1600, 1024);
    sourceBlock.getBoundingClientRect = () => new DOMRect(300, 400, 300, 100);
    rootContent.getBoundingClientRect = () => new DOMRect(312, 412, 276, 76);
    child.getBoundingClientRect = () => new DOMRect(500, 450, 80, 40);

    fireEvent.pointerDown(child, {
      pointerId: 102,
      button: 0,
      clientX: 510,
      clientY: 460
    });
    fireEvent.pointerMove(child, {
      pointerId: 102,
      clientX: 590,
      clientY: 500
    });
    fireEvent.pointerUp(child, {
      pointerId: 102,
      clientX: 590,
      clientY: 500
    });

    await waitFor(() => expect(view.getByTestId('coordinate-root-count').textContent).toBe('2'));
    const detachedBlock = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]')[1];
    // The nested node started at logical (200, 125). A root card contributes a
    // logical (6, 6) inset, and the visual drag delta (80, 40) is logical (40, 20).
    expect(detachedBlock.style.left).toBe('234px');
    expect(detachedBlock.style.top).toBe('139px');
  });

  it('ignores an empty transitional content rect when detaching a nested subtree', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
      return (
        <>
          <output data-testid="invalid-inset-root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const viewport = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas-viewport]')!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    const sourceBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    const rootContent = sourceBlock.firstElementChild as HTMLElement;
    const child = sourceBlock.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    canvas.getBoundingClientRect = () => new DOMRect(100, 200, 1600, 1024);
    sourceBlock.getBoundingClientRect = () => new DOMRect(300, 400, 300, 100);
    rootContent.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    child.getBoundingClientRect = () => new DOMRect(500, 450, 80, 40);

    fireEvent.pointerDown(child, {
      pointerId: 103, button: 0, clientX: 510, clientY: 460
    });
    fireEvent.pointerMove(child, { pointerId: 103, clientX: 590, clientY: 500 });
    fireEvent.pointerUp(child, { pointerId: 103, clientX: 590, clientY: 500 });

    await waitFor(() => expect(view.getByTestId('invalid-inset-root-count').textContent).toBe('2'));
    const detachedBlock = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]')[1];
    expect(detachedBlock.style.left).toBe('240px');
    expect(detachedBlock.style.top).toBe('145px');
  });

  it('bounds detach coordinates when the semantic target rect is transiently empty', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
      return (
        <>
          <output data-testid="invalid-target-root-count">{forest.length}</output>
          <GuiCanvasEditor forest={forest} macroDataDriver={driver} kindPalette={undefined}
            onForestChange={setForest} onResetFromSnl={() => undefined} />
        </>
      );
    }
    const view = render(<Harness />);
    const viewport = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas-viewport]')!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    const sourceBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    const rootContent = sourceBlock.firstElementChild as HTMLElement;
    const child = sourceBlock.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    canvas.getBoundingClientRect = () => new DOMRect(100, 200, 1600, 1024);
    sourceBlock.getBoundingClientRect = () => new DOMRect(300, 400, 300, 100);
    rootContent.getBoundingClientRect = () => new DOMRect(312, 412, 276, 76);
    child.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

    fireEvent.pointerDown(child, {
      pointerId: 104, button: 0, clientX: 510, clientY: 460
    });
    fireEvent.pointerMove(child, { pointerId: 104, clientX: 590, clientY: 500 });
    fireEvent.pointerUp(child, { pointerId: 104, clientX: 590, clientY: 500 });

    await waitFor(() => expect(view.getByTestId('invalid-target-root-count').textContent).toBe('2'));
    const detachedBlock = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]')[1];
    // Fall back to the source card's committed world position plus visual delta,
    // never to the page origin from the empty semantic rect.
    expect(detachedBlock.style.left).toBe('140px');
    expect(detachedBlock.style.top).toBe('120px');
  });

  it('positions the focused Macro controls in logical coordinates while zoomed', async () => {
    vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    const resizeObservers: Array<{
      callback: ResizeObserverCallback;
      observed: Set<Element>;
    }> = [];
    class FocusResizeObserver implements ResizeObserver {
      private readonly record: { callback: ResizeObserverCallback; observed: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, observed: new Set() };
        resizeObservers.push(this.record);
      }
      observe(target: Element): void { this.record.observed.add(target); }
      unobserve(target: Element): void { this.record.observed.delete(target); }
      disconnect(): void { this.record.observed.clear(); }
    }
    vi.stubGlobal('ResizeObserver', FocusResizeObserver);
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>(
      '[data-entry-gui-canvas-viewport]'
    )!;
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    fireEvent(viewport, createEvent.wheel(viewport, {
      deltaY: -1000, clientX: 50, clientY: 50, cancelable: true
    }));
    await waitFor(() => expect(Number(canvas.style.zoom)).toBe(2));
    const target = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
    canvas.getBoundingClientRect = () => ({
      x: 10, y: 20, left: 10, top: 20, right: 810, bottom: 1044,
      width: 800, height: 1024, toJSON: () => undefined
    });
    let targetRect = new DOMRect(210, 120, 200, 40);
    target.getBoundingClientRect = () => targetRect;
    fireEvent.click(target, { clientX: 220, clientY: 130 });
    const control = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-canvas-macro-control]')!
    );
    expect(Number.parseFloat(control.style.left)).toBe(100);
    expect(Number.parseFloat(control.style.top)).toBe(74);

    // Renderer-owned DOM can reflow without changing forest/positions. The
    // control must follow that committed geometry too.
    targetRect = new DOMRect(250, 160, 200, 40);
    target.appendChild(document.createElement('span'));
    await waitFor(() => expect(Number.parseFloat(control.style.left)).toBe(120));
    expect(Number.parseFloat(control.style.top)).toBe(94);

    // A renderer can replace the semantic target. Mutation re-resolves it;
    // subsequent ResizeObserver notifications must follow the replacement,
    // not remain attached to the detached old element.
    const replacement = target.cloneNode(true) as HTMLElement;
    let replacementRect = new DOMRect(290, 200, 200, 40);
    replacement.getBoundingClientRect = () => replacementRect;
    target.replaceWith(replacement);
    await waitFor(() => expect(Number.parseFloat(control.style.left)).toBe(140));
    expect(Number.parseFloat(control.style.top)).toBe(114);
    const replacementObserver = resizeObservers.find(({ observed }) => observed.has(replacement));
    expect(replacementObserver).toBeDefined();
    expect(replacementObserver?.observed.has(target)).toBe(false);

    replacementRect = new DOMRect(330, 240, 200, 40);
    resizeObservers
      .filter(({ observed }) => observed.has(replacement))
      .forEach(({ callback }) => callback([], {} as ResizeObserver));
    await waitFor(() => expect(Number.parseFloat(control.style.left)).toBe(160));
    expect(Number.parseFloat(control.style.top)).toBe(134);
  });

  it('keeps the focused Macro controls attached while the selected block moves', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.getByLabelText('GUI Editor canvas') as HTMLElement;
    const block = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    const target = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
    canvas.getBoundingClientRect = () => new DOMRect(100, 200, 800, 512);
    target.getBoundingClientRect = () => new DOMRect(
      100 + Number.parseFloat(block.style.left),
      200 + Number.parseFloat(block.style.top),
      80,
      20
    );

    fireEvent.click(target, { clientX: 130, clientY: 230 });
    const control = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-canvas-macro-control]')!
    );
    const leftBefore = Number.parseFloat(control.style.left);
    const topBefore = Number.parseFloat(control.style.top);

    fireEvent.pointerDown(target, { pointerId: 72, button: 0, clientX: 130, clientY: 230 });
    fireEvent.pointerMove(target, { pointerId: 72, clientX: 170, clientY: 260 });
    fireEvent.pointerUp(target, { pointerId: 72, clientX: 170, clientY: 260 });

    await waitFor(() => expect(Number.parseFloat(block.style.left)).toBe(leftBefore + 40));
    expect(Number.parseFloat(control.style.left)).toBe(leftBefore + 40);
    expect(Number.parseFloat(control.style.top)).toBe(topBefore + 30);
  });

  it('localizes Canvas controls, Macro actions, styles, and context menus in Simplified Chinese', async () => {
    document.documentElement.lang = 'zh-CN';
    const localizedDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'list'
            ? ({
                name: 'list',
                description: '',
                source: { entries: [], urls: [] },
                tags: [],
                dynamic_arity: true,
                styles: [
                  { style_name: 'default',  template: { mode: 'formula_inline', body: '#*' }, tags: [] },
                  { style_name: 'compact',  template: { mode: 'formula_inline', body: '#*' }, tags: [] }
                ]
              } as never)
            : null
      }
    });
    const view = render(
      <GuiCanvasEditor
        forest={[node('list', [node('a')]), node('loose')]}
        macroDataDriver={localizedDriver}
        macroCandidates={[{ id: 'list', labels: [], styles: ['default', 'compact'] }]}
        macroOrigin={{ list: 'macros.json' }}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );

    const canvas = view.getByLabelText('GUI 编辑器画布');
    expect(view.getByRole('button', { name: '从 SNL 重置画布' })).toBeTruthy();
    canvas.focus();
    const restoreFocus = vi.spyOn(canvas, 'focus');
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    expect(await view.findByRole('textbox', { name: '插入画布根宏' })).toBeTruthy();
    fireEvent.keyDown(view.getByRole('textbox', { name: '插入画布根宏' }), { key: 'Escape' });
    await waitFor(() => expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true }));

    const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
    fireEvent.click(root);
    const argumentsControl = await view.findByLabelText('参数数量');
    const removeArgument = within(argumentsControl).getByLabelText('移除参数');
    expect(removeArgument.querySelector('svg[data-snl-icon="remove"]')).toBeTruthy();
    expect(within(argumentsControl).getByLabelText('参数数量值').textContent).toBe('1');
    const addArgument = within(argumentsControl).getByLabelText('添加参数');
    expect(addArgument.querySelector('svg[data-snl-icon="add"]')).toBeTruthy();
    expect(view.getByRole('combobox', { name: '宏样式' }).getAttribute('title'))
      .toBe('选择宏样式');
    expect(view.getByRole('button', { name: '编辑宏' })).toBeTruthy();

    fireEvent.contextMenu(root);
    const menu = await view.findByRole('menu', { name: '画布块操作' });
    expect(within(menu).getByRole('menuitem', { name: /编辑宏/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /添加参数/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /移除参数/ })).toBeTruthy();
    const deleteItem = within(menu).getByRole('menuitem', { name: /删除/ });
    expect(deleteItem.getAttribute('data-danger')).toBe('true');
    const enabledItems = within(menu).getAllByRole('menuitem').filter((item) =>
      !(item as HTMLButtonElement).disabled
    );
    await waitFor(() => expect(document.activeElement).toBe(enabledItems[0]));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(enabledItems.at(-1));
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('menu', { name: '画布块操作' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(canvas));
  });

  it('owns interactions so partial nodes cannot fall through to reading-surface ancestors', async () => {
    const partial = { ...node('partial-fragment', [node('child')]), kind: 'partial' };
    const view = render(
      <GuiCanvasEditor
        forest={[partial]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const partialElement = view.container.querySelector<HTMLElement>('[data-kind="partial"]')!;
    fireEvent.mouseMove(partialElement);
    fireEvent.click(partialElement, { ctrlKey: true });
    expect(readingHoverCount).toBe(0);
    expect(readingClickCount).toBe(0);
    await waitFor(() => expect(partialElement.classList.contains('snl-canvas-focused')).toBe(true));
  });

  it('tiles the union of the viewport and all four occupied block extrema, then reclaims it', () => {
    expect(canvasBoundsForBlocks(
      { width: 800, height: 512 },
      [
        { x: -300, y: -200, width: 100, height: 80 },
        { x: 900, y: 700, width: 200, height: 100 }
      ],
      24
    )).toEqual({ left: -340, top: -240, width: 1480, height: 1080 });

    expect(canvasBoundsForBlocks(
      { width: 800, height: 512 },
      [{ x: 24, y: 24, width: 200, height: 100 }],
      24
    )).toEqual({ left: 0, top: 0, width: 800, height: 512 });
  });

  it('expands left/up around dragged blocks and reclaims unused tiles without moving the viewport world', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas-viewport]')!;
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    const block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(viewport.style.overflowAnchor).toBe('none');
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 512 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
      scrollTop: { configurable: true, writable: true, value: 0 }
    });
    Object.defineProperties(block, {
      offsetLeft: { configurable: true, get: () => Number.parseFloat(block.style.left) },
      offsetTop: { configurable: true, get: () => Number.parseFloat(block.style.top) },
      offsetWidth: { configurable: true, value: 100 },
      offsetHeight: { configurable: true, value: 60 },
      scrollWidth: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 60 }
    });
    canvas.getBoundingClientRect = () => new DOMRect(
      100 - viewport.scrollLeft,
      80 - viewport.scrollTop,
      800,
      512
    );
    block.getBoundingClientRect = () => new DOMRect(
      100 + Number.parseFloat(block.style.left) - viewport.scrollLeft,
      80 + Number.parseFloat(block.style.top) - viewport.scrollTop,
      100,
      60
    );
    const target = block.querySelector<HTMLElement>('[data-tree-path=""]')!;
    target.getBoundingClientRect = () => {
      const blockRect = block.getBoundingClientRect();
      return new DOMRect(blockRect.left + 6, blockRect.top + 6, 80, 20);
    };
    fireEvent.click(target, { clientX: 130, clientY: 110 });
    const control = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-canvas-macro-control]')!
    );
    const assertControlAttached = (): void => {
      const currentControl = view.container.querySelector<HTMLElement>('[data-canvas-macro-control]')!;
      expect(currentControl).not.toBeNull();
      expect(Number.parseFloat(currentControl.style.left) - Number.parseFloat(block.style.left)).toBe(6);
      expect(Number.parseFloat(currentControl.style.top) - Number.parseFloat(block.style.top)).toBe(30);
    };
    expect(control).not.toBeNull();
    assertControlAttached();

    // Move the world-space card to x=-176, y=-126. The local tile origin
    // shifts to (-200,-150), so the card remains at 24px padding.
    let rect = block.getBoundingClientRect();
    fireEvent.pointerDown(block, {
      pointerId: 74, button: 0, clientX: rect.left + 10, clientY: rect.top + 10
    });
    fireEvent.pointerMove(block, {
      pointerId: 74, clientX: rect.left - 190, clientY: rect.top - 140
    });
    fireEvent.pointerUp(block, {
      pointerId: 74, clientX: rect.left - 190, clientY: rect.top - 140
    });
    await waitFor(() => expect(canvas.style.width).toBe('1000px'));
    expect(canvas.style.height).toBe('672px');
    expect(canvas.style.backgroundPosition).toBe('0px 0px');
    expect(block.style.left).toBe('24px');
    expect(block.style.top).toBe('34px');
    expect(viewport.scrollLeft).toBe(200);
    expect(viewport.scrollTop).toBe(160);
    await waitFor(assertControlAttached);

    // View the left/top extension and move the card back into the baseline
    // viewport. The no-longer-occupied tiles are reclaimed.
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    rect = block.getBoundingClientRect();
    fireEvent.pointerDown(block, {
      pointerId: 75, button: 0, clientX: rect.left + 10, clientY: rect.top + 10
    });
    fireEvent.pointerMove(block, {
      pointerId: 75, clientX: rect.left + 310, clientY: rect.top + 260
    });
    // Never reclaim the origin underneath an active pointer gesture: at the
    // left/top scroll edge there is no negative scroll range available to
    // compensate that origin shift, so shrinking here would break the grab.
    await waitFor(() => expect(canvas.style.width).toBe('1000px'));
    expect(canvas.style.height).toBe('672px');
    expect(block.style.left).toBe('324px');
    expect(block.style.top).toBe('284px');
    fireEvent.pointerUp(block, {
      pointerId: 75, clientX: rect.left + 310, clientY: rect.top + 260
    });
    // Releasing while the user is still looking at the left/top extension
    // keeps that visible world rectangle backed. Reclaim follows as the user
    // scrolls back to the baseline world.
    await waitFor(() => expect(canvas.style.width).toBe('1000px'));
    expect(canvas.style.height).toBe('672px');
    expect(block.style.left).toBe('324px');
    expect(block.style.top).toBe('284px');

    const menuPoint = block.getBoundingClientRect();
    fireEvent.contextMenu(canvas, {
      clientX: menuPoint.left + 10,
      clientY: menuPoint.top + 12
    });
    const menu = await view.findByRole('menu', { name: 'Canvas block actions' });
    const assertMenuAttached = (): void => {
      expect(Number.parseFloat(menu.style.left) - Number.parseFloat(block.style.left)).toBe(10);
      expect(Number.parseFloat(menu.style.top) - Number.parseFloat(block.style.top)).toBe(12);
    };
    assertMenuAttached();

    viewport.scrollLeft = 200;
    viewport.scrollTop = 160;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(block.style.left).toBe('124px'));
    expect(canvas.style.width).toBe('800px');
    expect(canvas.style.backgroundPosition).toBe('0px 0px');
    expect(block.style.left).toBe('124px');
    expect(block.style.top).toBe('124px');
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    assertMenuAttached();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Add root Macro/ }));
    const addRootSearch = await view.findByRole('textbox', { name: 'Search macros in SNoogL' });
    const addRootHost = addRootSearch.closest<HTMLElement>('[data-macro-id-control]')!;
    expect(Number.parseFloat(addRootHost.style.left) - Number.parseFloat(block.style.left)).toBe(10);
    expect(Number.parseFloat(addRootHost.style.top) - Number.parseFloat(block.style.top)).toBe(12);
    fireEvent.keyDown(addRootSearch, { key: 'Escape' });

    // Repeat the extent cycle with a node editor open during reclamation.
    rect = block.getBoundingClientRect();
    fireEvent.pointerDown(block, {
      pointerId: 76, button: 0, clientX: rect.left + 10, clientY: rect.top + 10
    });
    fireEvent.pointerMove(block, {
      pointerId: 76, clientX: rect.left - 290, clientY: rect.top - 240
    });
    fireEvent.pointerUp(block, {
      pointerId: 76, clientX: rect.left - 290, clientY: rect.top - 240
    });
    await waitFor(() => expect(block.style.left).toBe('24px'));
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    rect = block.getBoundingClientRect();
    fireEvent.pointerDown(block, {
      pointerId: 77, button: 0, clientX: rect.left + 10, clientY: rect.top + 10
    });
    fireEvent.pointerMove(block, {
      pointerId: 77, clientX: rect.left + 310, clientY: rect.top + 260
    });
    fireEvent.pointerUp(block, {
      pointerId: 77, clientX: rect.left + 310, clientY: rect.top + 260
    });
    await waitFor(() => expect(block.style.left).toBe('324px'));
    fireEvent.doubleClick(target);
    const editor = await view.findByRole('textbox', { name: 'Edit focused SNL' });
    const editorHost = editor.closest<HTMLElement>('[data-macro-id-control]')!;
    const assertEditorAttached = (): void => {
      expect(Number.parseFloat(editorHost.style.left) - Number.parseFloat(block.style.left)).toBe(6);
      expect(Number.parseFloat(editorHost.style.top) - Number.parseFloat(block.style.top)).toBe(6);
    };
    assertEditorAttached();
    viewport.scrollLeft = 200;
    viewport.scrollTop = 160;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(block.style.left).toBe('124px'));
    assertEditorAttached();
    fireEvent.keyDown(editor, { key: 'Escape' });
  });

  it('expands the canvas bounds for blocks wider and taller than the viewport', () => {
    expect(canvasExtentForBlocks(
      { width: 800, height: 512 },
      [{ x: 120, y: 80, width: 1600, height: 1200 }],
      24
     )).toEqual({ width: 1760, height: 1320 });
    expect(canvasExtentForBlocks(
      { width: 800, height: 512 },
      [{ x: 24, y: 24, width: 200, height: 100 }],
      24
    )).toEqual({ width: 800, height: 512 });
  });

  it('reflows the live canvas when ResizeObserver sees a huge rendered block', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe(): void { /* test triggers the callback after geometry is installed */ }
      unobserve(): void { /* no-op */ }
      disconnect(): void { /* no-op */ }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const view = render(
      <GuiCanvasEditor
        forest={[node('huge')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const viewport = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas-viewport]')!;
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    const block = view.container.querySelector<HTMLElement>('[data-canvas-root]')!;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperties(block, {
      offsetLeft: { configurable: true, value: 120 },
      offsetTop: { configurable: true, value: 80 },
      offsetWidth: { configurable: true, value: 1600 },
      scrollWidth: { configurable: true, value: 1600 },
      offsetHeight: { configurable: true, value: 1200 },
      scrollHeight: { configurable: true, value: 1200 }
    });

    callbacks.forEach((callback) => callback([], {} as ResizeObserver));
    await waitFor(() => expect(canvas.style.width).toBe('1760px'));
    expect(canvas.style.height).toBe('1320px');
  });

  it('adds fixed-arity placeholders when a Macro is inserted as a new root', async () => {
    const pairDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'pair'
            ? ({
                name: 'pair',
                description: '',
                source: { entries: [], urls: [] },
                tags: [],
                dynamic_arity: false,
                styles: [{ style_name: 'default',  template: { mode: 'formula_inline', body: '#0 + #1' }, tags: [] }]
              } as never)
            : null
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={pairDriver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const canvas = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
    );
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'pair' } });

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(2)
    );
  });

  it('adds one placeholder when a dynamic-arity constant Macro is inserted as a new root', async () => {
    const dynamicDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'list'
            ? ({
                name: 'list', description: '', source: { entries: [], urls: [] }, tags: [],
                dynamic_arity: true,
                styles: [{ style_name: 'default',  template: { mode: 'formula_inline', body: '#*' }, tags: [] }]
              } as never)
            : null
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={dynamicDriver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'list' } });

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1)
    );
  });

  it('adds one placeholder when a temporary Macro is inserted as a new root', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: '$x$' } });

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1)
    );
  });

  it('keeps canonical paths for descendants rendered below a temporary Macro', async () => {
    const temporary: SnlSyntaxTree = {
      ...node('x', [node('filled', [node('grandchild')])]),
      env_mode: 'formula_inline'
    };
    const view = render(
      <GuiCanvasEditor
        forest={[temporary]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    const grandchild = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!
    );
    expect(grandchild).toBeTruthy();

    fireEvent.click(grandchild);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement
    );
    expect(input.value).toBe('grandchild');
  });

  it('does not insert a root after Escape cancels a slow arity lookup', async () => {
    const slowDriver = new MacroDataDriver({
      queries: {
        query_macro: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return {
            name: 'pair',
            description: '',
            source: { entries: [], urls: [] },
            tags: [],
            dynamic_arity: false,
            styles: [{ style_name: 'default',  template: { mode: 'formula_inline', body: '#0 + #1' }, tags: [] }]
          } as never;
        }
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={slowDriver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }

    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'pair' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(view.getByTestId('root-count').textContent).toBe('0');
  });

  it('does not publish a delayed root after the Canvas unmounts', async () => {
    let resolveMacro!: (value: unknown) => void;
    const delayed = new Promise((resolve) => { resolveMacro = resolve; });
    const delayedDriver = new MacroDataDriver({
      queries: { query_macro: async () => await delayed as never }
    });
    const onForestChange = vi.fn();
    const view = render(
      <GuiCanvasEditor
        forest={[]}
        macroDataDriver={delayedDriver}
        kindPalette={undefined}
        onForestChange={onForestChange}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'pair' } });
    view.unmount();
    resolveMacro({
      name: 'pair',
      description: '',
      source: { entries: [], urls: [] },
      tags: [],
      dynamic_arity: false,
      styles: [{ style_name: 'default',  template: { mode: 'formula_inline', body: '#0 + #1' }, tags: [] }]
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onForestChange).not.toHaveBeenCalled();
  });

  it('infers a missing dynamic-macro wrapper from descendant geometry', () => {
    const tree = node('root', [node('matrix', [node('cell')])]);
    const block = document.createElement('div');
    block.dataset.treePath = '';
    const shell = document.createElement('span');
    const cell = document.createElement('span');
    cell.dataset.treePath = '0.0';
    cell.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    shell.appendChild(cell);
    block.appendChild(shell);

    const shellTarget = resolveCanvasPointerTarget(shell, block, tree, 92, 110);
    expect(shellTarget?.path).toEqual([0]);

    const cellTarget = resolveCanvasPointerTarget(cell, block, tree, 110, 110);
    expect(cellTarget?.path).toEqual([0, 0]);
  });

  it('shows Tab selection feedback for a dynamic macro without its own wrapper', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('matrix', [node('cell')])])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Tab' });
    fireEvent.keyDown(canvas, { key: 'Enter' });
    const shell = view.container.querySelector<HTMLElement>('.dynamic-shell')!;
    await waitFor(() => expect(shell.classList.contains('snl-canvas-focused')).toBe(true));
    expect(view.container.querySelector('[data-canvas-structural-fallback="0"]')).toBeNull();
  });

  it('moves the whole block from blank card space with grab cursor', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const block = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-canvas-root]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(block.style.cursor).toBe('grab');
    expect(block.style.userSelect).toBe('none');
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 512);
    block.getBoundingClientRect = () => new DOMRect(
      Number.parseFloat(block.style.left),
      Number.parseFloat(block.style.top),
      100,
      40
    );

    expect(fireEvent.pointerDown(block, {
      pointerId: 2,
      button: 0,
      clientX: 10,
      clientY: 10
    })).toBe(false);
    fireEvent.pointerMove(block, { pointerId: 2, clientX: 30, clientY: 40 });
    await waitFor(() => expect(block.style.cursor).toBe('grabbing'));
    expect(block.style.zIndex).toBe('1000');
    expect(block.style.left).toBe('44px');
    expect(block.style.top).toBe('54px');

    fireEvent.pointerUp(block, { pointerId: 2, clientX: 30, clientY: 40 });
    await waitFor(() => expect(block.style.cursor).toBe('grab'));
    expect(view.container.querySelectorAll('[data-canvas-root]')).toHaveLength(1);
  });

  it('starts whole-block dragging from committed DOM geometry instead of stale position state', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    const block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    canvas.getBoundingClientRect = () => new DOMRect(100, 80, 800, 512);
    block.getBoundingClientRect = () => new DOMRect(500, 380, 120, 60);

    fireEvent.pointerDown(block, {
      pointerId: 73,
      button: 0,
      clientX: 520,
      clientY: 400
    });
    fireEvent.pointerMove(block, { pointerId: 73, clientX: 530, clientY: 410 });

    await waitFor(() => expect(block.style.left).toBe('410px'));
    expect(block.style.top).toBe('310px');
  });

  it('uses adaptive compact blocks and lightens them on hover', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(block.style.width).toBe('max-content');
    expect(block.style.minWidth).toBe('');
    expect(block.style.maxWidth).toBe('none');
    expect(block.style.padding).toBe('0.3rem');
    const viewport = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas-viewport]')!;
    expect(viewport.style.overflowX).toBe('auto');
    expect(viewport.style.width).toBe('100%');
    expect(viewport.style.minWidth).toBe('0px');
    expect(viewport.style.contain).toBe('inline-size');
    const resting = block.style.background;
    fireEvent.pointerEnter(block);
    await waitFor(() => expect(block.style.background).not.toBe(resting));
  });

  it('absorbs a dragged root into a numbered placeholder', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [createCanvasHole(0)]),
        node('detached')
      ]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const blocks = await waitFor(() => {
      const found = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
      expect(found).toHaveLength(2);
      return found;
    });
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    hole.getBoundingClientRect = () => new DOMRect(500, 300, 30, 20);
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 500);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number) => x >= 300 ? [hole] : []
    });

    fireEvent.pointerDown(blocks[1], { pointerId: 3, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-drop-target')).toBe(true));
    expect(blocks[1].style.left).toBe('500px');
    expect(blocks[1].style.top).toBe('300px');

    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 100, clientY: 100 });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-drop-target')).toBe(false));
    expect(blocks[1].style.left).toBe('154px');
    expect(blocks[1].style.top).toBe('-76px');

    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });
    await waitFor(() => expect(blocks[1].style.left).toBe('500px'));
    fireEvent.pointerUp(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('detached');
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  it('does not absorb from a stale hover target or pointercancel', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [createCanvasHole(0)]),
        node('detached')
      ]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    let blocks = await waitFor(() => view.container.querySelectorAll<HTMLElement>('[data-canvas-root]'));
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number) => x >= 300 ? [hole] : []
    });

    fireEvent.pointerDown(blocks[1], { pointerId: 4, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 4, clientX: 320, clientY: 220 });
    fireEvent.pointerUp(blocks[1], { pointerId: 4, clientX: 100, clientY: 100 });
    expect(view.getByTestId('root-count').textContent).toBe('2');

    blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
    fireEvent.pointerDown(blocks[1], { pointerId: 5, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 5, clientX: 320, clientY: 220 });
    fireEvent.pointerCancel(blocks[1], { pointerId: 5, clientX: 320, clientY: 220 });
    expect(view.getByTestId('root-count').textContent).toBe('2');
  });

  it('navigates Focus with Enter, Shift+Enter, Tab and Escape', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch', [node('leaf')]), node('sibling')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    const branch = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    const leaf = view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!;
    fireEvent.click(branch);
    await waitFor(() => expect(branch.classList.contains('snl-canvas-focused')).toBe(true));

    fireEvent.keyDown(canvas, { key: 'Enter' });
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.keyDown(canvas, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(branch.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.keyDown(canvas, { key: 'Escape' });
    await waitFor(() => expect(view.container.querySelector('.snl-canvas-focused')).toBeNull());

    fireEvent.click(branch);
    fireEvent.click(canvas);
    await waitFor(() => expect(view.container.querySelector('.snl-canvas-focused')).toBeNull());
  });

  it('clears Focus when an external forest replacement removes its path', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [node('branch', [node('leaf')])])
      ]);
      return (
        <>
          <button onClick={() => setForest([node('replacement')])}>replace forest</button>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const leaf = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!);
    fireEvent.click(leaf);
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.click(view.getByRole('button', { name: 'replace forest' }));
    await waitFor(() => expect(view.container.querySelector('.snl-canvas-focused')).toBeNull());
  });

  it('edits any focused subtree, cancels on outside click, and commits only on Enter', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [node('branch', [node('leaf')])])
      ]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    const branch = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    fireEvent.click(branch);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((input as HTMLTextAreaElement).value).toBe('branch(leaf)');
    fireEvent.click(input);
    expect(branch.classList.contains('snl-canvas-focused')).toBe(true);

    fireEvent.change(input, { target: { value: '(' } });
    fireEvent.pointerDown(canvas);
    fireEvent.click(canvas);
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(branch.textContent).toContain('branch');

    fireEvent.click(branch);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const outsideCancelled = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(outsideCancelled, { target: { value: 'outside(child)' } });
    fireEvent.pointerDown(canvas);
    fireEvent.click(canvas);
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('branch');

    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const enterCommitted = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(enterCommitted, { target: { value: 'new(child)' } });
    fireEvent.keyDown(enterCommitted, { key: 'Enter' });

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    const newTarget = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    expect(newTarget.textContent).toContain('new');
    expect(newTarget.classList.contains('snl-canvas-focused')).toBe(true);

    const replaced = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    fireEvent.click(replaced);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const cancelled = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(cancelled, { target: { value: 'discarded' } });
    fireEvent.keyDown(cancelled, { key: 'Escape' });
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('new');
  });

  it('selects the exact nested subtree on primary pointer-down before click dispatch', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch', [node('leaf')])])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const branch = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    const leaf = view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!;
    root.getBoundingClientRect = () => new DOMRect(100, 100, 240, 60);
    branch.getBoundingClientRect = () => new DOMRect(150, 110, 140, 40);
    leaf.getBoundingClientRect = () => new DOMRect(200, 120, 50, 20);

    fireEvent.pointerDown(leaf, {
      pointerId: 76,
      button: 0,
      clientX: 220,
      clientY: 130
    });

    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    expect(branch.classList.contains('snl-canvas-focused')).toBe(false);
    expect(root.classList.contains('snl-canvas-focused')).toBe(false);

    // Native pointer capture may retarget pointerup/click to the root card.
    // The exact pointerdown subtree remains authoritative for this gesture.
    const block = leaf.closest<HTMLElement>('[data-canvas-root-index]')!;
    leaf.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    branch.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    fireEvent.pointerUp(block, { pointerId: 76, clientX: 220, clientY: 130 });
    fireEvent.click(block, { clientX: 220, clientY: 130 });
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    expect(root.classList.contains('snl-canvas-focused')).toBe(false);
  });

  it('selects the clicked node while dismissing an open node editor', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch'), node('leaf')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
    );
    const branch = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    const leaf = view.container.querySelector<HTMLElement>('[data-tree-path="1"]')!;
    fireEvent.click(branch);
    fireEvent.keyDown(canvas, { key: 'F2' });
    await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));

    fireEvent.pointerDown(leaf, { pointerId: 71, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(leaf, { pointerId: 71, clientX: 10, clientY: 10 });
    fireEvent.click(leaf, { clientX: 10, clientY: 10 });

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(leaf.classList.contains('snl-canvas-focused')).toBe(true);
    expect(branch.classList.contains('snl-canvas-focused')).toBe(false);
  });

  it('preserves an explicitly typed binder when committing a focused Macro edit', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('plain')]);
      return (
        <>
          <output data-testid="surface">{forest[0]?.binder_explicit ? `@${forest[0].macro_name}` : forest[0]?.macro_name}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement
    );
    fireEvent.change(editor, { target: { value: '@binder' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(view.getByTestId('surface').textContent).toBe('@binder'));
  });

  it('lets Ctrl+F2 subtree editing keep and display newline input', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const editor = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement
    );

    // Shift+Enter belongs to the multiline textarea; it must not submit.
    expect(fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.change(editor, { target: { value: 'root(\n  branch\n)' } });
    expect(view.getByRole('textbox', { name: 'Edit focused SNL' })).toBe(editor);
    expect(editor.value).toBe('root(\n  branch\n)');

    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
  });

  it('commits the focused Macro editor directly when embedded SNoogL picks a result', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          macroCandidates={[{ id: 'FOL.forall', labels: [] }, { id: 'Add.add', labels: [] }]}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(root);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true });
    fireEvent.click(view.getByRole('option', { name: 'FOL.forall' }));
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path=""]')?.textContent)
        .toBe('FOL.forall')
    );
    expect(root.classList.contains('snl-canvas-focused')).toBe(true);
  });

  it('opens Macro search with Ctrl+F when no node is focused and Tab inserts a root', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          macroCandidates={[{ id: 'FOL.forall', labels: [] }, { id: 'Add.add', labels: [] }]}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const canvas = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
    );
    fireEvent.click(canvas);
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });

    const search = await waitFor(() =>
      view.getByRole('textbox', { name: 'Search macros in SNoogL' })
    );
    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });

    await waitFor(() => {
      const roots = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
      expect(roots).toHaveLength(2);
      expect(roots[1].textContent).toContain('Add.add');
      expect(
        roots[1].querySelector<HTMLElement>('[data-tree-path=""]')
          ?.classList.contains('snl-canvas-focused')
      ).toBe(true);
    });
  });

  it('keeps a root block in place after editing its SNL', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    let block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    fireEvent.pointerDown(block, { pointerId: 12, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { pointerId: 12, clientX: 50, clientY: 40 });
    fireEvent.pointerUp(block, { pointerId: 12, clientX: 50, clientY: 40 });
    expect(block.style.left).toBe('64px');
    expect(block.style.top).toBe('54px');
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const root = block.querySelector<HTMLElement>('[data-tree-path=""]')!;
    fireEvent.click(root);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'changed(grandchild)' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

    block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(block.textContent).toContain('changed');
    expect(block.style.left).toBe('64px');
    expect(block.style.top).toBe('54px');
  });

  it('selects targets with Tab and edits a selected placeholder with F2/Ctrl+Enter', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [createCanvasHole(0), node('tail')])
      ]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;
    fireEvent.click(hole);
    const clickedInput = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    const editingBlock = view.container.querySelector<HTMLElement>('[data-canvas-root]')!;
    const leftBeforeEditDrag = editingBlock.style.left;
    fireEvent.pointerDown(editingBlock, { pointerId: 6, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(editingBlock, { pointerId: 6, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(editingBlock, { pointerId: 6, clientX: 40, clientY: 40 });
    expect(editingBlock.style.left).toBe(leftBeforeEditDrag);
    fireEvent.keyDown(clickedInput, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());

    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Tab' });
    const tail = view.container.querySelector<HTMLElement>('[data-tree-path="1"]')!;
    await waitFor(() => expect(tail.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.keyDown(canvas, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-focused')).toBe(true));

    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(input, { target: { value: 'foo(bar)' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('foo');
  });

  it('detaches a dragged nested macro into a second root block', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }

    const view = render(<Harness />);
    const child = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-tree-path="0"]');
      expect(found).not.toBeNull();
      return found!;
    });
    child.getBoundingClientRect = () => new DOMRect(120, 80, 30, 20);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.getBoundingClientRect = () => new DOMRect(10, 10, 800, 500);
    fireEvent.click(child);
    await waitFor(() => expect(child.classList.contains('snl-canvas-focused')).toBe(true));

    fireEvent.pointerDown(child, {
      pointerId: 1,
      button: 0,
      clientX: 20,
      clientY: 20
    });
    fireEvent.pointerMove(child, {
      pointerId: 1,
      clientX: 40,
      clientY: 40
    });
    fireEvent.pointerUp(child, { pointerId: 1, clientX: 40, clientY: 40 });

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    const blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].style.left).toBe('130px');
    expect(blocks[1].style.top).toBe('90px');
    const detachedRoot = blocks[1].querySelector<HTMLElement>('[data-tree-path=""]')!;
    await waitFor(() => expect(detachedRoot.classList.contains('snl-canvas-focused')).toBe(true));
  });

  it('centres the first root block and keeps later blocks on the fallback grid', () => {
    expect(canvasInitialPosition(0, { clientWidth: 800, clientHeight: 500 }, { offsetWidth: 200, offsetHeight: 100 }))
      .toEqual({ x: 300, y: 200 });
    expect(canvasInitialPosition(0, null, null)).toEqual({ x: 24, y: 24 });
    expect(canvasInitialPosition(1, { clientWidth: 800, clientHeight: 500 }, null))
      .toEqual({ x: 354, y: 24 });
  });

  it('edits only the focused Macro with F2 and keeps its children', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch', [node('leaf')])])]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    // Macro scope shows only the head, never the serialized subtree.
    expect((input as HTMLTextAreaElement).value).toBe('branch');

    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent)
        .toContain('renamed')
    );
    // The child survives the Macro-only rewrite.
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')?.textContent)
      .toContain('leaf');
  });

  it('rejects a subtree expression typed into the Macro-scope editor', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(input, { target: { value: 'foo(bar)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(view.getByRole('textbox', { name: 'Edit focused SNL' }).getAttribute('title'))
        .toContain('Ctrl+F2')
    );
  });

  it('double click edits the clicked node exactly like click + F2', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch', [node('leaf')])])]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const leaf = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!);
    fireEvent.doubleClick(leaf);
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((input as HTMLTextAreaElement).value).toBe('leaf');
    expect(leaf.classList.contains('snl-canvas-focused')).toBe(true);
  });

  it('focuses the subtree a drag would carry away, not the whole root', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch', [node('leaf')])])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const leaf = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!);
    const block = view.container.querySelector<HTMLElement>('[data-canvas-root]')!;
    // Pointer-down resolves the drag payload; the click must agree with it.
    fireEvent.pointerDown(leaf, { pointerId: 30, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(leaf, { pointerId: 30, clientX: 10, clientY: 10 });
    fireEvent.click(leaf);
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    expect(block.querySelector<HTMLElement>('[data-tree-path=""]')?.classList
      .contains('snl-canvas-focused')).toBe(false);
  });

  it('opens a Canvas-owned menu on right click and can detach from it', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const branch = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.contextMenu(branch);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    expect(menu).toBeTruthy();
    expect(branch.classList.contains('snl-canvas-focused')).toBe(true);

    fireEvent.click(view.getByRole('menuitem', { name: /Detach into its own block/ }));
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    expect(view.queryByRole('menu', { name: 'Canvas block actions' })).toBeNull();
  });

  it('lets Tab and Shift+Tab leave a Canvas context menu in document order', async () => {
    const view = render(
      <>
        <button type="button">Before canvas</button>
        <GuiCanvasEditor
          forest={[node('root', [node('branch')])]}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={() => undefined}
          onResetFromSnl={() => undefined}
        />
        <button type="button">After canvas</button>
      </>
    );
    const branch = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.contextMenu(branch);
    let menu = await view.findByRole('menu', { name: 'Canvas block actions' });
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(view.queryByRole('menu', { name: 'Canvas block actions' })).toBeNull();
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'After canvas' }));

    fireEvent.contextMenu(branch);
    menu = await view.findByRole('menu', { name: 'Canvas block actions' });
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    const focusCanvas = vi.spyOn(canvas, 'focus');
    fireEvent.keyDown(menu, { key: 'Tab', shiftKey: true });
    expect(view.queryByRole('menu', { name: 'Canvas block actions' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(canvas));
    expect(focusCanvas).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('Ctrl+F2 SNoogL Tab inserts the Macro id instead of replacing the expression', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        macroCandidates={[{ id: 'FOL.forall', labels: [] }, { id: 'Add.add', labels: [] }]}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((editor as HTMLTextAreaElement).value).toBe('root(branch)');

    (editor as HTMLTextAreaElement).setSelectionRange(5, 5);
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });

    await waitFor(() =>
      expect((view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement).value)
        .toBe('root(Add.addbranch)')
    );
  });

  it('does not let a previous click hijack a later gesture on another node', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [node('alpha'), node('beta'), createCanvasHole(2)])
      ]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const alpha = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    const beta = view.container.querySelector<HTMLElement>('[data-tree-path="1"]')!;
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;

    // Left click alpha first — this is what used to poison every later gesture.
    fireEvent.pointerDown(alpha, { pointerId: 40, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(alpha, { pointerId: 40, clientX: 5, clientY: 5 });
    fireEvent.click(alpha);
    await waitFor(() => expect(alpha.classList.contains('snl-canvas-focused')).toBe(true));

    // Right click on a sibling must target the sibling, not alpha.
    fireEvent.contextMenu(beta);
    await waitFor(() => expect(beta.classList.contains('snl-canvas-focused')).toBe(true));
    expect(alpha.classList.contains('snl-canvas-focused')).toBe(false);
    fireEvent.keyDown(view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!, { key: 'Escape' });

    // Double click on a sibling must edit the sibling, not alpha.
    fireEvent.click(alpha);
    fireEvent.doubleClick(beta);
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((editor as HTMLTextAreaElement).value).toBe('beta');
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());

    // Clicking an empty slot after clicking a macro must still open its editor.
    fireEvent.click(alpha);
    fireEvent.pointerDown(hole, { pointerId: 41, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(hole, { pointerId: 41, clientX: 5, clientY: 5 });
    fireEvent.click(hole);
    const slotEditor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((slotEditor as HTMLTextAreaElement).value).toBe('');
  });

  it('selects the whole value when F2 opens the Macro editor', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement
    );
    // F2 alone now behaves like the old F2 + Ctrl+A.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.value).toBe('branch');
  });

  it('deletes the focused node with Delete and restores it with Ctrl+Z', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('a'), node('b')])]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'Delete' });
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.dataset.kind)
        .toBe('argPlaceholder')
    );

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('a')
    );
  });

  it('undoes a root insertion made from the blank-space menu', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            macroCandidates={[{ id: 'Add.add', labels: [] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);

    // Right click on blank canvas space offers exactly one action: add a root.
    fireEvent.contextMenu(canvas);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual([expect.stringContaining('Add root Macro')]);

    // The menu must actually be clickable — this used to be swallowed.
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Add root Macro/ }));
    const search = await waitFor(() => view.getByRole('textbox', { name: 'Search macros in SNoogL' }));
    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
  });

  it('focuses the deepest node under the pointer even when it has its own wrapper', () => {
    const tree = node('root', [node('branch', [node('leaf')])]);
    const block = document.createElement('div');
    block.dataset.treePath = '';
    block.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    const branch = document.createElement('span');
    branch.dataset.treePath = '0';
    branch.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    const leaf = document.createElement('span');
    leaf.dataset.treePath = '0.0';
    leaf.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    // Sibling in the DOM, overlapping in geometry: `closest()` alone would
    // resolve to the shallow branch and focus the wrong subtree.
    block.appendChild(branch);
    block.appendChild(leaf);

    expect(resolveCanvasPointerTarget(branch, block, tree, 110, 110)?.path).toEqual([0, 0]);
    expect(resolveCanvasPointerTarget(branch, block, tree, 350, 20)?.path).toEqual([0]);
  });

  it('pops surplus children out as roots when a Macro loses arity, and does not resurrect them', async () => {
    // A driver with a real arity signal: binary#2 takes two args, unary#1 one.
    const arityDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) => {
          if (macro_name === 'binary') {
            return { macro_name, dynamic_arity: false, styles: [{ template: { mode: 'formula_inline', body: '#0 + #1' } }] } as never;
          }
          if (macro_name === 'unary') {
            return { macro_name, dynamic_arity: false, styles: [{ template: { mode: 'formula_inline', body: '-#0' } }] } as never;
          }
          return null;
        }
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('binary', [node('x'), node('y')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={arityDriver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);

    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const shrink = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(shrink, { target: { value: 'unary' } });
    fireEvent.keyDown(shrink, { key: 'Enter' });

    // 'y' must survive as its own root block rather than silently vanishing.
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    const blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
    expect(blocks[0].textContent).toContain('x');
    expect(blocks[1].textContent).toContain('y');

    // Changing back must leave an EMPTY slot, not conjure 'y' back.
    fireEvent.click(blocks[0].querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const grow = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(grow, { target: { value: 'binary' } });
    fireEvent.keyDown(grow, { key: 'Enter' });

    await waitFor(() => {
      const slot = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"] [data-tree-path="1"]');
      expect(slot?.dataset.kind).toBe('argPlaceholder');
    });
    expect(view.getByTestId('root-count').textContent).toBe('2');
  });

  it('keeps the context menu alive and actionable through a real pointer interaction', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const branch = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.contextMenu(branch);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    const item = within(menu).getByRole('menuitem', { name: /Detach into its own block/ });

    // A real click is pointerdown -> pointerup -> click. Both the block's
    // pointer capture and the canvas click handler used to eat these, which
    // is what made the menu feel dead. The menu must survive pointerdown and
    // still run its action on click.
    fireEvent.pointerDown(item, { pointerId: 70, button: 0, clientX: 5, clientY: 5 });
    expect(view.getByRole('menu', { name: 'Canvas block actions' })).toBeTruthy();
    fireEvent.pointerUp(item, { pointerId: 70, clientX: 5, clientY: 5 });
    fireEvent.click(item);

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    expect(view.queryByRole('menu', { name: 'Canvas block actions' })).toBeNull();
    // The canvas click handler must not have stolen the gesture and cleared
    // the focus the menu action just set on the detached block.
    await waitFor(() => {
      const blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
      expect(blocks[1].querySelector('[data-tree-path=""]')?.classList
        .contains('snl-canvas-focused')).toBe(true);
    });
  });

  it('undoes a drag-detach so one drag is one undo step', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const child = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;

    fireEvent.pointerDown(child, { pointerId: 80, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(child, { pointerId: 80, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(child, { pointerId: 80, clientX: 60, clientY: 60 });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));

    // Detaching is a 6px-slip away; it must be undoable.
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('child');
  });

  const variadicDriver = new MacroDataDriver({
    queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        if (macro_name === 'list') {
          return {
            macro_name, dynamic_arity: true,
            styles: [{ template: { mode: 'formula_inline', body: '#*', separator: ', ' } }]
          } as never;
        }
        if (macro_name === 'pair') {
          return {
            macro_name, dynamic_arity: false,
            styles: [{ template: { mode: 'formula_inline', body: '#0 + #1' } }]
          } as never;
        }
        return null;
      }
    }
  });
  const styledCanvasDriver = new MacroDataDriver({
    queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        if (macro_name === 'styled') {
          return {
            macro_name,
            dynamic_arity: false,
            styles: [
              { style_name: 'default', template: { mode: 'formula_inline', body: '#0' }, tags: [] },
              { style_name: 'wide', template: { mode: 'formula_inline', body: '#0 #1 #2' }, tags: [] }
            ]
          } as never;
        }
        return null;
      }
    }
  });

  function VariadicHarness({ initial }: { initial: SnlSyntaxTree[] }): React.ReactElement {
    const [forest, setForest] = React.useState(initial);
    return (
      <>
        <output data-testid="root-count">{forest.length}</output>
        <output data-testid="arity">{forest[0]?.children.length ?? 0}</output>
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={variadicDriver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      </>
    );
  }

  it('gives a newly inserted variadic Macro one clickable placeholder', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <>
          <output data-testid="inserted-arity">{forest[1]?.children.length ?? -1}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={variadicDriver}
            macroCandidates={[{ id: 'list', labels: [] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Insert Canvas root Macro' }));
    fireEvent.change(input, { target: { value: 'list' } });

    await waitFor(() => expect(view.getByTestId('inserted-arity').textContent).toBe('1'));
    const second = view.container.querySelector<HTMLElement>('[data-canvas-root-index="1"]')!;
    expect(second.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1);
  });

  it('commits a picked default Style from the focused Macro editor as one undoable change', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        { ...node('styled', [node('a'), node('b'), node('c')]), style_name: 'wide' }
      ] as SnlSyntaxTree[]);
      return (
        <>
          <output data-testid="focused-style">{forest[0]?.style_name ?? ''}</output>
          <output data-testid="focused-arity">{forest[0]?.children.length ?? 0}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={styledCanvasDriver}
            macroCandidates={[{ id: 'styled', labels: [], styles: ['default', 'wide'] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true });
    const search = await waitFor(() => view.getByRole('textbox', { name: 'Search macros in SNoogL' }));
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(view.getByTestId('focused-style').textContent).toBe(''));
    expect(view.getByTestId('focused-arity').textContent).toBe('1');

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('focused-style').textContent).toBe('wide'));
    expect(view.getByTestId('focused-arity').textContent).toBe('3');
  });

  it('commits a picked nondefault Style from the add-root editor and undoes it in one step', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <output data-testid="inserted-style">{forest[1]?.style_name ?? ''}</output>
          <output data-testid="inserted-arity">{forest[1]?.children.length ?? -1}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={styledCanvasDriver}
            macroCandidates={[{ id: 'styled', labels: [], styles: ['default', 'wide'] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const search = await waitFor(() => view.getByRole('textbox', { name: 'Search macros in SNoogL' }));
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    fireEvent.click(await view.findByRole('menuitem', { name: /wide/i }));
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    expect(view.getByTestId('inserted-style').textContent).toBe('wide');
    expect(view.getByTestId('inserted-arity').textContent).toBe('3');

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
  });

  it('gives a variadic Macro inserted into a placeholder one child too', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [createCanvasHole(0)])]);
      return (
        <>
          <output data-testid="replacement-arity">{forest[0]?.children[0]?.children.length ?? -1}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={variadicDriver}
            macroCandidates={[{ id: 'list', labels: [] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!);
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'list' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(view.getByTestId('replacement-arity').textContent).toBe('1'));
    expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(1);
  });

  it('does not let a slow node arity lookup overwrite a newer edit', async () => {
    let resolveList!: (value: unknown) => void;
    const slowList = new Promise((resolve) => { resolveList = resolve; });
    const racingDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) => {
          if (macro_name === 'list') return await slowList as never;
          if (macro_name === 'pair') {
            return {
              macro_name,
              dynamic_arity: false,
              styles: [{ template: { mode: 'formula_inline', body: '#0 + #1' } }]
            } as never;
          }
          return null;
        }
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <>
          <output data-testid="racing-name">{forest[0]?.macro_name}</output>
          <output data-testid="racing-arity">{forest[0]?.children.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={racingDriver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'list' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.change(editor, { target: { value: 'pair' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(view.getByTestId('racing-name').textContent).toBe('pair'));
    expect(view.getByTestId('racing-arity').textContent).toBe('2');
    resolveList({ macro_name: 'list', dynamic_arity: true, styles: [{ template: { mode: 'formula_inline', body: '#*' } }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.getByTestId('racing-name').textContent).toBe('pair');
    expect(view.getByTestId('racing-arity').textContent).toBe('2');
  });

  it('keeps an explicitly zero-arity variadic Macro at zero across F2 re-edit', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const control = await waitFor(() => view.getByLabelText('Argument count'));
    fireEvent.click(within(control).getByLabelText('Remove an argument'));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('0'));

    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'list' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(view.getByTestId('arity').textContent).toBe('0');
    expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(0);
  });

  it('does not collapse an existing variadic Macro that already has children', async () => {
    const view = render(
      <VariadicHarness initial={[node('list', [node('a'), node('b')])]} />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'list' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('a');
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="1"]')?.textContent).toBe('b');
  });

  it('keeps Canvas Macro identity and Style in separate input channels', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('list', [node('a')])]);
      return (
        <>
          <output data-testid="canvas-style">{forest[0]?.style_name ?? ''}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={variadicDriver}
            macroCandidates={[
              { id: 'list', labels: [], styles: ['default', 'compact'] }
            ]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
    fireEvent.click(root);
    const style = await waitFor(() =>
      view.getByRole('combobox', { name: 'Macro style' }) as HTMLSelectElement
    );
    expect(style.value).toBe('default');
    expect(root.textContent).not.toContain('[default]');
    expect(fireEvent.keyDown(style, { key: 'ArrowDown' })).toBe(true);
    expect(root.classList.contains('snl-canvas-focused')).toBe(true);
    fireEvent.change(style, { target: { value: 'compact' } });
    await waitFor(() => expect(view.getByTestId('canvas-style').textContent).toBe('compact'));
    expect((view.getByRole('combobox', { name: 'Macro style' }) as HTMLSelectElement).value)
      .toBe('compact');

    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'F2' });
    const macroEditor = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLInputElement
    );
    expect(macroEditor.value).toBe('list');
    fireEvent.change(macroEditor, { target: { value: 'list[default]' } });
    fireEvent.keyDown(macroEditor, { key: 'Enter' });
    await waitFor(() => expect(macroEditor.title).toContain('Style dropdown'));
    expect(view.getByTestId('canvas-style').textContent).toBe('compact');
    fireEvent.keyDown(macroEditor, { key: 'Escape' });
    fireEvent.keyDown(macroEditor, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());

    fireEvent.change(await waitFor(() => view.getByRole('combobox', { name: 'Macro style' })), {
      target: { value: 'default' }
    });
    await waitFor(() => expect(view.getByTestId('canvas-style').textContent).toBe(''));
  });

  it('can clear a missing Canvas Style from its only normal editing channel', async () => {
    function Harness(): React.ReactElement {
      const initial = { ...node('gone'), style_name: 'legacy' };
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([initial]);
      return (
        <>
          <output data-testid="missing-canvas-style">{forest[0]?.style_name ?? ''}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={variadicDriver}
            macroCandidates={[{ id: 'gone', labels: [], styles: [] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const style = await waitFor(() =>
      view.getByRole('combobox', { name: 'Macro style' }) as HTMLSelectElement
    );
    expect(Array.from(style.options).map((option) => option.value)).toContain('');
    fireEvent.change(style, { target: { value: '' } });
    await waitFor(() => expect(view.getByTestId('missing-canvas-style').textContent).toBe(''));
  });

  it('shows Edit/Create Macro links beside the focused Canvas controls', async () => {
    const edit = vi.fn();
    const known = render(
      <GuiCanvasEditor
        forest={[node('list', [node('a')])]}
        macroDataDriver={variadicDriver}
        macroOrigin={{ list: 'macros.json' }}
        onOpenMacroEditor={edit}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    fireEvent.click(known.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const editButton = await waitFor(() => known.getByRole('button', { name: 'Edit macro' }));
    expect(editButton.querySelector('svg[data-snl-icon="edit"]')).toBeTruthy();
    fireEvent.click(editButton);
    expect(edit).toHaveBeenCalledWith({ name: 'list', env_mode: undefined, style_name: undefined });
    expect(known.container.querySelector<HTMLElement>('[data-tree-path=""]')?.classList.contains('snl-canvas-focused')).toBe(true);
    expect(known.getByRole('button', { name: 'Edit macro' })).toBeTruthy();

    cleanup();
    const create = vi.fn();
    const unknown = render(
      <GuiCanvasEditor
        forest={[node('Fresh.macro')]}
        macroDataDriver={variadicDriver}
        macroOrigin={{}}
        onOpenMacroEditor={create}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    fireEvent.click(unknown.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const createButton = await waitFor(() => unknown.getByRole('button', { name: 'Create macro' }));
    fireEvent.click(createButton);
    expect(create).toHaveBeenCalledWith({
      name: 'Fresh.macro',
      env_mode: undefined,
      style_name: undefined
    });
    expect(unknown.container.querySelector<HTMLElement>('[data-tree-path=""]')?.classList.contains('snl-canvas-focused')).toBe(true);
    expect(unknown.getByRole('button', { name: 'Create macro' })).toBeTruthy();
  });

  it('grows and shrinks a variadic Macro with + and -', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    // Wait for the async dynamic_arity lookup to land.
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    fireEvent.keyDown(canvas, { key: '-', code: 'NumpadSubtract' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));

    // The main row works too.
    fireEvent.keyDown(canvas, { key: '+', code: 'Equal' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
  });

  it('leaves a fixed-arity Macro alone, since its template owns the count', async () => {
    const view = render(<VariadicHarness initial={[node('pair', [node('a'), node('b')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.container.querySelector('[data-tree-path=""]')?.classList
      .contains('snl-canvas-focused')).toBe(true));

    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.getByTestId('arity').textContent).toBe('2');
    expect(view.queryByLabelText('Argument count')).toBeNull();
  });

  it('undoes an arity change', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));
  });

  it('drives the same change from the inline [- n +] control', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const control = await waitFor(() => view.getByLabelText('Argument count'));
    expect(within(control).getByLabelText('Argument count value').textContent).toBe('1');

    fireEvent.click(within(control).getByLabelText('Add argument'));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    // The control must survive its own click — clicking it used to clear the
    // focus, so it vanished after a single use.
    fireEvent.click(within(view.getByLabelText('Argument count')).getByLabelText('Remove an argument'));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));
  });

  it('offers argument actions in the menu only for a variadic Macro', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(root);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());
    fireEvent.contextMenu(root);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    expect(within(menu).getByRole('menuitem', { name: /Add argument/ })).toBeTruthy();

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Add argument/ }));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
  });

  it('removes the slot outright when deleting a variadic child', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a'), node('b')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'Delete' });
    // Arity shrinks rather than leaving a blank the author cannot clear.
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('b');
  });

  it('leaves Ctrl/Cmd and Alt +/- to the browser and the OS', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    // Ctrl/Cmd +/- is browser zoom; Alt +/- belongs to the OS.
    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd', ctrlKey: true });
    fireEvent.keyDown(canvas, { key: '-', code: 'NumpadSubtract', metaKey: true });
    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd', altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.getByTestId('arity').textContent).toBe('1');

    // Unmodified still works.
    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
  });

  it('sheds an empty slot before evicting real content when shrinking', async () => {
    const view = render(
      <VariadicHarness initial={[node('list', [node('a'), createCanvasHole(1), node('b')])]} />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.keyDown(canvas, { key: '-', code: 'NumpadSubtract' });
    // The blank goes; 'b' stays put and nothing is evicted to a new block.
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    expect(view.getByTestId('root-count').textContent).toBe('1');
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="1"]')?.textContent).toBe('b');
  });

  it('shrinks a variadic parent when a child is dragged out', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a'), node('b')])]} />);
    const child = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    // Let the dynamic_arity lookup land before the gesture starts.
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.pointerDown(child, { pointerId: 90, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(child, { pointerId: 90, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(child, { pointerId: 90, clientX: 60, clientY: 60 });

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    // No blank left behind: the variadic parent simply has one argument now.
    expect(view.getByTestId('arity').textContent).toBe('1');
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('b');
  });

  it('highlights the variadic parent that a drop would grow', async () => {
    // The append target points one past the last child and so has no element
    // of its own; without the parent fallback there is no drop feedback.
    const view = render(
      <VariadicHarness initial={[node('list', [node('a')]), node('dragged')]} />
    );
    const parent = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(parent);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    const listBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    const dragBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="1"]')!;
    const dragRoot = dragBlock.querySelector<HTMLElement>('[data-tree-path=""]')!;
    const listRoot = listBlock.querySelector<HTMLElement>('[data-tree-path=""]')!;
    document.elementsFromPoint = () => [listRoot];

    fireEvent.pointerDown(dragRoot, { pointerId: 91, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(dragRoot, { pointerId: 91, clientX: 70, clientY: 70 });
    await waitFor(() => expect(listRoot.classList.contains('snl-canvas-drop-target')).toBe(true));

    fireEvent.pointerUp(dragRoot, { pointerId: 91, clientX: 70, clientY: 70 });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
    expect(view.getByTestId('arity').textContent).toBe('2');
  });

  // Cat 2026-07-26: the Canvas hosts two floating inputs. Only the node editor
  // had teardown paths; the "add a root" input leaked in every other exit.
  describe('floating input teardown', () => {
    function AddRootHarness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          macroCandidates={[{ id: 'Add.add', labels: [] }]}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const openAddRoot = async (view: ReturnType<typeof render>): Promise<HTMLElement> => {
      const canvas = await waitFor(() =>
        view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
      );
      fireEvent.click(canvas);
      fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
      await waitFor(() => view.getByRole('textbox', { name: 'Insert Canvas root Macro' }));
      return canvas;
    };

    it('destroys the add-root input when the user clicks elsewhere on the Canvas', async () => {
      const view = render(<AddRootHarness />);
      const canvas = await openAddRoot(view);
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0 });
      fireEvent.click(canvas);
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull()
      );
    });

    it('destroys the add-root input when the user right-clicks the Canvas', async () => {
      const view = render(<AddRootHarness />);
      const canvas = await openAddRoot(view);
      fireEvent.contextMenu(canvas);
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull()
      );
    });

    it('destroys the add-root input when the user clicks outside the Canvas', async () => {
      const view = render(<AddRootHarness />);
      await openAddRoot(view);
      fireEvent.pointerDown(document.body, { pointerId: 2, button: 0 });
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull()
      );
    });

    it('never shows the add-root input and the node editor at the same time', async () => {
      const view = render(<AddRootHarness />);
      await openAddRoot(view);
      const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
      fireEvent.doubleClick(root);
      await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
      expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull();
    });

    it('destroys the node editor when the context menu opens a root insert', async () => {
      const view = render(<AddRootHarness />);
      const canvas = await waitFor(() =>
        view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
      );
      const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
      fireEvent.doubleClick(root);
      await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
      fireEvent.contextMenu(canvas);
      fireEvent.click(view.getByRole('menuitem', { name: /Add root/i }));
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull()
      );
    });

    it('destroys the node editor when the edited node disappears from the forest', async () => {
      function ShrinkHarness(): React.ReactElement {
        const [forest, setForest] = React.useState([node('root', [node('child')])]);
        return (
          <>
            <button type="button" onClick={() => setForest([node('root')])}>drop child</button>
            <GuiCanvasEditor
              forest={forest}
              macroDataDriver={driver}
              kindPalette={undefined}
              onForestChange={setForest}
              onResetFromSnl={() => undefined}
            />
          </>
        );
      }
      const view = render(<ShrinkHarness />);
      const child = await waitFor(() =>
        view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!
      );
      fireEvent.doubleClick(child);
      await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
      fireEvent.click(view.getByText('drop child'));
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull()
      );
    });
  });

  it('re-reads dynamic_arity when the Macro source changes', async () => {
    function SwappableHarness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('list', [node('a')])]);
      const [variadic, setVariadic] = React.useState(false);
      // A fresh driver stands in for the Macro being edited mid-session.
      const driver = React.useMemo(() => new MacroDataDriver({
        queries: {
          query_macro: async ({ macro_name }: { macro_name: string }) =>
            macro_name === 'list'
              ? ({ macro_name, dynamic_arity: variadic, styles: [{ template: { mode: 'formula_inline', body: '#*' } }] } as never)
              : null
        }
      }), [variadic]);
      return (
        <>
          <button type="button" onClick={() => setVariadic(true)}>make variadic</button>
          <output data-testid="arity">{forest[0]?.children.length ?? 0}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<SwappableHarness />);
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(root);
    // Initially fixed: no control, and the cached answer says "not dynamic".
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.queryByLabelText('Argument count')).toBeNull();

    fireEvent.click(view.getByText('make variadic'));
    // A stale cache would keep the control hidden forever.
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());
  });
});
