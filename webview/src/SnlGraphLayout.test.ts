import { describe, expect, it } from 'vitest';
import { graphNodePresentation, layout } from './SnlGraphApp';

const node = (id: string, packageId = 'logic', title = id) => ({
  id, packageId, title, kind: 'Theorem', kindId: 'theorem', color: '#abc', background: '#123'
});
const edge = (id: string, from: string, to: string, isDependency = true) => ({
  id, from, to, label: 'depends', isDependency, isAtomic: true
});
const nodes = [node('a'), node('b'), node('c', 'other'), node('d', 'other')];
const edges = [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bd', 'b', 'd', false)];
const center = (n: { x: number; y: number; w: number; h: number }) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

describe('static graph layouts', () => {
  it('keeps overview dots visible and active cards readable without moving centers', () => {
    const n = { x: 40, y: 50, w: 160, h: 44 };
    const dot = graphNodePresentation(n, 0.01, false);
    expect(dot.dotRadius * 0.01).toBeGreaterThanOrEqual(2);
    const card = graphNodePresentation(n, 0.01, true);
    expect(card.presentationScale * 0.01).toBe(1);
    expect(center(card)).toEqual(center(n));
    expect(card.w * 0.01).toBe(n.w);
    expect(graphNodePresentation(n, 2, true).presentationScale).toBe(1);
  });
  it('characterizes sink-zero heights, mixed relations and deterministic rectangular lanes', () => {
    const result = layout(nodes, edges);
    const byId = new Map(result.nodes.map(n => [n.id, n]));
    expect(byId.get('a')!.y).toBeLessThan(byId.get('b')!.y);
    expect(byId.get('b')!.y).toBeLessThan(byId.get('d')!.y);
    expect(byId.get('c')!.y).toBe(byId.get('d')!.y);
    expect(result.clusters.map(c => c.packageId)).toEqual(['logic', 'other']);
    expect(layout([...nodes].reverse(), [...edges].reverse())).toEqual(result);
  });

  it.each(['radial-outward', 'radial-inward'] as const)('%s projects the same global x order and reversed screen y, including waypoints and package sectors', mode => {
    const rectangle = layout(nodes, edges);
    const radial = layout(nodes, edges, mode, 'rings');
    expect(radial.nodes).not.toEqual(rectangle.nodes);
    const p = radial.radial!;
    expect(p.innerRadius).toBeGreaterThan(0);
    expect(p.sweep).toBeLessThan(2 * Math.PI);
    const radius = (id: string) => {
      const c = center(radial.nodes.find(n => n.id === id)!);
      return Math.hypot(c.x - p.centerX, c.y - p.centerY);
    };
    if (mode === 'radial-outward') {
      expect(radius('a')).toBeGreaterThan(radius('b'));
      expect(radius('b')).toBeGreaterThan(radius('d'));
    } else {
      expect(radius('a')).toBeLessThan(radius('b'));
      expect(radius('b')).toBeLessThan(radius('d'));
    }
    expect(radius('c')).toBeCloseTo(radius('d'));
    const project = (point: { x: number; y: number }) => {
      const angle = p.startAngle + (point.x - p.xMin) / p.xSpan * p.sweep;
      const screenLayer = (point.y - p.yMin) / 134;
      const layer = mode === 'radial-outward' ? p.maxLayer - screenLayer : screenLayer;
      const lo = Math.floor(layer), hi = Math.ceil(layer);
      const r = p.layerRadii[lo] + (layer - lo) * (p.layerRadii[hi] - p.layerRadii[lo]);
      return { x: p.centerX + r * Math.cos(angle), y: p.centerY + r * Math.sin(angle) };
    };
    for (const n of rectangle.nodes) {
      const actual = center(radial.nodes.find(r => r.id === n.id)!);
      expect(actual.x).toBeCloseTo(project(center(n)).x);
      expect(actual.y).toBeCloseTo(project(center(n)).y);
    }
    for (const e of rectangle.edges) {
      const actual = radial.edges.find(r => r.id === e.id)!;
      expect(actual).toMatchObject({ from: e.from, to: e.to, isBack: e.isBack });
      expect(actual.waypoints).toEqual(e.waypoints.map(project));
    }
    expect(radial.clusters.map(c => [c.packageId, c.nodeCount])).toEqual(rectangle.clusters.map(c => [c.packageId, c.nodeCount]));
    for (const c of radial.clusters) {
      expect(c.sector!.path).toMatch(/^M .* A .* L .* A .* Z$/);
      expect(c.sector!.endAngle).toBeGreaterThan(c.sector!.startAngle);
    }
    expect(layout([...nodes].reverse(), [...edges].reverse(), mode, 'rings')).toEqual(radial);
  });

  it.each(['rectangle', 'radial-outward', 'radial-inward'] as const)('%s handles empty, self-loop, cycle and multi-node single-layer graphs deterministically', mode => {
    expect(layout([], [], mode)).toMatchObject({ nodes: [], edges: [], clusters: [], width: 0, height: 0 });
    const cycle = [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('aa', 'a', 'a')];
    const result = layout(nodes.slice(0, 2), cycle, mode);
    expect(result.edges.filter(e => e.isBack).map(e => e.id)).toEqual(['aa', 'ba']);
    expect(result.edges.map(e => [e.from, e.to])).toEqual([['a', 'a'], ['a', 'b'], ['b', 'a']]);
    expect(layout(nodes.slice(0, 2).reverse(), cycle.slice().reverse(), mode)).toEqual(result);
    const wide = Array.from({ length: 12 }, (_, i) => node(String(i), i < 6 ? 'a' : 'b', 'Long upright title '.repeat(4)));
    const ring = layout(wide, [], mode);
    for (let i = 0; i < ring.nodes.length; i++) {
      const a = ring.nodes[i];
      for (const b of ring.nodes.slice(i + 1)) {
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
      expect([a.x, a.y, a.w, a.h].every(Number.isFinite)).toBe(true);
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w).toBeLessThanOrEqual(ring.width);
      expect(a.y + a.h).toBeLessThanOrEqual(ring.height);
    }
  });

  it.each(['radial-outward', 'radial-inward'] as const)('%s preserves center membership in narrow decorative package sectors without disc containment', mode => {
    const chain = Array.from({ length: 16 }, (_, i) => node(String(i).padStart(2, '0'), `package-${i}`, 'Wide title '.repeat(10)));
    const result = layout(chain, chain.slice(1).map((n, i) => edge(String(i), chain[i].id, n.id)), mode);
    const p = result.radial!;
    for (const n of result.nodes) {
      const sector = result.clusters.find(c => c.packageId === n.packageId)!.sector!;
      const { x, y } = center(n);
      let a = Math.atan2(y - p.centerY, x - p.centerX);
      while (a < p.startAngle) a += 2 * Math.PI;
      expect(a).toBeGreaterThanOrEqual(sector.startAngle);
      expect(a).toBeLessThanOrEqual(sector.endAngle);
    }
  });
});
