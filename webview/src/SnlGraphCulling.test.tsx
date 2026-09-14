import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import katex from 'katex';
import { edgePath, graphNodePresentation, layout, SnlGraphApp } from './SnlGraphApp';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async original => ({
  ...(await original<typeof import('./vscodeApi')>()), useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
  nodes: ['a', 'b', 'c'].map(id => ({ id, packageId: 'logic', title: `Title $${id}$`, kind: 'Theorem', kindId: 'theorem', coloring: null })),
  edges: ['a', 'b'].map((id, i) => ({ id, from: id, to: ['b', 'c'][i], label: 'depends', isDependency: true, isAtomic: true }))
};
const send = (data: unknown = graph) => act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
const control = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const canvas = () => document.getElementById('snl-graph-background')!.closest('svg')!;
const nodes = () => [...canvas().querySelectorAll<SVGGElement>('[data-node-id]')];
const node = (id = 'a') => canvas().querySelector<SVGGElement>(`[data-node-id="${id}"]`)!;
const numbers = (text: string) => text.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
const viewport = () => {
  const [x, y, scale] = numbers(canvas().querySelector('[data-graph-viewport]')!.getAttribute('transform')!);
  return { x, y, scale };
};
const cardBounds = (group: Element) => {
  const [x, y] = numbers(group.getAttribute('transform')!);
  const card = group.querySelector('rect'), circle = group.querySelector('circle');
  return { x, y, w: card ? Number(card.getAttribute('width')) : 2 * Number(circle!.getAttribute('cx')),
    h: card ? Number(card.getAttribute('height')) : 2 * Number(circle!.getAttribute('cy')) };
};
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {} });
let width: number, height: number, sidebarWidth: number;
const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
const resize = () => act(() => { for (const o of observers) if (o.targets.size) o.callback([], {} as ResizeObserver); });
function pan(dx: number, dy: number) {
  fireEvent.pointerDown(canvas(), { clientX: 100, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(canvas(), { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
  fireEvent.pointerUp(canvas(), { pointerId: 1 });
}
function placeCard(left: number, top: number, id = 'a') {
  const vp = viewport(), card = cardBounds(node(id));
  pan(left - (vp.x + vp.scale * card.x), top - (vp.y + vp.scale * card.y));
}
function assertNearTitles() {
  const vp = viewport();
  let count = 0;
  for (const group of nodes()) {
    const b = cardBounds(group);
    // Independent screen-space AABB oracle; production inverts to world space.
    const near = vp.x + (b.x + b.w) * vp.scale >= -256 && vp.x + b.x * vp.scale <= width - sidebarWidth + 256 &&
      vp.y + (b.y + b.h) * vp.scale >= -256 && vp.y + b.y * vp.scale <= height + 256;
    expect(group.getAttribute('data-node-shape'), group.dataset.nodeId).toBe(near ? 'title' : 'dot');
    expect(group.querySelectorAll('foreignObject')).toHaveLength(near ? 1 : 0);
    expect(group.querySelectorAll('.katex')).toHaveLength(near ? 1 : 0);
    if (near) count++;
  }
  return count;
}
beforeEach(() => {
  document.documentElement.lang = 'en'; width = 900; height = 700; sidebarWidth = 28; observers.length = 0;
  api.postMessage.mockReset();
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(70, 100, width, height));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.matches('[data-graph-sidebar]') ? rect(70 + width - sidebarWidth, 100, sidebarWidth, height) : rect(0, 0, 0, 0);
  });
  vi.stubGlobal('ResizeObserver', class {
    record: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set() }; observers.push(this.record); }
    observe(target: Element) { this.record.targets.add(target); }
    disconnect() { this.record.targets.clear(); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.lang = ''; });

describe('larger near-viewport graph titles', () => {
  it('reserves enlarged world cards in layout and scales their actual typography without zoom compensation', () => {
    const inputs = [
      { id: 'short', title: 'A', kind: 'X' },
      { id: 'title', title: 'X'.repeat(20), kind: 'X' },
      { id: 'kind', title: 'X', kind: 'K'.repeat(20) },
      { id: 'wide', title: 'X'.repeat(100), kind: 'X' }
    ].map(n => ({ ...n, packageId: 'logic', kindId: 'theorem', color: '#888', background: 'transparent' }));
    const result = layout(inputs, []);
    expect(Object.fromEntries(result.nodes.map(n => [n.id, [n.w, n.h]]))).toEqual({ short: [135, 66], title: [255, 66], kind: [210, 66], wide: [480, 66] });
    const ordered = [...result.nodes].sort((a, b) => a.x - b.x);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i].x - ordered[i - 1].x).toBeGreaterThan(ordered[i - 1].w);
    for (const scale of [0.02, 0.5, 2]) expect(graphNodePresentation(result.nodes[0], scale, true)).toMatchObject({ dotRadius: 12, cornerRadius: 6, presentationScale: 1 });
    render(<SnlGraphApp />); send(); control('Nodes', 'always-title');
    expect(node().querySelector('rect')!.getAttribute('height')).toBe('66');
    expect(node().querySelector('rect')!.getAttribute('rx')).toBe('6');
    expect(node().querySelector('text')!.getAttribute('font-size')).toBe('16.5');
    expect(node().querySelector('foreignObject')!.getAttribute('x')).toBe('15');
    expect((node().querySelector('foreignObject > div') as HTMLElement).style.fontSize).toBe('19.5px');
    expect((node().querySelector('foreignObject > div') as HTMLElement).style.lineHeight).toBe('30px');
  });

  it('unmounts far titles even in Always title while retaining every cheap focusable node', () => {
    render(<SnlGraphApp />); send(); control('Nodes', 'always-title');
    expect(assertNearTitles()).toBe(3);
    const identities = nodes(), positions = identities.map(cardBounds);
    pan(5000, 5000);
    expect(nodes()).toHaveLength(3);
    expect(assertNearTitles()).toBe(0);
    const katexRender = vi.spyOn(katex, 'renderToString'); katexRender.mockClear();
    control('Nodes', 'auto'); control('Nodes', 'always-title');
    expect(katexRender).not.toHaveBeenCalled();
    expect(nodes().map(cardBounds)).toEqual(positions);
    for (const group of identities) {
      expect(group.isConnected).toBe(true);
      expect(group.getAttribute('tabindex')).toBe('0');
      expect(group.getAttribute('aria-label')).toContain('Entry Title');
      expect([...group.children].map(child => child.tagName)).toEqual(['circle']);
    }
    const moved = viewport(); resize(); expect(viewport()).toEqual(moved);
    expect(observers).toHaveLength(1); // presentation never re-runs layout/fit ownership
    expect(observers[0].targets.size).toBe(2);
    pan(-5000, -5000); expect(assertNearTitles()).toBe(3);
  });

  it.each(['left', 'right', 'top', 'bottom'])('uses the full card AABB at the %s 256px buffer, not just its center', side => {
    render(<SnlGraphApp />); send(); control('Nodes', 'always-title');
    const positions = nodes().map(cardBounds), vp = viewport(), b = cardBounds(node());
    const boundary = side === 'left' ? -256 - b.w * vp.scale : side === 'right' ? width - sidebarWidth + 256
      : side === 'top' ? -256 - b.h * vp.scale : height + 256;
    const sign = side === 'left' || side === 'top' ? -1 : 1;
    const move = (offset: number) => side === 'left' || side === 'right'
      ? placeCard(boundary + offset, 100) : placeCard(100, boundary + offset);
    move(-sign * 0.01); // only a sliver of the card overlaps, its center is outside
    expect(node().querySelector('foreignObject')).not.toBeNull();
    move(sign * 0.01);
    expect(node().querySelector('foreignObject')).toBeNull();
    expect(node().querySelector('text')).toBeNull();
    move(-sign * 10);
    expect(node().querySelector('foreignObject')).not.toBeNull();
    expect(nodes().map(cardBounds).sort((a, b) => a.y - b.y)).toEqual(positions.sort((a, b) => a.y - b.y));
    expect(viewport().scale).toBe(vp.scale);
  });

  it('gates Auto hover/focus and threshold; far focus keeps its exact group but not its title or card edge ports', () => {
    render(<SnlGraphApp />); send();
    fireEvent.change(screen.getByRole('slider', { name: 'Title threshold' }), { target: { value: '300' } });
    const a = node(), original = cardBounds(a);
    act(() => a.focus());
    fireEvent.pointerEnter(a); fireEvent.pointerLeave(a);
    expect(document.activeElement).toBe(a);
    expect(a.querySelector('foreignObject')).not.toBeNull();
    pan(5000, 5000);
    expect(document.activeElement).toBe(a);
    expect(node()).toBe(a);
    expect(a.querySelector('foreignObject')).toBeNull();
    fireEvent.pointerEnter(a); // even a synthetic offscreen hover cannot exempt it
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(screen.getByText(/selected: Title/)).toBeTruthy();
    expect(a.querySelector('circle')!.getAttribute('r')).toBe('12');
    expect(a.querySelector('circle')!.getAttribute('stroke-width')).toBe('3.5');
    const b = cardBounds(node('b'));
    expect(canvas().querySelector('[data-edge-id="a"] path')!.getAttribute('d')).toBe(
      edgePath(original, b, [], { fromShape: 'dot', toShape: 'dot' }).d);
    fireEvent.pointerLeave(a);
    fireEvent.keyDown(a, { key: 'Enter', ctrlKey: true });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openEntryInfoview', entryId: 'a' });
    const vp = viewport();
    control('Nodes', 'always-title'); expect(a.querySelector('foreignObject')).toBeNull();
    control('Nodes', 'auto'); expect(viewport()).toEqual(vp);
    pan(-5000, -5000);
    expect(document.activeElement).toBe(a);
    expect(a.querySelector('foreignObject')).not.toBeNull();
    act(() => a.blur()); expect(a.querySelector('circle')).not.toBeNull();
    expect(cardBounds(a)).toEqual(original);
  });

  it('routes a selected edge to the actual near card and far dot without moving either center or refitting', () => {
    render(<SnlGraphApp />); send();
    while (viewport().scale < 8) fireEvent.wheel(canvas(), { deltaY: -100, clientX: 70, clientY: 100 });
    placeCard(100, 100);
    expect(node().getAttribute('data-node-shape')).toBe('title');
    expect(node('b').getAttribute('data-node-shape')).toBe('dot');
    const from = cardBounds(node()), to = cardBounds(node('b')), vp = viewport();
    fireEvent.click(node());
    const d = canvas().querySelector('[data-edge-id="a"] path')!.getAttribute('d')!;
    expect(d).toBe(edgePath(from, to, [], { fromShape: 'title', toShape: 'dot' }).d);
    const values = numbers(d);
    expect(values[1]).toBeCloseTo(from.y + from.h);
    expect(values.at(-1)).toBeCloseTo(to.y + to.h / 2 - 12);
    expect(viewport()).toEqual(vp);
    expect(cardBounds(node())).toEqual(from); expect(cardBounds(node('b'))).toEqual(to);
    expect(observers).toHaveLength(1);
  });

  it('recomputes buffer membership through zoom and changing SVG/sidebar sizes without interaction refits', () => {
    render(<SnlGraphApp />); send(); control('Nodes', 'always-title');
    const positions = nodes().map(cardBounds);
    placeCard(width - sidebarWidth + 250, 100);
    expect(node().querySelector('foreignObject')).not.toBeNull();
    const old = viewport();
    fireEvent.wheel(canvas(), { deltaY: -100, clientX: 70, clientY: 100 });
    expect(viewport().scale).toBeCloseTo(old.scale * 1.15);
    expect(node().querySelector('foreignObject')).toBeNull();
    assertNearTitles();
    const manual = viewport(); resize(); expect(viewport()).toEqual(manual);
    sidebarWidth = 350; resize();
    expect(viewport()).not.toEqual(manual); expect(assertNearTitles()).toBe(3);
    placeCard(width - sidebarWidth + 257, 100); // inside full SVG buffer, outside AVAILABLE buffer
    expect(node().querySelector('foreignObject')).toBeNull();
    placeCard(width - sidebarWidth + 255, 100);
    expect(node().querySelector('foreignObject')).not.toBeNull();
    width = 600; height = 400; resize(); expect(assertNearTitles()).toBe(3);
    placeCard(100, height + 257); expect(node().querySelector('foreignObject')).toBeNull();
    placeCard(100, height + 255); expect(node().querySelector('foreignObject')).not.toBeNull();
    sidebarWidth = 28; fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    expect(assertNearTitles()).toBe(3);
    expect(nodes().map(cardBounds).sort((a, b) => a.y - b.y)).toEqual(positions.sort((a, b) => a.y - b.y));
    expect(observers.filter(o => o.targets.size)).toHaveLength(1);
  });

  it('fails closed before measurement, after invalid size and on empty/restore; retired observer callbacks cannot read DOM', () => {
    width = 0;
    const katexRender = vi.spyOn(katex, 'renderToString');
    const { unmount } = render(<StrictMode><SnlGraphApp /></StrictMode>);
    expect(observers).toHaveLength(0);
    send(); control('Nodes', 'always-title');
    act(() => node().focus());
    expect(canvas().querySelector('foreignObject')).toBeNull();
    expect(katexRender).not.toHaveBeenCalled();
    width = 900; resize(); expect(assertNearTitles()).toBe(3);
    height = 0; resize();
    expect(canvas().querySelector('foreignObject')).toBeNull();
    height = 700; resize(); expect(assertNearTitles()).toBe(3);
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    fireEvent.click(screen.getByTitle('Hide every entry kind'));
    expect(document.getElementById('snl-graph-background')).toBeNull();
    expect(observers.every(o => o.targets.size === 0)).toBe(true);
    width = 0; katexRender.mockClear();
    fireEvent.click(screen.getByTitle('Show every entry kind (reset kind filter)'));
    expect(canvas().querySelector('foreignObject')).toBeNull();
    expect(katexRender).not.toHaveBeenCalled(); // no transient full-title render using old canvas size
    width = 900; resize(); expect(assertNearTitles()).toBe(3);
    unmount(); expect(observers.every(o => o.targets.size === 0)).toBe(true);
    const reads = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect'); reads.mockClear();
    const sidebarReads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect'); sidebarReads.mockClear();
    katexRender.mockClear();
    act(() => { for (const o of observers) o.callback([], {} as ResizeObserver); });
    expect(reads).not.toHaveBeenCalled(); expect(sidebarReads).not.toHaveBeenCalled();
    expect(katexRender).not.toHaveBeenCalled();
  });

  it('crosses the Auto threshold on a large complete graph without mounting or compiling far titles', () => {
    const fixture = { ...graph,
      nodes: Array.from({ length: 1000 }, (_, i) => ({ ...graph.nodes[0], id: `n${i}`, title: `Result $x_{${i}}$` })),
      edges: Array.from({ length: 999 }, (_, i) => ({ ...graph.edges[0], id: `e${i}`, from: `n${i + 1}`, to: 'n0' }))
    };
    render(<SnlGraphApp />); send(fixture);
    const identities = nodes(), positions = new Map(identities.map(n => [n.dataset.nodeId, cardBounds(n)]));
    expect(nodes()).toHaveLength(1000);
    expect(canvas().querySelector('foreignObject')).toBeNull();
    expect(canvas().querySelector('[data-edge-id]')).toBeNull(); // default-off topology preserved
    const b = cardBounds(node('n0')), initial = viewport();
    const clientX = 70 + initial.x + (b.x + b.w / 2) * initial.scale;
    const clientY = 100 + initial.y + (b.y + b.h / 2) * initial.scale;
    const started = performance.now();
    let steps = 0;
    while (viewport().scale < 1.2 && steps++ < 80) fireEvent.wheel(canvas(), { deltaY: -100, clientX, clientY });
    expect(viewport().scale).toBeGreaterThanOrEqual(1.2);
    const nearCount = assertNearTitles();
    expect(nearCount).toBeGreaterThan(0); expect(nearCount).toBeLessThan(100);
    const katexRender = vi.spyOn(katex, 'renderToString'); katexRender.mockClear();
    fireEvent.wheel(canvas(), { deltaY: -100, clientX, clientY });
    const mountedTitles = new Set(nodes().filter(n => n.querySelector('foreignObject')).map(n => fixture.nodes.find(input => input.id === n.dataset.nodeId)!.title));
    expect(katexRender).toHaveBeenCalledTimes(mountedTitles.size);
    for (const [text] of katexRender.mock.calls) expect(mountedTitles.has(text.slice(6, -1))).toBe(true);
    assertNearTitles();
    pan(0, 2000); assertNearTitles();
    expect(nodes()).toHaveLength(1000);
    for (const n of identities) { expect(n.isConnected).toBe(true); expect(cardBounds(n)).toEqual(positions.get(n.dataset.nodeId)); }
    expect(observers.filter(o => o.targets.size)).toHaveLength(1);
    console.info('1000-node culling threshold/zoom/pan', { steps, nearCount, elapsedMs: performance.now() - started });
  }, 15000);
});
