import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fitGraphViewport, SnlGraphApp } from './SnlGraphApp';
import { apply_preferences_snapshot, set_content_language } from './runtime/preferencesRuntime';

const api = vi.hoisted(() => ({ postMessage: vi.fn(), setState: vi.fn() }));
vi.mock('./vscodeApi', async original => ({
  ...(await original<typeof import('./vscodeApi')>()), useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Feedback', warnings: [],
  nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, packageId: i < 2 ? 'logic' : 'other', title: id,
    kind: 'Theorem', kindId: 'theorem', coloring: null })),
  edges: [['ab', 'a', 'b'], ['bc', 'b', 'c'], ['dd', 'd', 'd']].map(([id, from, to]) => ({ id, from, to,
    label: id, isDependency: false, isAtomic: null as boolean | null }))
};
const send = (data: unknown = graph) => act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
const node = (id: string) => document.querySelector(`[data-node-id="${id}"]`)!;
const edges = () => [...document.querySelectorAll('[data-edge-id]')].map(e => e.getAttribute('data-edge-id')).sort();
const canvas = () => document.getElementById('snl-graph-background')!.closest('svg')!;
const transform = () => document.querySelector('[data-graph-viewport]')!.getAttribute('transform');
const positions = () => graph.nodes.map(n => node(n.id).getAttribute('transform'));
const control = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const toggle = () => screen.getByRole('checkbox', { name: 'Show relationships' }) as HTMLInputElement;
function mount(data: unknown = graph) {
  const view = render(<SnlGraphApp />); send(data);
  fireEvent.click(screen.getByTestId('graph-filter-toggle'));
  return view;
}
beforeEach(() => {
  document.documentElement.lang = 'en'; api.postMessage.mockReset(); api.setState.mockReset();
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
    right: 900, bottom: 600, width: 900, height: 600, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.lang = ''; set_content_language('en'); });

describe('localized graph title-visible positive controls', () => {
  it('updates the SVG Kind, painted title and ARIA with content language while UI remains English', () => {
    set_content_language('en');
    const localized = (en: string, zh: string) => ({ type: 'i18n', default_language: 'en', values: { en, 'zh-CN': zh } });
    mount({ ...graph, nodes: graph.nodes.map(n => ({ ...n,
      title: localized(`Title ${n.id}`, `标题${n.id}`), kind: localized('Theorem', '定理')
    })) });
    control('Nodes', 'always-title');
    const check = (kind: string, title: string) => {
      expect(screen.getByRole('checkbox', { name: kind })).toBeTruthy();
      expect(node('a').querySelector('text')?.textContent).toBe(kind);
      expect(node('a').getAttribute('aria-label')).toBe(`Entry ${title} (a)`);
      // KaTeX \\text renders ordinary spaces as NBSP; normalize only that paint encoding.
      const titles = [...canvas().querySelectorAll('foreignObject')].map(e => e.textContent?.replace(/\u00a0/g, ' '));
      expect(titles).toContain(title);
      expect(screen.getByRole('combobox', { name: 'Nodes' })).toBeTruthy();
    };
    check('Theorem', 'Title a');
    act(() => set_content_language('zh-CN'));
    check('定理', '标题a');
    expect(node('a').querySelector('text')?.textContent).not.toContain('Theorem');
    act(() => set_content_language('en'));
    check('Theorem', 'Title a');
  });
});

describe('EntryPackage coloring', () => {
  const fill = (id: string) => node(id).querySelector('rect, circle')!.getAttribute('fill');
  it.each(['rectangle', 'radial-inward', 'radial-outward'])('paints by full package identity without touching viewport or centers in %s', layout => {
    mount(); control('Layout', layout); control('Nodes', 'always-title');
    expect(screen.getByRole('option', { name: 'EntryPackage' })).toBeTruthy();
    const fallback = fill('a');
    fireEvent.wheel(canvas(), { deltaY: 100, clientX: 330, clientY: 220 });
    const vp = transform(), anchors = positions();
    control('Coloring mode', 'package');
    const color = fill('a'); expect(color).not.toBe(fallback);
    expect(fill('b')).toBe(color); expect(fill('c')).not.toBe(color); expect(fill('d')).toBe(fill('c'));
    fireEvent.click(node('a')); fireEvent.focus(node('a'));
    expect(fill('a')).toBe(color); expect(node('a').querySelector('rect')!.getAttribute('stroke-width')).toBe('3.5');
    control('Coloring mode', 'tag'); expect(fill('a')).toBe(fallback);
    control('Coloring mode', 'kind'); expect(fill('a')).toBe(fallback);
    control('Coloring mode', 'package'); expect(fill('a')).toBe(color);
    expect(transform()).toBe(vp); expect(positions()).toEqual(anchors);
    fireEvent.click(screen.getByTitle('Hide every entry kind'));
    fireEvent.click(screen.getByTitle('Show every entry kind (reset kind filter)')); expect(fill('a')).toBe(color);
    send({ ...graph, nodes: [...graph.nodes].reverse() }); expect(fill('a')).toBe(color);
    // Removing unrelated packages must not reassign an existing package's swatch.
    send({ ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1) }); expect(fill('a')).toBe(color);
  });

  it('handles prototype-like/full-path package IDs, stable remount colors, and themed unpackaged fallback with readable text', () => {
    const packages = ['__proto__', 'constructor', 'root/left', 'root/right', ''];
    const data = { ...graph, nodes: packages.map((packageId, i) => ({ ...graph.nodes[0], id: String(i), packageId,
      coloring: { light: { stroke: '#334455', background: '#ddeeff' }, dark: { stroke: '#aabbcc', background: '#112233' } } })),
      edges: packages.map((_, i) => ({ ...graph.edges[0], id: String(i), from: String(i), to: String(i) })) };
    const theme = (color_scheme: 'light' | 'dark', revision: number) => act(() => {
      apply_preferences_snapshot({ type: 'snl.preferences/snapshot', generation: 'graph-package-feedback', revision,
        preferences: { language: 'en', color_scheme, motion: 'full' } });
    });
    const view = mount(data); theme('light', 1); control('Nodes', 'always-title');
    expect(screen.getByRole('option', { name: 'EntryPackage' })).toBeTruthy(); control('Coloring mode', 'package');
    const colors = packages.slice(0, -1).map((_, i) => fill(String(i)));
    expect(colors.every(color => /^#[0-9a-f]{6}$/i.test(color!))).toBe(true);
    expect(fill('2')).not.toBe(fill('3')); expect(fill('4')).toBe('#ddeeff');
    theme('dark', 2); expect(packages.slice(0, -1).map((_, i) => fill(String(i)))).toEqual(colors);
    expect(fill('4')).toBe('#112233'); expect(node('0').querySelector('rect')!.getAttribute('stroke')).toBe('#aabbcc');
    for (let i = 0; i < 4; i++) {
      const background = fill(String(i))!;
      const rgb = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      const text = node(String(i)).querySelector('text')!.getAttribute('fill');
      const contrast = text === '#000000' ? (luminance + .05) / .05 : 1.05 / (luminance + .05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    view.unmount(); mount(data);
    expect((screen.getByRole('combobox', { name: 'Coloring mode' }) as HTMLSelectElement).value).toBe('kind');
    control('Coloring mode', 'package'); expect(packages.slice(0, -1).map((_, i) => fill(String(i)))).toEqual(colors);
    theme('light', 3);
  });
});

describe('expanded zoom range', () => {
  it('fits a wide finite world below the old floor and allows useful automatic zoom above the old ceiling', () => {
    const wide = fitGraphViewport({ minX: 0, minY: 0, maxX: 1e7, maxY: 1e7 }, 900, 600);
    expect(wide.scale).toBeLessThan(.05); expect(wide.scale).toBeGreaterThanOrEqual(1e-5);
    expect(wide.x + 1e7 * wide.scale).toBeLessThanOrEqual(880.001);
    expect(wide.y + 1e7 * wide.scale).toBeLessThanOrEqual(580.001);
    expect(fitGraphViewport({ minX: 0, minY: 0, maxX: 2, maxY: 2 }, 900, 600).scale).toBeCloseTo(100);
  });
  it('zooms smoothly below 5%, saturates finite shared limits, and preserves the world point under the cursor', () => {
    vi.mocked(SVGElement.prototype.getBoundingClientRect).mockReturnValue({ x: 0, y: 0, left: 0, top: 0,
      right: 900, bottom: 41, width: 900, height: 41, toJSON() {} });
    mount();
    const vp = () => transform()!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    const before = vp(); expect(before[2]).toBeLessThan(.05);
    fireEvent.wheel(canvas(), { deltaY: 100, clientX: 320, clientY: 20 });
    const after = vp(); expect(after[2]).toBeLessThan(before[2]);
    expect((320 - after[0]) / after[2]).toBeCloseTo((320 - before[0]) / before[2]);
    expect((20 - after[1]) / after[2]).toBeCloseTo((20 - before[1]) / before[2]);
    act(() => { for (let i = 0; i < 150; i++) fireEvent.wheel(canvas(), { deltaY: 100, clientX: 320, clientY: 20 }); });
    expect(vp()[2]).toBe(1e-5); expect(vp().every(Number.isFinite)).toBe(true);
    act(() => { for (let i = 0; i < 150; i++) fireEvent.wheel(canvas(), { deltaY: -100, clientX: 320, clientY: 20 }); });
    expect(vp()[2]).toBe(100); expect(vp().every(Number.isFinite)).toBe(true);
  });
});

describe('relationship paint controls', () => {
  it.each(['node', 'edge'])('fits a visible selected self-loop on the next resize with display off (%s)', selection => {
    let width = 900;
    vi.mocked(SVGElement.prototype.getBoundingClientRect).mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0,
      right: width, bottom: 600, width, height: 600, toJSON() {} }));
    mount({ ...graph, nodes: [graph.nodes[0]], edges: [{ ...graph.edges[2], id: 'loop', from: 'a', to: 'a' }] });
    control('Nodes', 'always-title');
    const initial = transform();
    fireEvent.click(node('a'));
    if (selection === 'edge') fireEvent.click(document.querySelector('[data-edge-id="loop"]')!);
    expect(transform()).toBe(initial); expect(toggle().checked).toBe(false);
    width = 700; fireEvent(window, new Event('resize'));
    const [x, y, scale] = transform()!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    const coords = document.querySelector('[data-edge-id="loop"] path')!.getAttribute('d')!
      .match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    for (let i = 0; i < coords.length; i += 2) {
      expect(x + coords[i] * scale).toBeGreaterThanOrEqual(19.999);
      expect(x + coords[i] * scale).toBeLessThanOrEqual(width - 19.999);
      expect(y + coords[i + 1] * scale).toBeGreaterThanOrEqual(19.999);
      expect(y + coords[i + 1] * scale).toBeLessThanOrEqual(580.001);
    }
    const selected = transform(); fireEvent.keyDown(canvas(), { key: 'Escape' });
    expect(edges()).toEqual([]); expect(transform()).toBe(selected);
    width = 900; fireEvent(window, new Event('resize')); expect(transform()).toBe(initial);
  });
  it('does not mount thousands of unrelated relationships in the off state or on node selection', () => {
    mount({ ...graph, edges: [...graph.edges, ...Array.from({ length: 2048 }, (_, i) =>
      ({ ...graph.edges[2], id: `hidden-${i}` }))] });
    expect(edges()).toEqual([]);
    fireEvent.click(node('b')); expect(edges()).toEqual(['ab', 'bc']);
    expect(document.querySelectorAll('[data-edge-id] path')).toHaveLength(2);
    fireEvent.click(node('b')); expect(edges()).toEqual([]);
  });
  it('mounts no edges by default, reveals only filtered incident edges, and never refits paint changes', () => {
    mount({ ...graph, edges: [...graph.edges, { ...graph.edges[0], id: 'composite', isDependency: true, isAtomic: false }] });
    expect(toggle().checked).toBe(false);
    expect(edges()).toEqual([]);
    expect((screen.getByRole('checkbox', { name: 'atomic deps only' }) as HTMLInputElement).checked).toBe(true);
    // Deliberately leave auto-fit before checking controls, not just initial transform equality.
    fireEvent.wheel(canvas(), { deltaY: 100, clientX: 320, clientY: 180 });
    const vp = transform(), anchors = positions();
    fireEvent.click(node('b')); expect(edges()).toEqual(['ab', 'bc']);
    fireEvent.click(toggle()); expect(edges()).toEqual(['ab', 'bc']);
    fireEvent.click(node('b')); expect(edges()).toEqual(['ab', 'bc', 'dd']);
    fireEvent.click(toggle()); expect(edges()).toEqual([]);
    fireEvent.click(node('b')); expect(edges()).toEqual(['ab', 'bc']);
    fireEvent.keyDown(node('b'), { key: 'Escape' }); expect(edges()).toEqual([]);
    fireEvent.click(node('b'));
    fireEvent.pointerDown(document.getElementById('snl-graph-background')!); expect(edges()).toEqual([]);
    expect(transform()).toBe(vp); expect(positions()).toEqual(anchors);
    fireEvent.click(node('b'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
    expect(edges()).toEqual(['ab', 'bc', 'composite']);
    expect(toggle().checked).toBe(false);
  });

  it('keeps selected-edge editing mutually exclusive, and clearing selection restores the off state', () => {
    mount(); fireEvent.click(node('b'));
    const edge = document.querySelector('[data-edge-id="ab"]')!;
    fireEvent.keyDown(edge, { key: 'Enter' }); expect(edges()).toEqual(['ab']);
    expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'editRelationship', id: 'ab' });
    expect(screen.queryByText('selected: b')).toBeNull();
    fireEvent.keyDown(edge, { key: 'Escape' }); expect(edges()).toEqual([]);
    fireEvent.click(toggle());
    fireEvent.click(document.querySelector('[data-edge-id="dd"]')!);
    fireEvent.click(toggle()); expect(edges()).toEqual([]);
    expect(screen.queryByRole('button', { name: /^Relationship / })).toBeNull();
    fireEvent.click(toggle()); expect(edges()).toEqual(['ab', 'bc', 'dd']);
  });

  it('retains panel visibility on refresh, resets on remount, and localizes the unchecked control', () => {
    const view = mount(); fireEvent.click(toggle()); send();
    expect(toggle().checked).toBe(true); expect(edges()).toHaveLength(3);
    view.unmount(); document.documentElement.lang = 'zh-CN'; mount();
    expect((screen.getByRole('checkbox', { name: '显示关系' }) as HTMLInputElement).checked).toBe(false);
    expect(edges()).toEqual([]); expect(api.setState).not.toHaveBeenCalled();
  });
});
