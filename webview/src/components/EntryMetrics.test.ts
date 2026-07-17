import { describe, expect, it } from 'vitest';
import { parseSnlSyntaxTree } from '@snl-basics/react';
import {
  buildEntryMetricContext,
  computeEntryMetrics,
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
  it('counts x@entry as sourced only when that entry exports @x', () => {
    const resolved = buildEntryMetricContext([
      { id: 'ctx', content: { snl: 'context(@x)' } }
    ]);
    expect(okMetrics(computeEntryMetrics('x@ctx', macros, resolved))).toMatchObject({
      totalNodes: 1,
      sourcedNodes: 1,
      semanticFreedom: 0
    });

    const noDeclaration = buildEntryMetricContext([
      { id: 'ctx', content: { snl: 'context(y)' } }
    ]);
    expect(okMetrics(computeEntryMetrics('x@ctx', macros, noDeclaration))).toMatchObject({
      sourcedNodes: 0,
      semanticFreedom: 1
    });

    const dangling = buildEntryMetricContext([]);
    expect(okMetrics(computeEntryMetrics('x@missing', macros, dangling))).toMatchObject({
      sourcedNodes: 0,
      semanticFreedom: 1
    });
  });

  it('does not confuse a local binder name with an entry source id', () => {
    const context = buildEntryMetricContext([]);
    expect(
      okMetrics(computeEntryMetrics('root(@ctx,x@ctx)', macros, context))
    ).toMatchObject({
      totalNodes: 3,
      sourcedNodes: 1,
      semanticFreedom: 2
    });
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
