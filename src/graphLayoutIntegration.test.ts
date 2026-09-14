import { expect, it } from 'vitest';
import { graphLayoutInput, graphLayoutKey, generateGraphLayout, isGraphLayout, GraphLayoutMemoryCache } from './graphLayoutCacheModel';
import { DEFAULT_LAYOUT_PARAMETERS, type Layout } from './graphLayout';

const unsafeRadialCases: Array<[string, (value: Layout) => void]> = [
  ['missing radial metadata', value => { delete value.radial; }],
  ['unexpected radial field', value => { Object.assign(value.radial!, { viewport: 1 }); }],
  ['nonfinite center', value => { value.radial!.centerX = Infinity; }],
  ['wrong packing', value => { value.radial!.packing = 'rings'; }],
  ['fractional layer', value => { value.radial!.maxLayer = 0.5; }],
  ['missing layer radius', value => { value.radial!.layerRadii.pop(); }],
  ['missing sample', value => { value.radial!.radiusSamples.find(row => row.length)!.pop(); }],
  ['nonfinite sample', value => { value.radial!.radiusSamples.find(row => row.length)![0].radius = NaN; }],
  ['zero angular span denominator', value => { value.radial!.xSpan = 0; }],
  ['excessive sweep', value => { value.radial!.sweep = 99; }],
  ['missing sector', value => { delete value.clusters[0].sector; }],
  ['negative sector radius', value => { value.clusters[0].sector!.outerRadius = -1; }],
  ['nonfinite label', value => { value.clusters[0].sector!.labelX = NaN; }],
  ['active path string', value => { value.clusters[0].sector!.path = 'url(https://invalid.test/)'; }],
  ['nonfinite path token', value => { value.clusters[0].sector!.path = 'M 0 0 A 1e999 1 0 0 1 1 1 L 0 0 A 1 1 0 0 0 0 0 Z'; }],
  ['wrong path arity', value => { value.clusters[0].sector!.path = 'M 0 A 1 L 0 A 1 Z'; }],
  ['invalid arc flag', value => { value.clusters[0].sector!.path = 'M 0 0 A 1 1 0 2 1 1 1 L 0 0 A 1 1 0 0 0 0 0 Z'; }]
];
it.each(unsafeRadialCases)('rejects unsafe radial cache: %s without admitting it into memory', (_name, mutate) => {
  const input = graphLayoutInput('one', 'en', nodes, edges, { ...DEFAULT_LAYOUT_PARAMETERS, mode: 'radial-inward', packing: 'bands' });
  const good = generateGraphLayout(input);
  expect(isGraphLayout(good, input)).toBe(true);
  const bad = structuredClone(good);
  mutate(bad);
  expect(isGraphLayout(bad, input)).toBe(false);
  expect(new GraphLayoutMemoryCache().get(input, { key: graphLayoutKey(input), layout: bad })).toEqual(good);
});
const nodes = Array.from({length: 12}, (_, i) => ({ id: `n${i}`, packageId: `p${i%2}`, title: `Title ${i}`, kind: 'Theorem', kindId: 'thm', color: '', background: '' }));
const edges = nodes.slice(1).map((n,i) => ({id: `e${i}`, from: n.id, to: nodes[Math.floor(i/2)].id, label: 'related', isDependency: false, isAtomic: null}));
it('keys and generates the actual radial direction and packing rather than old rectangle geometry', () => {
  const rectangle = graphLayoutInput('one','en',nodes,edges);
  const inputs = ['radial-inward','radial-outward'].flatMap(mode => ['bands','rings'].map(packing => graphLayoutInput('one','en',nodes,edges,{...DEFAULT_LAYOUT_PARAMETERS,mode,packing} as typeof DEFAULT_LAYOUT_PARAMETERS)));
  expect(new Set([rectangle,...inputs].map(graphLayoutKey)).size).toBe(5);
  for (const input of inputs) {
    const result = generateGraphLayout(input);
    expect(result).toHaveProperty('radial');
    expect(isGraphLayout(result,input)).toBe(true);
    expect(result.nodes).not.toEqual(generateGraphLayout(rectangle).nodes);
    expect(new GraphLayoutMemoryCache().get(input,{key:graphLayoutKey(input),layout:result})).toEqual(result);
  }
});
it('excludes arbitrary tag/paint/viewport state but binds effective topology, language and rectangle packing semantics', () => {
  const base = graphLayoutInput(null,'en',nodes,edges);
  const painted = nodes.map(n => ({...n,tags:['','__proto__'],color:'#123456',background:'#abcdef'}));
  expect(graphLayoutKey(graphLayoutInput(null,'en',painted,edges,{...DEFAULT_LAYOUT_PARAMETERS, mode:'rectangle', packing:'rings'} as typeof DEFAULT_LAYOUT_PARAMETERS))).toBe(graphLayoutKey(base));
  expect(graphLayoutKey(graphLayoutInput(null,'zh-CN',nodes,edges))).not.toBe(graphLayoutKey(base));
  expect(graphLayoutKey(graphLayoutInput(null,'en',nodes,edges.slice(1)))).not.toBe(graphLayoutKey(base));
});
