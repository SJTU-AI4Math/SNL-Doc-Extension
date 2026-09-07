import { describe, expect, it } from 'vitest';
import { edgePath } from './SnlGraphApp';

interface Cubic {
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  end: { x: number; y: number };
}

function cubics(d: string): Cubic[] {
  return [...d.matchAll(/C\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?),\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?),\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
    .map((match) => ({
      c1: { x: Number(match[1]), y: Number(match[2]) },
      c2: { x: Number(match[3]), y: Number(match[4]) },
      end: { x: Number(match[5]), y: Number(match[6]) }
    }));
}

const node = (x: number, y: number, w = 100, h = 44) => ({ x, y, w, h });

describe('graph edge path geometry', () => {
  it('terminates on the actual dot/card boundary in arbitrary radial directions', () => {
    const from = node(0, 0, 100, 44), to = node(200, 0, 100, 44);
    const dots = edgePath(from, to, [], { fromShape: 'dot', toShape: 'dot' });
    expect(dots.d).toMatch(/^M 56 22 /);
    expect(cubics(dots.d).at(-1)?.end).toEqual({ x: 244, y: 22 });
    const mixed = edgePath(from, to, [], { fromShape: 'title', toShape: 'dot' });
    expect(mixed.d).toMatch(/^M 100 22 /);
    expect(cubics(mixed.d).at(-1)?.end).toEqual({ x: 244, y: 22 });
    const reverse = edgePath(to, from, [], { fromShape: 'title', toShape: 'title' });
    expect(reverse.d).toMatch(/^M 200 22 /);
    expect(cubics(reverse.d).at(-1)?.end).toEqual({ x: 100, y: 22 });
    const rounded = edgePath(from, node(200, 88), [], { fromShape: 'title', toShape: 'title' });
    const [x, y] = rounded.d.slice(2).split(' ').map(Number);
    expect(x).toBeLessThan(100);
    expect(y).toBeLessThan(44);
    expect(Math.hypot(x - 96, y - 40)).toBeCloseTo(4);
  });

  it.each(['dot', 'title'] as const)('draws a visible self-loop outside the %s with distinct boundary ports', shape => {
    const n = node(10, 20);
    const path = edgePath(n, n, [], { fromShape: shape, toShape: shape });
    const [x, y] = path.d.slice(2).split(' ').map(Number);
    const curves = cubics(path.d);
    expect(curves.at(-1)?.end).not.toEqual({ x, y });
    expect(curves.some(c => c.c1.x > n.x + n.w || c.c2.x > n.x + n.w)).toBe(true);
    expect(curves.some(c => c.c1.y < n.y || c.c2.y < n.y)).toBe(true);
    expect(path.d).not.toMatch(/NaN|Infinity/);
  });

  it('keeps vertical tangents only at the source and target anchors', () => {
    const start = node(0, 0);
    const end = node(200, 320);
    const waypoints = [{ x: 140, y: 140 }, { x: 80, y: 230 }];
    const path = edgePath(start, end, waypoints);
    const curves = cubics(path.d);

    expect(curves).toHaveLength(3);
    const source = { x: 50, y: 44 };
    const target = { x: 250, y: 320 };

    // Endpoint controls share the anchor x: only the head and tail are vertical.
    expect(curves[0].c1.x).toBe(source.x);
    expect(curves.at(-1)?.c2.x).toBe(target.x);

    // At each interior waypoint, incoming and outgoing controls form one
    // continuous non-vertical tangent instead of two vertical half-segments.
    for (let index = 0; index < waypoints.length; index += 1) {
      const waypoint = waypoints[index];
      const incoming = curves[index];
      const outgoing = curves[index + 1];
      expect(incoming.end).toEqual(waypoint);
      expect(incoming.c2.x).not.toBe(waypoint.x);
      expect(outgoing.c1.x).not.toBe(waypoint.x);
      expect(waypoint.x - incoming.c2.x).toBeCloseTo(outgoing.c1.x - waypoint.x, 8);
      expect(waypoint.y - incoming.c2.y).toBeCloseTo(outgoing.c1.y - waypoint.y, 8);
    }

    expect(curves.at(-1)?.end).toEqual(target);
    expect(path.d).not.toMatch(/[LV]/);
  });

  it('keeps both endpoint tangents vertical for a short edge', () => {
    const path = edgePath(node(20, 10), node(180, 180), []);
    const [curve] = cubics(path.d);
    expect(curve.c1.x).toBe(70);
    expect(curve.c2.x).toBe(230);
    expect(curve.end).toEqual({ x: 230, y: 180 });
  });

  it('keeps the endpoint contract for reverse and intrinsically vertical edges', () => {
    const reverse = cubics(edgePath(
      node(20, 300),
      node(220, 10),
      [{ x: 100, y: 220 }, { x: 190, y: 120 }]
    ).d);
    expect(reverse[0].c1.x).toBe(70);
    expect(reverse.at(-1)?.c2.x).toBe(270);
    expect(reverse[0].c2.x).not.toBe(100);
    expect(reverse[1].c1.x).not.toBe(100);

    // When both anchors genuinely share an x-coordinate, a vertical edge is
    // intrinsic geometry rather than an artificial waypoint kink.
    const [aligned] = cubics(edgePath(node(20, 10), node(20, 180), []).d);
    expect(aligned.c1.x).toBe(70);
    expect(aligned.c2.x).toBe(70);
  });
});
