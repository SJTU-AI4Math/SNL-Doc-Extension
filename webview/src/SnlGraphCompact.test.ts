import { describe, expect, it } from 'vitest';
import { edgePath, fitGraphViewport, graphContentBounds, layout } from './SnlGraphApp';

const node = (id: string, packageId = 'logic', title = 'Wide title '.repeat(10)) => ({
  id, packageId, title, kind: 'Theorem', kindId: 'theorem', color: '#abc', background: '#123'
});
const edge = (from: string, to: string) => ({ id: `${from}-${to}`, from, to, label: 'depends', isDependency: true, isAtomic: true });
const center = (n: { x: number; y: number; w: number; h: number }) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
function assertSeparated(result: ReturnType<typeof layout>) {
  for (let i = 0; i < result.nodes.length; i++) for (const b of result.nodes.slice(i + 1)) {
    const a = result.nodes[i];
    expect(a.x + a.w + 11.99 <= b.x || b.x + b.w + 11.99 <= a.x ||
      a.y + a.h + 11.99 <= b.y || b.y + b.h + 11.99 <= a.y, `${a.id}/${b.id}`).toBe(true);
  }
}
function metrics(result: ReturnType<typeof layout>) {
  const p = result.radial!;
  const radii = result.nodes.map(n => { const c = center(n); return Math.hypot(c.x - p.centerX, c.y - p.centerY); });
  const width = Math.max(...result.nodes.map(n => n.x + n.w)) - Math.min(...result.nodes.map(n => n.x));
  const height = Math.max(...result.nodes.map(n => n.y + n.h)) - Math.min(...result.nodes.map(n => n.y));
  return { inner: Math.min(...radii), outer: Math.max(...radii), width, height,
    coverage: result.nodes.reduce((sum, n) => sum + n.w * n.h, 0) / (width * height) };
}

describe('compact static title-card occupancy', () => {
  it('does not collapse the whole graph when a fixed-screen package label cannot fit', () => {
    const bounds = { minX: 0, minY: 0, maxX: 320, maxY: 44 };
    const fitted = fitGraphViewport(bounds, 220, 500, [{ x: 160, y: -12, width: 320, centered: true }]);
    const contentOnly = fitGraphViewport(bounds, 220, 500);
    expect(fitted.scale).toBeCloseTo(contentOnly.scale, 6);
    expect(fitted.x).toBeCloseTo(contentOnly.x, 5);
    expect(fitted.y).toBeCloseTo(contentOnly.y, 5);
    expect(fitted.scale).toBeGreaterThan(0.5);
  });
  it.each(['radial-outward', 'radial-inward'] as const)('%s packs broad layers into ordered bands rather than empty circles', mode => {
    for (const [name, count, packages] of [['star', 100, 1], ['wide-star', 100, 1], ['binary', 600, 4]] as const) {
      const nodes = Array.from({ length: count }, (_, i) => node(`N${i}`, `P${i % packages}`, name === 'wide-star' ? 'Wide title '.repeat(10) : `Result ${i}`));
      const edges = nodes.slice(1).map((n, i) => edge(n.id, `N${name !== 'binary' ? 0 : Math.floor(i / 2)}`));
      const rectangle = layout(nodes, edges);
      const rings = layout(nodes, edges, mode, 'rings');
      const bands = layout(nodes, edges, mode);
      const before = metrics(rings), after = metrics(bands);
      console.info('packing-coverage', name, mode, { rings: before.coverage, bands: after.coverage, inner: after.inner, outer: after.outer });
      expect(after.coverage).toBeGreaterThan(before.coverage * 3);
      expect(after.coverage).toBeGreaterThan(0.09);
      assertSeparated(bands);
      assertSeparated(rings);
      // Strict rings remain selectable and genuinely use one radius per layer.
      const ringRows = new Map<number, number>();
      rectangle.nodes.forEach((n, i) => {
        const c = center(rings.nodes[i]), p = rings.radial!;
        const r = Math.hypot(c.x - p.centerX, c.y - p.centerY);
        if (ringRows.has(n.y)) expect(r).toBeCloseTo(ringRows.get(n.y)!, 7);
        ringRows.set(n.y, r);
      });
      expect(bands.nodes.map(n => n.id)).toEqual(rings.nodes.map(n => n.id));
      expect(bands.edges.map(({ waypoints, ...e }) => e)).toEqual(rings.edges.map(({ waypoints, ...e }) => e));
      const intervals = new Map<number, number[]>();
      const p = bands.radial!;
      rectangle.nodes.forEach((n, i) => {
        const c = center(bands.nodes[i]);
        const r = Math.hypot(c.x - p.centerX, c.y - p.centerY);
        const angle = p.startAngle + (center(n).x - p.xMin) / p.xSpan * p.sweep;
        expect((c.x - p.centerX) / r).toBeCloseTo(Math.cos(angle), 8);
        expect((c.y - p.centerY) / r).toBeCloseTo(Math.sin(angle), 8);
        const row = intervals.get(n.y) ?? []; row.push(r); intervals.set(n.y, row);
      });
      const ordered = [...intervals].sort((a, b) => mode === 'radial-inward' ? a[0] - b[0] : b[0] - a[0]).map(([, rs]) => rs);
      for (let i = 1; i < ordered.length; i++) expect(Math.min(...ordered[i])).toBeGreaterThan(Math.max(...ordered[i - 1]));
      expect(layout([...nodes].reverse(), [...edges].reverse(), mode)).toEqual(bands);
    }
  });
  it.each(['radial-outward', 'radial-inward'] as const)('%s routes intermediate points through the continuous per-layer x/radius projection', mode => {
    const nodes = Array.from({ length: 40 }, (_, i) => node(`n${i}`, `p${i % 3}`, `Result ${i}`));
    const edges = nodes.slice(1).map((n, i) => edge(n.id, nodes[Math.floor(i / 2)].id));
    edges.push(edge('n39', 'n0'));
    const flat = layout(nodes, edges), bands = layout(nodes, edges, mode), p = bands.radial!;
    const rows = new Map<number, Array<{ x: number; radius: number }>>();
    flat.nodes.forEach((n, i) => {
      const c = center(n), actual = center(bands.nodes[i]);
      const screen = Math.round((c.y - p.yMin) / 134);
      const layer = mode === 'radial-outward' ? p.maxLayer - screen : screen;
      const row = rows.get(layer) ?? [];
      row.push({ x: c.x, radius: Math.hypot(actual.x - p.centerX, actual.y - p.centerY) }); rows.set(layer, row);
    });
    for (const row of rows.values()) row.sort((a, b) => a.x - b.x);
    const atX = (layer: number, x: number) => {
      const row = rows.get(layer)!;
      const hi = row.findIndex(n => n.x >= x);
      if (hi === -1) return row[row.length - 1].radius;
      if (hi === 0) return row[0].radius;
      const a = row[hi - 1], b = row[hi];
      return a.radius + (x - a.x) / (b.x - a.x) * (b.radius - a.radius);
    };
    expect(flat.edges.reduce((sum, e) => sum + e.waypoints.length, 0)).toBeGreaterThan(0);
    flat.edges.forEach((e, i) => e.waypoints.forEach((point, j) => {
      const screen = (point.y - p.yMin) / 134;
      const layer = mode === 'radial-outward' ? p.maxLayer - screen : screen;
      const lo = Math.floor(layer), hi = Math.ceil(layer);
      const a = atX(lo, point.x), b = atX(hi, point.x);
      const r = a + (layer - lo) * (b - a);
      const angle = p.startAngle + (point.x - p.xMin) / p.xSpan * p.sweep;
      expect(bands.edges[i].waypoints[j].x).toBeCloseTo(p.centerX + r * Math.cos(angle), 7);
      expect(bands.edges[i].waypoints[j].y).toBeCloseTo(p.centerY + r * Math.sin(angle), 7);
    }));
  });
  it.each([['radial-inward', 'bands'], ['radial-outward', 'bands'], ['radial-inward', 'rings'], ['radial-outward', 'rings']] as const)('%s/%s fits the actual endpoint routes and all controls, ignoring dummy and decorative size', (mode, packing) => {
    const nodes = [node('a'), node('b', 'other'), node('c', 'third')];
    const result = layout(nodes, [edge('a', 'b'), edge('b', 'c'), edge('a', 'c'), edge('b', 'b')], mode, packing);
    const bounds = graphContentBounds(result);
    expect(graphContentBounds({ ...result, width: 1e9, height: 1e9 })).toEqual(bounds);
    expect(graphContentBounds({ ...result, edges: result.edges.map(e => ({ ...e, waypoints: [{ x: -1e9, y: 1e9 }] })) })).toEqual(bounds);
    const hull = { minX: Math.min(...result.nodes.map(n => n.x - 2)), minY: Math.min(...result.nodes.map(n => n.y - 2)),
      maxX: Math.max(...result.nodes.map(n => n.x + n.w + 2)), maxY: Math.max(...result.nodes.map(n => n.y + n.h + 2)) };
    const vp = fitGraphViewport(bounds, 700, 500);
    const dx = -3000, dy = 1700;
    const shifted = fitGraphViewport({ minX: bounds.minX + dx, minY: bounds.minY + dy,
      maxX: bounds.maxX + dx, maxY: bounds.maxY + dy }, 700, 500);
    expect(shifted.scale).toBe(vp.scale);
    expect(shifted.x + dx * vp.scale).toBeCloseTo(vp.x);
    expect(shifted.y + dy * vp.scale).toBeCloseTo(vp.y);
    for (const e of result.edges) {
      const d = edgePath(result.nodes.find(n => n.id === e.from)!, result.nodes.find(n => n.id === e.to)!, e.waypoints,
        { fromShape: 'title', toShape: 'title' }, result).d;
      const values = d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
      for (let i = 0; i < values.length; i += 2) {
        hull.minX = Math.min(hull.minX, values[i]); hull.maxX = Math.max(hull.maxX, values[i]);
        hull.minY = Math.min(hull.minY, values[i + 1]); hull.maxY = Math.max(hull.maxY, values[i + 1]);
        expect(vp.x + values[i] * vp.scale).toBeGreaterThanOrEqual(19.99);
        expect(vp.x + values[i] * vp.scale).toBeLessThanOrEqual(680.01);
        expect(vp.y + values[i + 1] * vp.scale).toBeGreaterThanOrEqual(19.99);
        expect(vp.y + values[i + 1] * vp.scale).toBeLessThanOrEqual(480.01);
      }
    }
    expect(bounds).toEqual(hull);
  });
  it('includes fixed-screen label extents without scaling the glyph allowance', () => {
    const bounds = { minX: -60, minY: -20, maxX: 60, maxY: 20 };
    const labels = [{ x: 60, y: -40, width: 180, centered: false }, { x: -60, y: 40, width: 90, centered: true }];
    const vp = fitGraphViewport(bounds, 500, 300, labels);
    expect(vp.scale).toBeGreaterThan(1);
    for (const label of labels) {
      const left = vp.x + label.x * vp.scale - (label.centered ? label.width / 2 : 0);
      expect(left).toBeGreaterThanOrEqual(19.99);
      expect(left + label.width).toBeLessThanOrEqual(480.01);
      expect(vp.y + label.y * vp.scale - 14).toBeGreaterThanOrEqual(19.99);
      expect(vp.y + label.y * vp.scale + 4).toBeLessThanOrEqual(280.01);
    }
  });
  it.each(['radial-outward', 'radial-inward'] as const)('%s packs vertical wide-card chains by height, not their circumscribed diameter', mode => {
    const nodes = Array.from({ length: 16 }, (_, i) => node(String(i).padStart(2, '0')));
    const result = layout(nodes, nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)), mode);
    const m = metrics(result);
    console.info('compact-chain', mode, m);
    expect(m.inner).toBeLessThanOrEqual(32);
    expect(m.outer - m.inner).toBeLessThanOrEqual(16 * 60);
    expect(m.coverage).toBeGreaterThan(0.7);
    assertSeparated(result);
  });
  it.each(['radial-outward', 'radial-inward'] as const)('%s does not inflate sparse multi-package layers to fit decorative wedges', mode => {
    const nodes = Array.from({ length: 16 }, (_, i) => node(String(i).padStart(2, '0'), `package-${i}`));
    const result = layout(nodes, nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)), mode);
    const m = metrics(result);
    console.info('compact-packages', mode, m);
    expect(m.inner).toBeLessThanOrEqual(32);
    expect(m.outer).toBeLessThan(2000);
    assertSeparated(result);
    expect(result.clusters).toHaveLength(16);
  });
  it('does not impose the outer growth layer density on a singleton foundation', () => {
    const base = node('base');
    const growth = Array.from({ length: 100 }, (_, i) => node(`growth-${i}`));
    const result = layout([base, ...growth], growth.map(n => edge(n.id, base.id)), 'radial-outward');
    console.info('compact-growth', metrics(result));
    expect(result.radial!.innerRadius).toBeLessThanOrEqual(32);
    assertSeparated(result);
  });
  it('keeps varied static fixtures separated without depending on storage order', () => {
    let seed = 0x51a7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let fixture = 0; fixture < 12; fixture++) {
      const nodes = Array.from({ length: 70 }, (_, i) => node(`n${i}`, `p${Math.floor(random() * 9)}`, 'x'.repeat(1 + Math.floor(random() * 60))));
      const edges = nodes.slice(1).map((n, i) => edge(n.id, nodes[Math.floor(random() * (i + 1))].id));
      for (const mode of ['radial-outward', 'radial-inward'] as const) {
        const result = layout(nodes, edges, mode);
        assertSeparated(result);
        expect(layout([...nodes].reverse(), [...edges].reverse(), mode)).toEqual(result);
      }
    }
  });
  it('lays out a 1500-card layered graph in one bounded static calculation', () => {
    const nodes = Array.from({ length: 1500 }, (_, i) => node(`n${String(i).padStart(4, '0')}`, `p${i % 5}`, 'Title '.repeat(i % 8 + 1)));
    const edges = nodes.slice(30).map((n, i) => edge(n.id, nodes[i].id));
    const start = performance.now();
    const result = layout(nodes, edges, 'radial-outward');
    console.info('static-1500 elapsed-ms', performance.now() - start);
    expect(result.nodes).toHaveLength(1500);
    expect(result.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });
  it.each(['radial-inward', 'radial-outward'] as const)('%s separates varied widths, multiple dense rings and the seam', mode => {
    const nodes = Array.from({ length: 180 }, (_, i) => node(`n${String(i).padStart(3, '0')}`, `p${i % 7}`, 'x'.repeat(2 + (i * 13) % 50)));
    const edges = nodes.slice(30).map((n, i) => edge(n.id, nodes[i].id));
    assertSeparated(layout(nodes, edges, mode));
  });
});
