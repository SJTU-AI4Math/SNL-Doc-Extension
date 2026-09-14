import { describe, expect, it } from 'vitest';
import { edgePath, graphNodePresentation } from './SnlGraphApp';

type Point = { x: number; y: number };
type Cubic = { start: Point; c1: Point; c2: Point; end: Point };
function cubics(d: string): Cubic[] {
  const values = d.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  let start = { x: values[0], y: values[1] };
  const curves: Cubic[] = [];
  for (let i = 2; i < values.length; i += 6) {
    const end = { x: values[i + 4], y: values[i + 5] };
    curves.push({ start, c1: { x: values[i], y: values[i + 1] }, c2: { x: values[i + 2], y: values[i + 3] }, end });
    start = end;
  }
  return curves;
}
const node = (x: number, y: number, w = 100, h = 44) => ({ x, y, w, h });
const center = (n: ReturnType<typeof node>) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
const sub = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const length = (a: Point) => Math.hypot(a.x, a.y);
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const shapes = { fromShape: 'title', toShape: 'title' } as const;
const junk = [{ x: -9000, y: 17000 }, { x: NaN, y: Infinity }];
function expectPoint(a: Point, b: Point) { expect(a.x).toBeCloseTo(b.x, 7); expect(a.y).toBeCloseTo(b.y, 7); }
function expectReverse(forward: string, backward: string) {
  const a = cubics(forward), b = cubics(backward).reverse();
  expect(a).toHaveLength(b.length);
  a.forEach((c, i) => {
    expectPoint(c.start, b[i].end); expectPoint(c.c1, b[i].c2);
    expectPoint(c.c2, b[i].c1); expectPoint(c.end, b[i].start);
  });
}
function at(c: Cubic, t: number): Point {
  const s = 1 - t;
  return { x: s ** 3 * c.start.x + 3 * s ** 2 * t * c.c1.x + 3 * s * t ** 2 * c.c2.x + t ** 3 * c.end.x,
    y: s ** 3 * c.start.y + 3 * s ** 2 * t * c.c1.y + 3 * s * t ** 2 * c.c2.y + t ** 3 * c.end.y };
}
function derivative(c: Cubic, t: number): Point {
  const s = 1 - t;
  return { x: 3 * (s * s * (c.c1.x - c.start.x) + 2 * s * t * (c.c2.x - c.c1.x) + t * t * (c.end.x - c.c2.x)),
    y: 3 * (s * s * (c.c1.y - c.start.y) + 2 * s * t * (c.c2.y - c.c1.y) + t * t * (c.end.y - c.c2.y)) };
}

const origin = { x: -130, y: 270 };
const context = { radial: { centerX: origin.x, centerY: origin.y } };
const polarNode = (angle: number, radius: number) => node(origin.x + radius * Math.cos(angle) - 50, origin.y + radius * Math.sin(angle) - 22);
const shortAngle = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function assertRadialRoute(a: ReturnType<typeof node>, b: ReturnType<typeof node>, style = shapes as { fromShape: 'title' | 'dot'; toShape: 'title' | 'dot' }) {
  const path = edgePath(a, b, junk, style, context);
  expect(path).toEqual(edgePath(a, b, [], style, context));
  expect(path.d).not.toMatch(/NaN|Infinity/);
  const curves = cubics(path.d), first = curves[0], last = curves.at(-1)!;
  const ra = sub(center(a), origin), rb = sub(center(b), origin);
  const da = derivative(first, 0), db = derivative(last, 1);
  expect(Math.abs(cross(da, ra)) / length(da) / length(ra)).toBeLessThan(1e-8);
  expect(Math.abs(cross(db, rb)) / length(db) / length(rb)).toBeLessThan(1e-8);
  if (Math.abs(length(ra) - length(rb)) > 1e-8) {
    const sign = length(rb) > length(ra) ? 1 : -1;
    expect(dot(sub(first.start, center(a)), ra) * sign).toBeGreaterThan(0);
    expect(dot(sub(last.end, center(b)), rb) * sign).toBeLessThan(0);
    expect(dot(da, ra) * sign).toBeGreaterThan(0);
    expect(dot(db, rb) * sign).toBeGreaterThan(0);
  }
  expectReverse(path.d, edgePath(b, a, [], { fromShape: style.toShape, toShape: style.fromShape }, context).d);
  // Crossed facing radii from enlarged/nearby cards are a signed-endpoint
  // fallback, not the normal annular transition contract.
  const outward = length(rb) > length(ra);
  const innerPort = outward ? first.start : last.end, outerPort = outward ? last.end : first.start;
  const innerRay = outward ? ra : rb, outerRay = outward ? rb : ra;
  const innerRadius = dot(sub(innerPort, origin), innerRay) / length(innerRay);
  const outerRadius = dot(sub(outerPort, origin), outerRay) / length(outerRay);
  if (Math.abs(length(ra) - length(rb)) > 1e-8 && outerRadius <= innerRadius + 1e-8) return curves;
  let previous = Math.atan2(first.start.y - origin.y, first.start.x - origin.x), sweep = 0;
  const expected = Math.abs(shortAngle(Math.atan2(ra.y, ra.x), Math.atan2(rb.y, rb.x)));
  let turning = false;
  const minRadius = Math.min(length(sub(first.start, origin)), length(sub(last.end, origin)));
  for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    if (i) {
      const incoming = derivative(curves[i - 1], 1), outgoing = derivative(c, 0);
      expect(Math.abs(cross(incoming, outgoing)) / length(incoming) / length(outgoing)).toBeLessThan(1e-8);
      expect(dot(incoming, outgoing)).toBeGreaterThan(0);
    }
    for (let j = 0; j <= 40; j++) {
      const t = j / 40, r = sub(at(c, t), origin), v = derivative(c, t);
      expect(length(v)).toBeGreaterThan(1e-9);
      expect(length(r)).toBeGreaterThanOrEqual(minRadius - 1e-6);
      if (Math.abs(length(ra) - length(rb)) > 1e-8) expect(length(r)).toBeLessThanOrEqual(outerRadius + 1e-6);
      const angle = Math.atan2(r.y, r.x), delta = shortAngle(previous, angle);
      sweep += Math.abs(delta); previous = angle;
      if (Math.abs(dot(r, v)) / length(r) / length(v) < 0.02) turning = true;
    }
  }
  expect(sweep).toBeCloseTo(expected, 6);
  expect(sweep).toBeLessThanOrEqual(Math.PI + 1e-8);
  expect(turning).toBe(true);
  // Route label anchor lies on the orbit, not in the empty center.
  expect(length(sub({ x: path.midX, y: path.midY }, origin))).toBeGreaterThanOrEqual(minRadius - 1e-6);
  return curves;
}

describe('endpoint-only radial edge paths', () => {
  it('uses exact facing ports and signed travel on translated, rotated, enlarged cards and dots', () => {
    for (const angle of [0, 0.35, 1.2, -2.6]) for (const scale of [1, 0.25]) {
      const a = graphNodePresentation(polarNode(angle, 300), scale, true);
      const b = graphNodePresentation(polarNode(angle + 0.6, 1000), scale, true);
      for (const shape of ['dot', 'title'] as const) {
        const cs = assertRadialRoute(a, b, { fromShape: shape, toShape: shape });
        for (const [n, p, sign] of [[a, cs[0].start, 1], [b, cs.at(-1)!.end, -1]] as const) {
          const r = sub(center(n), origin), u = { x: r.x / length(r), y: r.y / length(r) };
          // Independent rounded-box membership/bisection oracle, including
          // corners; do not reuse the production ray-intersection formula.
          let lo = 0, hi = Math.hypot(n.w, n.h);
          for (let i = 0; i < 60; i++) {
            const d = (lo + hi) / 2;
            const qx = Math.max(0, Math.abs(u.x * d) - n.w / 2 + n.cornerRadius);
            const qy = Math.max(0, Math.abs(u.y * d) - n.h / 2 + n.cornerRadius);
            if (Math.hypot(qx, qy) <= n.cornerRadius) lo = d; else hi = d;
          }
          const distance = shape === 'dot' ? n.dotRadius : (lo + hi) / 2;
          expectPoint(sub(p, center(n)), { x: sign * u.x * distance, y: sign * u.y * distance });
        }
      }
    }
  });
  it.each([
    ['quarter', 0.2, 1.6], ['clockwise', 1.6, 0.2], ['seam', 3.05, -3.05],
    ['near-half', -1.4, 1.7], ['half', 0, Math.PI], ['rotated-half', 0.7, 0.7 + Math.PI],
    ['tiny', 0.7, 0.700001]
  ] as const)('%s follows radial departure, a smooth short orbit, radial arrival', (_name, a, b) => {
    for (const [ra, rb] of [[180, 430], [430, 180], [260, 260]]) {
      assertRadialRoute(polarNode(a, ra), polarNode(b, rb));
      assertRadialRoute(polarNode(a, ra), polarNode(b, rb), { fromShape: 'dot', toShape: 'dot' });
    }
  });
  it('keeps arbitrary translated angles/radii in their short angular wedges', () => {
    let seed = 0x712e;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 64; i++) {
      const a = random() * 2 * Math.PI - Math.PI, b = a + (0.01 + random() * (Math.PI - 0.02)) * (i % 2 ? 1 : -1);
      assertRadialRoute(polarNode(a, 24 + random() * 2000), polarNode(b, 24 + random() * 2000));
    }
  });
  it('intersects rounded corners and scaled dots/cards along radial rays', () => {
    const angle = Math.atan2(22, 50);
    const a = polarNode(angle, 200), b = polarNode(1.8, 500);
    for (const scale of [1, 0.25]) {
      const shown = graphNodePresentation(a, scale, true);
      const curves = assertRadialRoute(shown, b);
      const p = curves[0].start, c = center(a), k = shown.cornerRadius;
      expect(p.x).toBeGreaterThan(shown.x + shown.w - k); expect(p.y).toBeGreaterThan(shown.y + shown.h - k);
      expect(Math.hypot(p.x - (shown.x + shown.w - k), p.y - (shown.y + shown.h - k))).toBeCloseTo(k, 7);
      expect(Math.abs(cross(sub(p, c), sub(c, origin)))).toBeLessThan(1e-7);
      const dotCurve = assertRadialRoute(shown, b, { fromShape: 'dot', toShape: 'title' });
      expect(length(sub(dotCurve[0].start, c))).toBeCloseTo(shown.dotRadius, 7);
    }
  });
  it('keeps crossed enlarged-card ports and endpoint travel signed in both directions', () => {
    for (const delta of [0, 0.7, Math.PI]) {
      const a = graphNodePresentation(polarNode(0.35, 180), 0.1, true);
      const b = graphNodePresentation(polarNode(0.35 + delta, 220), 0.1, true);
      assertRadialRoute(a, b);
      assertRadialRoute(b, a);
    }
  });
  it('retains finite nonzero signed derivatives at roundoff-sized angular separations', () => {
    for (const delta of [1e-9, 1e-12, 1e-14, 0]) {
      const a = polarNode(0.7, 180), b = polarNode(0.7 + delta, 500);
      const path = edgePath(a, b, [], shapes, context), cs = cubics(path.d);
      expect(path.d).not.toMatch(/NaN|Infinity/);
      expect(dot(derivative(cs[0], 0), sub(center(a), origin))).toBeGreaterThan(0);
      expect(dot(derivative(cs.at(-1)!, 1), sub(center(b), origin))).toBeGreaterThan(0);
      for (const c of cs) for (let i = 0; i <= 40; i++) expect(length(derivative(c, i / 40))).toBeGreaterThan(0);
      expectReverse(path.d, edgePath(b, a, [], shapes, context).d);
    }
  });
  it.each([0, 0.7, -2.6])('uses a direct radial cubic for equal angles (%s)', angle => {
    const a = polarNode(angle, 180), b = polarNode(angle, 500);
    const d = edgePath(a, b, junk, shapes, context).d, curves = cubics(d);
    expect(curves).toHaveLength(1);
    const ra = sub(center(a), origin);
    for (const p of [curves[0].start, curves[0].c1, curves[0].c2, curves[0].end]) {
      expect(Math.abs(cross(sub(p, origin), ra))).toBeLessThan(1e-7);
    }
    expectReverse(d, edgePath(b, a, [], shapes, context).d);
  });
  it('stays finite for center endpoints, near-coincident angles and radial self-loops', () => {
    for (const [a, b] of [[polarNode(0, 0), polarNode(1, 300)], [polarNode(1, 300), polarNode(1 + 1e-12, 300)],
      [polarNode(1, 300), polarNode(1, 300)]]) {
      const path = edgePath(a, b, junk, shapes, context);
      expect(path.d).not.toMatch(/NaN|Infinity/);
      expect(Number.isFinite(path.midX) && Number.isFinite(path.midY)).toBe(true);
      expect(cubics(path.d).length).toBeGreaterThan(0);
    }
  });
});

describe('endpoint-only rectangular edge paths', () => {
  it.each([undefined, shapes])('uses one upward cubic from lower top to upper bottom, ignoring all dummies (%j)', style => {
    const lower = node(20, 300), upper = node(220, 10);
    const path = edgePath(lower, upper, junk, style);
    expect(path).toEqual(edgePath(lower, upper, [], style));
    const curves = cubics(path.d);
    expect(curves).toHaveLength(1);
    const c = curves[0];
    expectPoint(c.start, { x: 70, y: 300 }); expectPoint(c.end, { x: 270, y: 54 });
    expect(c.c1.x).toBe(c.start.x); expect(c.c2.x).toBe(c.end.x);
    expect(derivative(c, 0).y).toBeLessThan(0); expect(derivative(c, 1).y).toBeLessThan(0);
    expectReverse(path.d, edgePath(upper, lower, junk, style).d);
  });
  it('uses actual dot/zoomed-card vertical ports', () => {
    const from = graphNodePresentation(node(0, 300), 0.25, true), to = node(200, 0);
    const [c] = cubics(edgePath(from, to, [], { fromShape: 'title', toShape: 'dot' }).d);
    expectPoint(c.start, { x: 50, y: from.y }); expectPoint(c.end, { x: 250, y: to.y + to.h / 2 + 12 });
  });
  it('uses deterministic vertical ports for same-level edges and reverses the same curve', () => {
    const a = node(0, 0), b = node(200, 0);
    const d = edgePath(a, b, junk, shapes).d, [c] = cubics(d);
    expect(c.c1.x).toBe(c.start.x); expect(c.c2.x).toBe(c.end.x);
    expect(length(derivative(c, 0))).toBeGreaterThan(0); expect(length(derivative(c, 1))).toBeGreaterThan(0);
    expectReverse(d, edgePath(b, a, [], shapes).d);
  });
  it.each(['dot', 'title'] as const)('keeps a finite visible self-loop outside the %s', shape => {
    const n = node(10, 20);
    const path = edgePath(n, n, junk, { fromShape: shape, toShape: shape });
    const curves = cubics(path.d);
    expect(curves.at(-1)!.end).not.toEqual(curves[0].start);
    expect(curves.some(c => c.c1.x > n.x + n.w || c.c2.x > n.x + n.w)).toBe(true);
    expect(curves.some(c => c.c1.y < n.y || c.c2.y < n.y)).toBe(true);
    expect(path.d).not.toMatch(/NaN|Infinity/);
  });
});
