import { describe, expect, it } from 'vitest';
import { computePageRank, pageRankGraph } from './pageRank';
const nodes = (...ids: string[]) => ids.map(id => ({ id }));
const edge = (from: string, to: string, label = 'depends') => ({ from, to, label });
describe('global PageRank', () => {
  it('handles empty graphs and uniformly redistributes dangling mass', () => {
    expect(computePageRank([], [])).toMatchObject({ scores: {}, converged: true, iterations: 0 });
    expect(computePageRank(nodes('A', 'B'), []).scores).toEqual({ A: 0.5, B: 0.5 });
    expect(computePageRank(nodes('A'), []).scores).toEqual({ A: 1 });
  });
  it('uses the stable deduplicated depends topology only, including every vertex', () => {
    const entries = nodes('isolated', 'B', 'A', 'A');
    const relationships = [edge('B', 'A', 'branch'), edge('B', 'A', 'uses_context'),
      edge('A', 'A'), edge('missing', 'B'), edge('A', 'missing'), edge('A', 'B'), edge('A', 'B')];
    expect(pageRankGraph(entries, relationships)).toEqual({ nodes: ['A', 'B', 'isolated'], edges: [['A', 'B']] });
    expect(computePageRank(entries, relationships)).toEqual(computePageRank(nodes('A', 'B', 'isolated'), [edge('A', 'B')]));
    expect(computePageRank([...entries].reverse(), [...relationships].reverse())).toEqual(computePageRank(entries, relationships));
  });
  it('converges on a cycle and preserves prototype-shaped Entry identities', () => {
    const result = computePageRank(nodes('__proto__', 'constructor'), [edge('__proto__', 'constructor'), edge('constructor', '__proto__')]);
    expect(result.converged).toBe(true);
    expect(Object.keys(result.scores).sort()).toEqual(['__proto__', 'constructor']);
    expect(result.scores.__proto__).toBe(0.5);
    expect(result.scores.constructor).toBe(0.5);
  });
  it('reports the iteration limit honestly rather than claiming convergence', () => {
    const result = computePageRank(nodes('A', 'B'), [edge('A', 'B')], { maxIterations: 1, tolerance: 1e-15 });
    expect(result).toMatchObject({ converged: false, iterations: 1 });
    expect(Object.values(result.scores).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
    expect(Object.values(result.scores).every(s => Number.isFinite(s) && s >= 0)).toBe(true);
  });
  it.each([{ damping: -1 }, { damping: 1 }, { damping: NaN }, { tolerance: 0 },
    { tolerance: Infinity }, { maxIterations: 0 }, { maxIterations: 1.5 }])('rejects invalid parameters %j', options => {
    expect(() => computePageRank([], [], options)).toThrow();
  });
  it('matches an independent rational stationary solution with an isolated vertex', () => {
    const result = computePageRank(nodes('A', 'B', 'isolated'), [edge('A', 'B')]);
    // Solve x=(1-.85)/3 + .85*(y+x)/3, y=x+.85*x, 2*x+y=1.
    expect(result.scores.A).toBeCloseTo(20 / 77, 10);
    expect(result.scores.B).toBeCloseTo(37 / 77, 10);
    expect(result.scores.isolated).toBeCloseTo(20 / 77, 10);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
  });
});
