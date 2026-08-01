import { describe, expect, it } from 'vitest';
import { parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import {
  analyzeSnlStructuralIndex,
  buildEntryMetricContext,
  countSnlSemanticTokens,
  computeEntryMetrics,
  computeEntryMetricsForIds,
  snlNodeLengthWeight,
  type SnlMacroSourceLookup
} from './EntryMetrics';
import { applyContextSrcLookup } from '../render/contextSrcLookup';

const macros: SnlMacroSourceLookup = {};

function okMetrics(result: ReturnType<typeof computeEntryMetrics>) {
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error(result.reason);
  return result.metrics;
}

describe('computeEntryMetrics context sources', () => {
  it('precomputes each requested library entry once', () => {
    const results = computeEntryMetricsForIds(
      [
        { id: 'free-entry', content: { snl: 'free' } },
        { id: 'unused-entry', content: { snl: 'unused' } }
      ],
      ['free-entry', 'free-entry'],
      {}
    );
    expect([...results.keys()]).toEqual(['free-entry']);
    expect(results.get('free-entry')).toMatchObject({
      kind: 'ok',
      metrics: { structuralIndex: 0 }
    });
  });

  it('resolves declarations grouped by list-partial in a context judgment', () => {
    const snl =
      'def(Set.SymmDiff(A@Set.ctxt.AB,B@Set.ctxt.AB),Set.diff(parentheses(Set.union(A@Set.ctxt.AB,B@Set.ctxt.AB)),parentheses(Set.inter(A@Set.ctxt.AB,B@Set.ctxt.AB))))';
    const source = { source: { entries: ['entry-ok'], urls: [] } };
    const setMacros: SnlMacroSourceLookup = {
      'Set.SymmDiff': source,
      'Set.diff': source,
      'Set.union': source,
      'Set.inter': source,
      def: { source: { entries: [], urls: [] } },
      parentheses: { source: { entries: [], urls: [] } }
    };
    const context = buildEntryMetricContext([
      {
        id: 'Set.ctxt.AB',
        content: {
          snl: 'Type.judge(list-partial(@A,@B),Set(T@Set.ctxt.T))'
        }
      },
      { id: 'Set.ctxt.T', content: { snl: '@T' } },
      { id: 'entry-ok', content: { snl: '@anchor' } }
    ]);

    const metrics = okMetrics(computeEntryMetrics(snl, setMacros, context));
    expect(metrics).toMatchObject({
      strongSemanticFreedom: 3,
      weakSemanticFreedom: 0,
      weightedTotal: 13
    });
    expect(metrics.structuralIndex).toBeCloseTo(10 / 13);
  });

  it('counts x@entry as sourced only when that entry exports @x', () => {
    const resolved = buildEntryMetricContext([
      { id: 'ctx', content: { snl: 'context(@x)' } }
    ]);
    expect(okMetrics(computeEntryMetrics('x@ctx', macros, resolved))).toMatchObject({
      weakSemanticFreedom: 0,
      strongSemanticFreedom: 0,
      structuralIndex: 1
    });

    const noDeclaration = buildEntryMetricContext([
      { id: 'ctx', content: { snl: 'context(y)' } }
    ]);
    expect(okMetrics(computeEntryMetrics('x@ctx', macros, noDeclaration))).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });

    const dangling = buildEntryMetricContext([]);
    expect(okMetrics(computeEntryMetrics('x@missing', macros, dangling))).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });

    const nestedDeclaration = buildEntryMetricContext([
      { id: 'ctx', content: { snl: 'context(wrapper(@x))' } }
    ]);
    expect(
      okMetrics(computeEntryMetrics('x@ctx', macros, nestedDeclaration))
    ).toMatchObject({
      weakSemanticFreedom: 0,
      strongSemanticFreedom: 0,
      structuralIndex: 1
    });
  });

  it('does not confuse a local binder name with an entry source id', () => {
    const context = buildEntryMetricContext([]);
    const metrics = okMetrics(
      computeEntryMetrics('root(@ctx,x@ctx)', macros, context)
    );
    expect(metrics).toMatchObject({
      weakSemanticFreedom: 2,
      strongSemanticFreedom: 2
    });
    expect(metrics.structuralIndex).toBeCloseTo(1 / 3);
  });

  it('does not expose contradictory legacy source metrics', () => {
    const metrics = okMetrics(
      computeEntryMetrics('free', macros, buildEntryMetricContext([]))
    );
    expect(metrics).not.toHaveProperty('sourcedNodes');
    expect(metrics).not.toHaveProperty('semanticFreedom');
    expect(metrics).not.toHaveProperty('structuredRatio');
  });

  it('distinguishes dangling src from an entry with no matching declaration', () => {
    const dangling = parseSnlSyntaxTree('x@missing');
    applyContextSrcLookup(dangling, buildEntryMetricContext([]).contextIndex);
    expect(dangling.mdata).toMatchObject({ srcStatus: 'dangling' });

    const noDeclaration = parseSnlSyntaxTree('x@ctx');
    const context = buildEntryMetricContext([
      { id: 'ctx', content: { snl: 'context(y)' } }
    ]);
    applyContextSrcLookup(noDeclaration, context.contextIndex);
    expect(noDeclaration.mdata).toMatchObject({
      srcStatus: 'srcResolvedNoDecl'
    });
  });
});

describe('SNL Structural Index', () => {
  const indexedMacros: SnlMacroSourceLookup = {
    root: { source: { entries: ['entry-ok'], urls: [] } },
    indexed: { source: { entries: ['entry-ok'], urls: [] } },
    unresolved: { source: { entries: ['missing-entry'], urls: [] } }
  };

  it('tokenizes Han characters individually and Latin words as units', () => {
    expect(countSnlSemanticTokens('这是 two_words, plus')).toBe(5);
    expect(countSnlSemanticTokens('alpha.beta-gamma')).toBe(3);
  });

  it('starts a logarithmic length penalty after six tokens', () => {
    expect(snlNodeLengthWeight('one two three four five six')).toBe(1);
    expect(snlNodeLengthWeight('one two three four five six seven')).toBeCloseTo(1.2);
    expect(snlNodeLengthWeight('one two three four five six seven eight')).toBeCloseTo(
      1 + 0.2 * Math.log2(3)
    );
  });

  it('uses unresolved constants only in strong freedom and excludes numbers', () => {
    const tree = parseSnlSyntaxTree('root(free,unresolved,indexed,42)');
    const metrics = analyzeSnlStructuralIndex(
      tree,
      indexedMacros,
      new Set(['entry-ok'])
    );

    expect(metrics).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 2,
      weightedTotal: 4,
      weightedWeakSemanticFreedom: 1,
      weightedStrongSemanticFreedom: 2,
      structuralIndex: 0.5
    });
  });

  it('treats an all-numeric tree as structurally explicit', () => {
    const metrics = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('42'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(metrics.weightedTotal).toBe(0);
    expect(metrics.weakSemanticFreedom).toBe(0);
    expect(metrics.strongSemanticFreedom).toBe(0);
    expect(metrics.structuralIndex).toBe(1);
  });

  it('does not mistake free text or a numeric-looking parent for numeric literals', () => {
    const freeText = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('%42%'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(freeText).toMatchObject({
      weightedTotal: 1,
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });

    const parent = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('42(x)'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(parent).toMatchObject({
      weightedTotal: 2,
      weakSemanticFreedom: 2,
      strongSemanticFreedom: 2,
      structuralIndex: 0
    });
  });

  it('keeps an invalid external bvar free even when the entry id is accessible', () => {
    const tree = parseSnlSyntaxTree('x');
    tree.kind = 'bvar';
    tree.mdata = { src: 'entry-ok', srcStatus: 'srcResolvedNoDecl' };
    const metrics = analyzeSnlStructuralIndex(
      tree,
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(metrics).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });
  });

  it('keeps binder declarations semantic even when their src annotation dangles', () => {
    const tree = parseSnlSyntaxTree('@x@missing');
    applyContextSrcLookup(tree, buildEntryMetricContext([]).contextIndex);
    const metrics = analyzeSnlStructuralIndex(tree, indexedMacros, new Set());
    expect(tree.kind).toBe('binder');
    expect(metrics).toMatchObject({
      weakSemanticFreedom: 0,
      strongSemanticFreedom: 0,
      structuralIndex: 1
    });
  });

  it('keeps an invalid explicit source weakly free despite a catalog collision', () => {
    const collisionMacros: SnlMacroSourceLookup = {
      x: { source: { entries: ['entry-ok'], urls: [] } },
      indexed: { source: { entries: ['entry-ok'], urls: [] } }
    };
    const context = buildEntryMetricContext([
      { id: 'entry-ok', content: { snl: 'context(@x)' } },
      { id: 'ctx', content: { snl: 'context(y)' } }
    ]);

    expect(okMetrics(computeEntryMetrics('x@ctx', collisionMacros, context))).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });
    expect(
      okMetrics(computeEntryMetrics('indexed@missing', collisionMacros, context))
    ).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });
  });

  it('keeps free text free when its payload collides with an indexed macro name', () => {
    const metrics = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('%indexed%'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(metrics).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });

    const formula = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('$indexed$'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(formula).toMatchObject({
      weakSemanticFreedom: 1,
      strongSemanticFreedom: 1,
      structuralIndex: 0
    });
  });

  it('excludes decimal and scientific numeric leaves and bounds every index', () => {
    for (const source of ['3.14', '1e10', '$42$']) {
      const metrics = analyzeSnlStructuralIndex(
        parseSnlSyntaxTree(source),
        indexedMacros,
        new Set(['entry-ok'])
      );
      expect(metrics.weightedTotal).toBe(0);
      expect(metrics.structuralIndex).toBe(1);
    }

    for (const source of ['free', 'root(free,indexed)', 'root(indexed,42)']) {
      const metrics = analyzeSnlStructuralIndex(
        parseSnlSyntaxTree(source),
        indexedMacros,
        new Set(['entry-ok'])
      );
      expect(metrics.structuralIndex).toBeGreaterThanOrEqual(0);
      expect(metrics.structuralIndex).toBeLessThanOrEqual(1);
    }
  });

  it('does not apply length penalties to indexed bvars or binders', () => {
    const longName = 'variable.one.two.three.four.five.six.seven.eight';
    const binder = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree(`@${longName}`),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(binder).toMatchObject({
      weightedTotal: 1,
      weightedStrongSemanticFreedom: 0,
      structuralIndex: 1
    });

    const local = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree(`root(@${longName},${longName})`),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(local).toMatchObject({
      weightedTotal: 3,
      weightedStrongSemanticFreedom: 0,
      structuralIndex: 1
    });

    const externalContext = buildEntryMetricContext([
      { id: 'ctx', content: { snl: `context(@${longName})` } }
    ]);
    const external = okMetrics(
      computeEntryMetrics(`${longName}@ctx`, indexedMacros, externalContext)
    );
    expect(external).toMatchObject({
      weightedTotal: 1,
      weightedStrongSemanticFreedom: 0,
      structuralIndex: 1
    });

    const unresolved = okMetrics(
      computeEntryMetrics(
        `${longName}@missing`,
        indexedMacros,
        buildEntryMetricContext([])
      )
    );
    expect(unresolved.weightedStrongSemanticFreedom).toBeGreaterThan(1);

    const existingWithoutDeclaration = okMetrics(
      computeEntryMetrics(
        `${longName}@ctx`,
        indexedMacros,
        buildEntryMetricContext([
          { id: 'ctx', content: { snl: 'context(@another.variable)' } }
        ])
      )
    );
    expect(existingWithoutDeclaration.weightedStrongSemanticFreedom).toBeGreaterThan(1);

    const localWithDanglingExplicitSource = okMetrics(
      computeEntryMetrics(
        `root(@${longName},${longName}@missing)`,
        indexedMacros,
        buildEntryMetricContext([
          { id: 'entry-ok', content: { snl: 'context(@anchor)' } }
        ])
      )
    );
    expect(localWithDanglingExplicitSource.strongSemanticFreedom).toBe(1);
    expect(localWithDanglingExplicitSource.weightedStrongSemanticFreedom).toBeGreaterThan(1);

    const localWithInvalidExistingSource = okMetrics(
      computeEntryMetrics(
        `root(@${longName},${longName}@ctx)`,
        indexedMacros,
        buildEntryMetricContext([
          { id: 'entry-ok', content: { snl: 'context(@anchor)' } },
          { id: 'ctx', content: { snl: 'context(@another.variable)' } }
        ])
      )
    );
    expect(localWithInvalidExistingSource.strongSemanticFreedom).toBe(1);
    expect(localWithInvalidExistingSource.weightedStrongSemanticFreedom).toBeGreaterThan(1);
  });

  it('does not apply length penalties to catalog constants', () => {
    const longName = 'constant.one.two.three.four.five.six.seven.eight';
    const constantMacros: SnlMacroSourceLookup = {
      ...indexedMacros,
      [longName]: { source: { entries: ['missing-entry'], urls: [] } }
    };
    const constant = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree(`root(${longName},indexed)`),
      constantMacros,
      new Set(['entry-ok'])
    );
    const free = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree(`root(${longName},indexed)`),
      indexedMacros,
      new Set(['entry-ok'])
    );

    expect(constant).toMatchObject({
      weakSemanticFreedom: 0,
      strongSemanticFreedom: 1,
      weightedTotal: 3,
      weightedStrongSemanticFreedom: 1
    });
    expect(constant.structuralIndex).toBeCloseTo(2 / 3);
    expect(free.weightedStrongSemanticFreedom).toBeGreaterThan(1);
    expect(free.structuralIndex).toBeLessThan(constant.structuralIndex);

    const sourcedLongName = 'sourced.one.two.three.four.five.six.seven.eight';
    const sourcedLong = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree(sourcedLongName),
      {
        [sourcedLongName]: {
          source: { entries: ['entry-ok'], urls: [] }
        }
      },
      new Set(['entry-ok'])
    );
    expect(sourcedLong).toMatchObject({
      weightedTotal: 1,
      weightedStrongSemanticFreedom: 0,
      structuralIndex: 1
    });

    const invalidCollision = okMetrics(
      computeEntryMetrics(
        `${longName}@missing`,
        constantMacros,
        buildEntryMetricContext([])
      )
    );
    expect(invalidCollision.weakSemanticFreedom).toBe(1);
    expect(invalidCollision.strongSemanticFreedom).toBe(1);
    expect(invalidCollision.weightedStrongSemanticFreedom).toBeGreaterThan(1);
    expect(invalidCollision.structuralIndex).toBe(0);
  });

  it('penalizes a long free-text node more than a short free node', () => {
    const short = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('root(%one two three four five six%,indexed)'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    const long = analyzeSnlStructuralIndex(
      parseSnlSyntaxTree('root(%one two three four five six seven eight nine ten%,indexed)'),
      indexedMacros,
      new Set(['entry-ok'])
    );
    expect(long.structuralIndex).toBeLessThan(short.structuralIndex);
  });
});
