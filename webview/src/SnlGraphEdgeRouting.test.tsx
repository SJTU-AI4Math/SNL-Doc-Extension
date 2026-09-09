import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgePath, SnlGraphApp } from './SnlGraphApp';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async original => ({
  ...(await original<typeof import('./vscodeApi')>()),
  useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Routing', warnings: [],
  nodes: ['a', 'b', 'c'].map((id, i) => ({ id, packageId: `package-${i}`, title: id.toUpperCase(),
    kind: 'Theorem', kindId: 'theorem', coloring: null })),
  edges: [['ab', 'a', 'b'], ['bc', 'b', 'c'], ['ca', 'c', 'a'], ['aa', 'a', 'a']].map(([id, from, to]) =>
    ({ id, from, to, label: id, isDependency: true, isAtomic: true }))
};
const control = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const values = (s: string) => s.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
function anchor(id: string) {
  const n = document.querySelector(`[data-node-id="${id}"]`)!;
  const [x, y, scale] = values(n.getAttribute('transform')!);
  const rect = n.querySelector('rect')!;
  return { x, y, w: Number(rect.getAttribute('width')) * scale, h: Number(rect.getAttribute('height')) * scale,
    cornerRadius: Number(rect.getAttribute('rx')) * scale };
}
beforeEach(() => {
  document.documentElement.lang = 'en'; api.postMessage.mockReset();
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 600,
    width: 900, height: 600, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.lang = ''; });

describe('rendered endpoint routes', () => {
  it.each(['bands', 'rings'])('%s passes the actual center, preserves arrows/backedges/identity and edge editing', packing => {
    render(<SnlGraphApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: graph })));
    control('Nodes', 'always-title');
    fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    control('Layer packing', packing);
    for (const mode of ['rectangle', 'radial-outward', 'radial-inward']) {
      control('Layout', mode);
      const viewport = document.querySelector('[data-graph-viewport]')!, svg = viewport.closest('svg')!;
      const origin = JSON.parse(svg.getAttribute('data-radial-center') ?? 'null') as { x: number; y: number } | null;
      expect(Boolean(origin)).toBe(mode !== 'rectangle');
      const context = origin ? { radial: { centerX: origin.x, centerY: origin.y } } : undefined;
      expect([...document.querySelectorAll('[data-node-id]')].map(n => n.getAttribute('data-node-id')).sort()).toEqual(['a', 'b', 'c']);
      expect(document.querySelectorAll('[data-edge-id]')).toHaveLength(graph.edges.length);
      expect(document.querySelectorAll('[data-package-label]')).toHaveLength(graph.nodes.length);
      const bounds = JSON.parse(viewport.getAttribute('data-content-bounds')!);
      for (const e of graph.edges) {
        const group = document.querySelector(`[data-edge-id="${e.id}"]`)!;
        const path = group.querySelector('path')!;
        expect([group.getAttribute('data-from'), group.getAttribute('data-to')]).toEqual([e.from, e.to]);
        expect(path.getAttribute('marker-end')).toBe('url(#snl-graph-arrow)');
        expect(path.getAttribute('stroke-dasharray')).toBe(e.id === 'ca' || e.id === 'aa' ? '5 4' : null);
        const d = edgePath(anchor(e.from), anchor(e.to), [{ x: -1e9, y: 1e9 }], { fromShape: 'title', toShape: 'title' }, context).d;
        expect(path.getAttribute('d')).toBe(d);
        const controls = values(d);
        if (origin && e.from !== e.to) {
          const a = anchor(e.from), b = anchor(e.to);
          const ra = [a.x + a.w / 2 - origin.x, a.y + a.h / 2 - origin.y];
          const rb = [b.x + b.w / 2 - origin.x, b.y + b.h / 2 - origin.y];
          const sign = Math.sign(Math.hypot(...rb) - Math.hypot(...ra));
          if (Math.abs(Math.hypot(...rb) - Math.hypot(...ra)) > 1e-8) {
            const end = controls.length - 2;
            expect(sign * ((controls[0] - a.x - a.w / 2) * ra[0] + (controls[1] - a.y - a.h / 2) * ra[1])).toBeGreaterThan(0);
            expect(sign * ((controls[end] - b.x - b.w / 2) * rb[0] + (controls[end + 1] - b.y - b.h / 2) * rb[1])).toBeLessThan(0);
            expect(sign * ((controls[2] - controls[0]) * ra[0] + (controls[3] - controls[1]) * ra[1])).toBeGreaterThan(0);
            expect(sign * ((controls[end] - controls[end - 2]) * rb[0] + (controls[end + 1] - controls[end - 1]) * rb[1])).toBeGreaterThan(0);
          }
        }
        for (let i = 0; i < controls.length; i += 2) {
          expect(controls[i]).toBeGreaterThanOrEqual(bounds.minX - 1e-6);
          expect(controls[i]).toBeLessThanOrEqual(bounds.maxX + 1e-6);
          expect(controls[i + 1]).toBeGreaterThanOrEqual(bounds.minY - 1e-6);
          expect(controls[i + 1]).toBeLessThanOrEqual(bounds.maxY + 1e-6);
        }
        fireEvent.click(group);
        expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'editRelationship', id: e.id });
        fireEvent.keyDown(group, { key: 'Enter' });
        expect(api.postMessage).toHaveBeenLastCalledWith({ type: 'editRelationship', id: e.id });
      }
      const oldTransform = viewport.getAttribute('transform');
      const positions = [...document.querySelectorAll('[data-node-id]')].map(n => n.getAttribute('transform'));
      const edge = document.querySelector('[data-edge-id="ab"]')!;
      fireEvent.pointerEnter(edge);
      expect(edge.querySelector('path')!.getAttribute('stroke-width')).toBe('2');
      fireEvent.pointerLeave(edge);
      expect(viewport.getAttribute('transform')).toBe(oldTransform);
      expect([...document.querySelectorAll('[data-node-id]')].map(n => n.getAttribute('transform'))).toEqual(positions);
    }
  });
});
