import { describe, expect, it } from 'vitest';
import { fitGraphViewport, layout } from './SnlGraphApp';

const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, packageId: `package-${Math.floor(i / 3)}`, title: `Node ${i}`, kind: 'Theorem', kindId: 'theorem', color: '#abc', background: '#123' }));
const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, from: n.id, to: nodes[i % 3].id, label: 'depends', isDependency: true, isAtomic: true }));
const modes = ['radial-inward', 'radial-outward'] as const;
const packings = ['bands', 'rings'] as const;

describe('outward Package label geometry', () => {
  for (const mode of modes) for (const packing of packings) {
    it(`${mode}/${packing} anchors at the actual outer arc on the sector bisector`, () => {
      const laid = layout(nodes, edges, mode, packing), origin = laid.radial!;
      for (const cluster of laid.clusters) {
        const sector = cluster.sector!;
        const outerRadius = Number(sector.path.split(' A ')[1].split(' ')[0]);
        const angle = (sector.startAngle + sector.endAngle) / 2;
        expect(sector.labelX).toBeCloseTo(origin.centerX + outerRadius * Math.cos(angle), 9);
        expect(sector.labelY).toBeCloseTo(origin.centerY + outerRadius * Math.sin(angle), 9);
        expect(Math.hypot(sector.labelX - origin.centerX, sector.labelY - origin.centerY)).toBeCloseTo(outerRadius, 9);
      }
    });
  }
  for (const height of [undefined, 40]) it.each([0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI, -3 * Math.PI / 4, -Math.PI / 2, -Math.PI / 4])(`fits horizontal outward extents (height ${height ?? 'fallback'}) at angle %s without scaling twice`, angle => {
    const width = 240, bounds = { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    const label = { x: 100 * Math.cos(angle), y: 100 * Math.sin(angle), width, height, centered: false, angle };
    const vp = fitGraphViewport(bounds, 440, 420, [label]);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const left = Math.abs(cos) < 1e-10 ? -width / 2 : cos < 0 ? -width : 0;
    const h = height ?? 18;
    const top = Math.abs(sin) < 1e-10 ? -h / 2 : sin < 0 ? -h : 0;
    const corners = [left, left + width].flatMap(x => [top, top + h].map(y => {
      expect(x * cos + y * sin).toBeGreaterThanOrEqual(-1e-9);
      return { x: vp.x + label.x * vp.scale + x, y: vp.y + label.y * vp.scale + y };
    }));
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(corner.x).toBeLessThanOrEqual(420 + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(corner.y).toBeLessThanOrEqual(400 + 1e-6);
    }
    const contentCorners = [-100, 100].flatMap(x => [-100, 100].map(y => ({ x: vp.x + x * vp.scale, y: vp.y + y * vp.scale })));
    const all = [...corners, ...contentCorners];
    const spanX = Math.max(...all.map(p => p.x)) - Math.min(...all.map(p => p.x));
    const spanY = Math.max(...all.map(p => p.y)) - Math.min(...all.map(p => p.y));
    expect(Math.max(spanX / 400, spanY / 380)).toBeCloseTo(1, 6);
  });
  it('retains rectangle label bounds and the no-positive-fit fallback', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const vp = fitGraphViewport(bounds, 440, 440, [{ x: 100, y: 100, width: 100, centered: false }]);
    expect(vp.scale).toBeCloseTo(3, 6);
    expect(vp.x).toBeCloseTo(20, 5); // 28-step fit search has sub-micro-pixel rounding.
    expect(fitGraphViewport(bounds, 200, 100, [{ x: 100, y: 100, width: 500, centered: false, angle: Math.PI / 2 }])).toEqual(fitGraphViewport(bounds, 200, 100));
    expect(layout(nodes, edges).clusters.every(c => !c.sector)).toBe(true);
  });
});
