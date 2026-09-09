import { describe, expect, it } from 'vitest';
import { edgePath } from './SnlGraphApp';

describe('facing radial ports with overlapping radial extents', () => {
  it('does not take a diameter shortcut for disjoint antipodal cards', () => {
    // Distinct radii, but radial projections overlap. The actual rectangles
    // are disjoint: a.x=20..180 and b.x=-200..-40. This is not a self-loop.
    const a = { x: 20, y: -22, w: 160, h: 44 };
    const b = { x: -200, y: -22, w: 160, h: 44 };
    const result = edgePath(a, b, [], { fromShape: 'title', toShape: 'title' }, { radial: { centerX: 0, centerY: 0 } });
    const values = result.d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    // Endpoints must still be inner outward port / outer inward port.
    expect(values[0]).toBeCloseTo(180);
    expect(values.at(-2)).toBeCloseTo(-40);
    // A path with every control on the diameter necessarily crosses origin;
    // signed ports do not permit replacing the orbital short side by a chord.
    expect(Math.max(...values.filter((_, i) => i % 2 === 1).map(Math.abs))).toBeGreaterThan(1);
    let x = values[0], y = values[1], angle = 0, totalTurn = 0;
    for (let i = 2; i < values.length; i += 6) {
      for (let j = 1; j <= 100; j++) {
        const t = j / 100, s = 1 - t;
        const px = s ** 3 * x + 3 * s ** 2 * t * values[i] + 3 * s * t ** 2 * values[i + 2] + t ** 3 * values[i + 4];
        const py = s ** 3 * y + 3 * s ** 2 * t * values[i + 1] + 3 * s * t ** 2 * values[i + 3] + t ** 3 * values[i + 5];
        expect(Math.hypot(px, py)).toBeGreaterThan(10);
        const next = Math.atan2(py, px);
        const delta = Math.atan2(Math.sin(next - angle), Math.cos(next - angle));
        expect(delta).toBeGreaterThanOrEqual(-1e-8);
        totalTurn += Math.abs(delta); angle = next;
      }
      x = values[i + 4]; y = values[i + 5];
    }
    expect(totalTurn).toBeCloseTo(Math.PI, 6);
  });
});
