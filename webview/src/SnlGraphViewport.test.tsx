import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async original => ({
  ...(await original<typeof import('./vscodeApi')>()), useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
  nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, packageId: 'logic', title: 'Wide title '.repeat(10), kind: 'Theorem', kindId: i < 4 ? 'a' : 'b', coloring: null })),
  edges: Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}`, label: 'depends', isDependency: true, isAtomic: true }))
};
const send = (data: unknown = graph) => act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
const control = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const canvas = () => document.getElementById('snl-graph-background')!.closest('svg')!;
const viewport = () => {
  const values = canvas().querySelector(':scope > g[transform]')!.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  return { x: values[0], y: values[1], scale: values[2] };
};
const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {} });
let width: number, height: number;
const observers: { callback: ResizeObserverCallback; targets: Set<Element>; disconnect: ReturnType<typeof vi.fn> }[] = [];
function resize() { act(() => { for (const o of observers) if (o.targets.size) o.callback([], {} as ResizeObserver); }); }
function assertCardsInside(availableWidth = width) {
  const vp = viewport();
  for (const group of canvas().querySelectorAll('[data-node-id]')) {
    const card = group.querySelector('rect')!;
    const [x, y] = group.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    expect(vp.x + x * vp.scale).toBeGreaterThanOrEqual(19.99);
    expect(vp.y + y * vp.scale).toBeGreaterThanOrEqual(19.99);
    expect(vp.x + (x + Number(card.getAttribute('width'))) * vp.scale).toBeLessThanOrEqual(availableWidth - 19.99);
    expect(vp.y + (y + Number(card.getAttribute('height'))) * vp.scale).toBeLessThanOrEqual(height - 19.99);
  }
}
beforeEach(() => {
  document.documentElement.lang = 'en'; width = 900; height = 700; observers.length = 0;
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(70, 100, width, height));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.matches('[data-graph-sidebar]') ? rect(70 + width - (this.querySelector('#snl-graph-filter-settings') ? 280 : 28), 100, this.querySelector('#snl-graph-filter-settings') ? 280 : 28, height) : rect(0, 0, 0, 0);
  });
  vi.stubGlobal('ResizeObserver', class {
    record: (typeof observers)[number];
    constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set(), disconnect: vi.fn(() => this.record.targets.clear()) }; observers.push(this.record); }
    observe(target: Element) { this.record.targets.add(target); }
    disconnect() { this.record.disconnect(); }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.lang = ''; });

describe('actual-content graph viewport', () => {
  it.each(['radial-outward', 'radial-inward'] as const)('%s switches packing only in Settings, refits, retains refresh/rectangle state, and resets on remount', mode => {
    const fixture = { ...graph, edges: graph.nodes.slice(1).map((n, i) => ({ ...graph.edges[i], from: n.id, to: 'n0' })) };
    const { unmount } = render(<SnlGraphApp />); send(fixture);
    expect(screen.queryByRole('combobox', { name: 'Layer packing' })).toBeNull();
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    const packing = () => screen.getByRole('combobox', { name: 'Layer packing' }) as HTMLSelectElement;
    expect(packing().closest('#snl-graph-filter-settings')).not.toBeNull();
    expect(packing().value).toBe('bands');
    expect(packing().getAttribute('aria-describedby')).toBeTruthy();
    control('Nodes', 'always-title'); control('Layout', mode);
    const positions = () => [...canvas().querySelectorAll('[data-node-id]')].map(n => n.getAttribute('transform'));
    const compact = positions(), fit = viewport();
    fireEvent.wheel(canvas(), { deltaY: 100 });
    control('Layer packing', 'rings');
    expect(canvas().getAttribute('data-layer-packing')).toBe('rings');
    expect(positions()).not.toEqual(compact); expect(viewport()).not.toEqual(fit);
    assertCardsInside(width - 280);
    const strict = positions(); send(fixture);
    expect(packing().value).toBe('rings'); expect(positions()).toEqual(strict);
    control('Layout', 'rectangle');
    const flat = positions(); fireEvent.wheel(canvas(), { deltaY: 100 }); const flatZoom = viewport();
    control('Layer packing', 'bands');
    expect(positions()).toEqual(flat); expect(viewport()).toEqual(flatZoom);
    control('Layer packing', 'rings'); control('Layout', mode);
    expect(positions()).toEqual(strict);
    control('Layer packing', 'bands'); expect(positions()).toEqual(compact); expect(viewport()).toEqual(fit);
    const stable = viewport();
    fireEvent.pointerEnter(canvas().querySelector('[data-node-id]')!);
    control('Nodes', 'auto'); expect(viewport()).toEqual(stable);
    unmount(); render(<SnlGraphApp />); send(fixture);
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    expect(packing().value).toBe('bands');
  });
  it('localizes the native Settings packing control and its trade-off help in Chinese', () => {
    document.documentElement.lang = 'zh-CN'; render(<SnlGraphApp />); send();
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    expect(screen.getByRole('combobox', { name: '同层铺排' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '紧凑环带' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '严格同心圆' })).toBeTruthy();
    expect(screen.getByText(/同层同半径.*留白/)).toBeTruthy();
  });
  it('owns observers across loading, StrictMode replay, filtered-empty and remount transitions', () => {
    const { unmount } = render(<StrictMode><SnlGraphApp /></StrictMode>);
    expect(observers).toHaveLength(0);
    send(); expect(observers.some(o => o.targets.has(canvas()))).toBe(true);
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    fireEvent.click(screen.getByTitle('Hide every entry kind'));
    expect(document.getElementById('snl-graph-background')).toBeNull();
    expect(observers.every(o => o.targets.size === 0)).toBe(true);
    fireEvent.click(screen.getByTitle('Show every entry kind (reset kind filter)'));
    expect(observers.some(o => o.targets.has(canvas()))).toBe(true);
    unmount(); expect(observers.every(o => o.targets.size === 0)).toBe(true);
  });
  it.each(['radial-outward', 'radial-inward'] as const)('%s fits the occupied title bounds, not a blank circular square', mode => {
    render(<SnlGraphApp />); send(); control('Nodes', 'always-title'); control('Layout', mode);
    assertCardsInside(width - 28);
    expect(viewport().scale).toBeGreaterThan(1);
  });
  it('upscales small content up to the manual zoom ceiling', () => {
    render(<SnlGraphApp />); send({ ...graph, nodes: [{ ...graph.nodes[0], title: 'A' }], edges: [{ ...graph.edges[0], from: 'n0', to: 'n0' }] });
    control('Nodes', 'always-title');
    expect(viewport().scale).toBeGreaterThan(1);
    expect(viewport().scale).toBeLessThanOrEqual(5);
    assertCardsInside(width - 28);
  });
  it.each(['rectangle', 'radial-outward', 'radial-inward'] as const)('%s keeps Package text at screen size 12 through zoom without moving card world centers', mode => {
    render(<SnlGraphApp />); send(); control('Layout', mode);
    const labels = () => [...canvas().querySelectorAll('[data-package-label]')];
    expect(labels()).toHaveLength(1);
    const before = [...canvas().querySelectorAll('[data-node-id]')].map(n => n.getAttribute('transform'));
    for (const deltaY of [100, 100, -100, -100, -100]) {
      fireEvent.wheel(canvas(), { deltaY, clientX: 400, clientY: 300 });
      for (const label of labels()) {
        expect(label.getAttribute('font-size')).toBe('12');
        expect(label.closest('[transform]')).toBeNull();
        const [x, y] = label.getAttribute('data-world-anchor')!.split(',').map(Number);
        expect(Number(label.getAttribute('x'))).toBeCloseTo(viewport().x + x * viewport().scale);
        expect(Number(label.getAttribute('y'))).toBeCloseTo(viewport().y + y * viewport().scale);
        expect(label.getAttribute('fill')).toContain('--vscode-foreground');
      }
    }
    expect([...canvas().querySelectorAll('[data-node-id]')].map(n => n.getAttribute('transform'))).toEqual(before);
  });
  it('refits after resize, sidebar toggles and node filters, but not presentation or ordinary zoom; releases observer ownership', () => {
    const { unmount } = render(<SnlGraphApp />); send(); control('Nodes', 'always-title'); control('Layout', 'radial-outward');
    expect(observers.some(o => o.targets.has(canvas()))).toBe(true);
    const old = viewport();
    width = 500; height = 400; resize();
    expect(viewport()).not.toEqual(old); assertCardsInside(width - 28);
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    assertCardsInside(width - 280);
    const sidebar = viewport();
    // Quick kind restriction leaves a connected four-node chain.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Theorem' })[0]);
    expect(viewport()).not.toEqual(sidebar);
    assertCardsInside(width - 280);
    const fit = viewport(); control('Nodes', 'auto'); expect(viewport()).toEqual(fit);
    fireEvent.wheel(canvas(), { deltaY: 100 }); expect(viewport()).not.toEqual(fit);
    const zoomed = viewport(); resize(); expect(viewport()).toEqual(zoomed); // same-size observer notification is not a fit
    unmount(); expect(observers.every(o => o.disconnect.mock.calls.length > 0)).toBe(true);
    // A queued callback after teardown is inert, even before geometry reads.
    const reads = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect'); reads.mockClear();
    act(() => { for (const o of observers) o.callback([], {} as ResizeObserver); });
    expect(reads).not.toHaveBeenCalled();
  });
});
