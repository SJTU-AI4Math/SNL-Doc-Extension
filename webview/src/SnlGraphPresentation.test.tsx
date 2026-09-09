import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async (original) => ({
  ...(await original<typeof import('./vscodeApi')>()),
  useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
  nodes: ['a', 'b', 'c'].map((id, i) => ({
    id, packageId: i === 2 ? 'other' : 'logic', title: id.toUpperCase(), kind: 'Theorem', kindId: 'theorem', coloring: null
  })),
  edges: [
    { id: 'ab', from: 'a', to: 'b', label: 'depends', isDependency: true, isAtomic: true },
    { id: 'bc', from: 'b', to: 'c', label: 'uses', isDependency: false, isAtomic: null }
  ]
};
function send(data: unknown = graph): void { act(() => window.dispatchEvent(new MessageEvent('message', { data }))); }
const node = (id = 'a') => screen.getByRole('button', { name: `Entry ${id.toUpperCase()} (${id})` });
const transform = () => document.querySelector('svg > g[transform]')!.getAttribute('transform');
const anchors = () => ['a', 'b', 'c'].map(id => {
  const element = node(id), values = element.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  const [x, y, scale = 1] = values;
  const rect = element.querySelector('rect'), circle = element.querySelector('circle');
  return [x + scale * (rect ? Number(rect.getAttribute('width')) / 2 : Number(circle!.getAttribute('cx'))),
    y + scale * (rect ? Number(rect.getAttribute('height')) / 2 : Number(circle!.getAttribute('cy')))];
});
const path = () => screen.getByRole('button', { name: 'Relationship depends: a to b' }).querySelector('path')!.getAttribute('d');
const control = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });

beforeEach(() => {
  document.documentElement.lang = 'en';
  api.postMessage.mockReset();
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 400, width: 900, height: 400, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.lang = ''; });

describe('adaptive graph presentation', () => {
  it('reconciles a missing native leave when a hovered SVG shape is replaced', () => {
    render(<SnlGraphApp />); send();
    fireEvent.pointerEnter(node());
    expect(node().querySelector('rect')).not.toBeNull();
    // Real Chromium can omit pointerout after the hovered circle is replaced.
    fireEvent.pointerMove(screen.getByRole('combobox', { name: 'Layout' }));
    expect(node().querySelector('circle')).not.toBeNull();
    fireEvent.focus(node());
    fireEvent.pointerEnter(node());
    fireEvent.pointerMove(document.querySelector('main')!);
    expect(node().querySelector('rect')).not.toBeNull();
    fireEvent.blur(node());
    expect(node().querySelector('circle')).not.toBeNull();
  });

  it('cancels native wheel scrolling with a non-passive listener on the actual graph', () => {
    render(<SnlGraphApp />); send();
    const svg = document.getElementById('snl-graph-background')!.closest('svg')!;
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    act(() => svg.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });
  it('retains actual DOM keyboard focus when the focused card is raised', () => {
    render(<SnlGraphApp />); send();
    act(() => { (node() as unknown as SVGGElement).focus(); });
    expect(document.activeElement).toBe(node());
    expect(node().querySelector('rect')).not.toBeNull();
  });

  it('defaults to rectangle/auto/120%, expands actual cards on hover or independent keyboard focus, without moving anchors or fitting', () => {
    render(<SnlGraphApp />); send();
    expect(node().querySelector('circle')).not.toBeNull();
    expect(node().querySelector('rect')).toBeNull();
    expect((screen.getByRole('combobox', { name: 'Layout' }) as HTMLSelectElement).value).toBe('rectangle');
    expect((screen.getByRole('combobox', { name: 'Nodes' }) as HTMLSelectElement).value).toBe('auto');
    const threshold = screen.getByRole('slider', { name: 'Title threshold' }) as HTMLInputElement;
    expect([threshold.min, threshold.max, threshold.value]).toEqual(['20', '300', '120']);
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show relationships' }));
    const vp = transform(), positions = anchors(), before = path();
    fireEvent.focus(node());
    expect(node().querySelector('rect')).not.toBeNull();
    expect(node().querySelector('foreignObject')).not.toBeNull();
    expect(path()).not.toBe(before);
    fireEvent.pointerEnter(node());
    fireEvent.pointerLeave(node());
    expect(node().querySelector('rect')).not.toBeNull();
    expect(node().parentElement!.lastElementChild).toBe(node());
    fireEvent.blur(node());
    expect(node().querySelector('circle')).not.toBeNull();
    fireEvent.pointerEnter(node('b'));
    fireEvent.focus(node('b'));
    fireEvent.blur(node('b'));
    expect(node('b').querySelector('rect')).not.toBeNull();
    fireEvent.pointerLeave(node('b'));
    expect(node('b').querySelector('circle')).not.toBeNull();
    expect(anchors()).toEqual(positions);
    expect(transform()).toBe(vp);
    expect(path()).toBe(before);
  });

  it('uses inclusive zoom threshold, keeps presentation controls across refresh, fits layout changes only, and paints package sectors', () => {
    render(<SnlGraphApp />); send();
    const positions = anchors(), vp = transform();
    control('Nodes', 'always-title');
    expect(node().querySelector('rect')).not.toBeNull();
    expect(anchors()).toEqual(positions);
    expect(transform()).toBe(vp);
    control('Nodes', 'auto');
    const slider = screen.getByRole('slider', { name: 'Title threshold' });
    // Content fitting is no longer capped at exactly 1. Exercise equality
    // against the actual fitted zoom, then straddle it with wheel input.
    const fittedScale = Number(vp!.match(/scale\(([^)]+)\)/)![1]);
    fireEvent.change(slider, { target: { value: String(fittedScale * 100) } });
    expect(node().querySelector('rect')).not.toBeNull();
    fireEvent.change(slider, { target: { value: String(fittedScale * 120) } });
    expect(node().querySelector('circle')).not.toBeNull();
    const svg = document.querySelector('svg > g[transform]')!.parentElement!;
    fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
    expect(node().querySelector('circle')).not.toBeNull(); // 1.15 < 1.2 relative to fit
    fireEvent.wheel(svg, { deltaY: -100, clientX: 400, clientY: 300 });
    expect(node().querySelector('rect')).not.toBeNull();
    expect(anchors()).toEqual(positions);
    expect(transform()).not.toBe(vp);
    control('Layout', 'radial-outward');
    expect(anchors()).not.toEqual(positions);
    const radialVP = transform();
    expect(radialVP).not.toBe(vp);
    for (const cluster of screen.getAllByRole('group', { name: /^Package / })) {
      expect(cluster.querySelector('path')?.getAttribute('d')).toContain(' A ');
      expect(cluster.querySelector('rect')).toBeNull();
      expect(document.querySelector(`[data-package-label="${cluster.getAttribute('data-package-id')}"]`)).not.toBeNull();
    }
    control('Nodes', 'always-title');
    fireEvent.change(slider, { target: { value: '250' } });
    expect(transform()).toBe(radialVP);
    send({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() });
    expect((screen.getByRole('combobox', { name: 'Layout' }) as HTMLSelectElement).value).toBe('radial-outward');
    expect((screen.getByRole('combobox', { name: 'Nodes' }) as HTMLSelectElement).value).toBe('always-title');
    expect((slider as HTMLInputElement).value).toBe('250');
    expect(node().querySelector('rect')).not.toBeNull();
    control('Layout', 'radial-inward');
    control('Layout', 'rectangle');
    expect(anchors()).toEqual(positions);
  });

  it('preserves select/open/edit/keyboard actions and localizes new controls in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    render(<SnlGraphApp />); send();
    expect(screen.getByRole('combobox', { name: '布局' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '向内环铺' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '向外环铺' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '节点' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: '标题阈值' })).toBeTruthy();
    const a = screen.getByRole('button', { name: '条目 A（a）' });
    fireEvent.click(a);
    expect(screen.getByText(/已选择：A/)).toBeTruthy();
    fireEvent.click(a, { metaKey: true });
    fireEvent.keyDown(a, { key: 'Enter', ctrlKey: true });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openEntryInfoview', entryId: 'a' });
    const e = screen.getByRole('button', { name: '关系 depends：a 到 b' });
    fireEvent.keyDown(e, { key: ' ' });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'editRelationship', id: 'ab' });
  });
});
