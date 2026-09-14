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

// Finite values can still disagree with the sector's semantic geometry.
const finiteSectorCases: Array<[string, (value: Layout) => void]> = [
  ['label anchor', value => { value.clusters[0].sector!.labelX = value.clusters[0].sector!.labelY = 1e9; }],
  ['label angle', value => { value.clusters[0].sector!.labelAngle += 0.25; }],
  ['unrelated finite path', value => { value.clusters[0].sector!.path = 'M 0 0 A 1 1 0 0 1 1 1 L 0 0 A 1 1 0 0 0 0 0 Z'; }],
  ['path endpoint', value => { value.clusters[0].sector!.path = value.clusters[0].sector!.path.replace(/^M \S+/, 'M 1000000000'); }],
  ['path arc radius', value => { value.clusters[0].sector!.path = value.clusters[0].sector!.path.replace(/ A \S+/, ' A 1000000000'); }],
  ['path arc rotation', value => { value.clusters[0].sector!.path = value.clusters[0].sector!.path.replace(/( A \S+ \S+) 0/, '$1 45'); }],
  ['path sweep flag', value => { value.clusters[0].sector!.path = value.clusters[0].sector!.path.replace(/( A \S+ \S+ 0 [01]) 1/, '$1 0'); }],
];
for (const mode of ['radial-inward', 'radial-outward'] as const) {
  for (const packing of ['bands', 'rings'] as const) {
    it.each(finiteSectorCases)(`rejects finite inconsistent sector (${mode}/${packing}): %s`, (_name, mutate) => {
      const input = graphLayoutInput('one', 'en', nodes, edges, { ...DEFAULT_LAYOUT_PARAMETERS, mode, packing });
      const good = generateGraphLayout(input);
      const bad = structuredClone(good);
      mutate(bad);
      const cache = new GraphLayoutMemoryCache();
      const admitted = cache.get(input, { key: graphLayoutKey(input), layout: bad });
      expect.soft(isGraphLayout(bad, input)).toBe(false);
      expect.soft(admitted.clusters[0].sector).toEqual(good.clusters[0].sector);
      expect(admitted).toEqual(good);
      expect(cache.get(input)).toBe(admitted);
    });
  }
}
for (const mode of ['rectangle', 'radial-inward', 'radial-outward'] as const) {
  for (const packing of ['bands', 'rings'] as const) {
    it(`accepts real JSON roundtrip without regeneration (${mode}/${packing})`, () => {
      const input = graphLayoutInput('one', 'en', nodes, edges, { ...DEFAULT_LAYOUT_PARAMETERS, mode, packing });
      const good = generateGraphLayout(input);
      const artifact = JSON.parse(JSON.stringify({ key: graphLayoutKey(input), layout: good }));
      expect(isGraphLayout(artifact.layout, input)).toBe(true);
      expect(new GraphLayoutMemoryCache().get(input, artifact)).toEqual(good);
      // Retaining equivalent numeric spellings / sub-tolerance roundoff (or
      // a supported rectangular width) proves admission, not regeneration.
      if (artifact.layout.radial) {
        artifact.layout.clusters[0].sector.labelX += 5e-8;
        artifact.layout.clusters[0].sector.labelAngle += 5e-8;
        // Equivalent numeric SVG spelling proves geometry, not string equality.
        artifact.layout.clusters[0].sector.path = artifact.layout.clusters[0].sector.path.replace(/^M (\S+)/, (_match: string, x: string) => `M ${Number(x).toExponential(16)}`);
      } else artifact.layout.width += 1;
      const cache = new GraphLayoutMemoryCache();
      const accepted = cache.get(input, artifact);
      expect(accepted).toEqual(artifact.layout);
      expect(accepted).not.toBe(artifact.layout);
      expect(cache.get(input)).toBe(accepted);
      artifact.layout.clusters[0].x += 1;
      expect(accepted.clusters[0].x).toBe(good.clusters[0].x);
    });
  }
}
