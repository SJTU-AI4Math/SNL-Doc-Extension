// Shared SSI algorithm, moved verbatim from EntryMetrics; no React/DOM/Node runtime.
import type { SnlMacroSourceLookup, SnlSyntaxTree, SnlMacroRecord } from '@sjtu-ai4math/snl-basics';
import { applyContextSrcLookup, buildContextIndex, type EntryPoolItemForLookup } from './ssiContext';
export type { SnlMacroSourceLookup };
export interface SsiParser {
  tryParseSnlSyntaxTree: typeof import('@sjtu-ai4math/snl-basics')['tryParseSnlSyntaxTree'];
  resolveSnlSemantics: typeof import('@sjtu-ai4math/snl-basics')['resolveSnlSemantics'];
  extractExportedBinders: (snl: string) => Set<string>;
}
export type EntryMetricResult =
  | { kind: 'ok'; metrics: SnlStructuralMetrics }
  | { kind: 'unavailable'; reason: 'noContent' }
  | { kind: 'unavailable'; reason: 'parseError'; error: string };

export interface SnlStructuralMetrics {
  /** Unsourced catalog constants. */
  weakSemanticFreedom: number;
  /** Unsourced nodes without a matching catalog constant. */
  strongSemanticFreedom: number;
  /** Sum of length-adjusted weights for non-numeric nodes. */
  weightedTotal: number;
  weightedWeakSemanticFreedom: number;
  weightedStrongSemanticFreedom: number;
  /** Conservative weighted structural coverage in the closed interval [0, 1]. */
  structuralIndex: number;
}

/**
 * Stable, model-independent content units for metric weighting. Han characters
 * count individually; contiguous letters, marks, or digits form one word.
 * Separators in macro ids (`.`, `_`, `-`) do not count.
 */
export function countSnlSemanticTokens(text: string): number {
  return text.match(/[\p{Script=Han}]|[\p{L}\p{M}\p{N}]+/gu)?.length ?? 0;
}

/**
 * Nodes up to six content units retain weight 1. Afterwards the first extra
 * unit adds 0.2 and further additions have logarithmically diminishing effect.
 */
export function snlNodeLengthWeight(macroName: string): number {
  const excess = Math.max(0, countSnlSemanticTokens(macroName) - 6);
  return 1 + 0.2 * Math.log2(1 + excess);
}

function nodeMetadata(node: SnlSyntaxTree): Record<string, unknown> {
  return node.mdata && typeof node.mdata === 'object'
    ? (node.mdata as Record<string, unknown>)
    : {};
}

function explicitEntrySource(node: SnlSyntaxTree): string {
  if (node.source?.type === 'entry') return node.source.entry_id;
  if (node.postfix?.type === 'name') return node.postfix.name;
  const meta = nodeMetadata(node);
  return typeof meta.src === 'string' ? meta.src : '';
}

function nodeMetricText(node: SnlSyntaxTree): string {
  return node.env_mode && typeof node.temporary_source === 'string'
    ? node.temporary_source
    : node.macro_name;
}

function isNumericNode(node: SnlSyntaxTree): boolean {
  if (
    node.children.length > 0 ||
    node.env_mode === 'text' ||
    node.env_mode === 'block' ||
    node.kind === 'binder' ||
    node.kind === 'bvar'
  ) {
    return false;
  }
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(
    nodeMetricText(node).trim()
  );
}

function isCatalogConstant(
  node: SnlSyntaxTree,
  macroLookup: SnlMacroSourceLookup
): boolean {
  const explicitSrc = explicitEntrySource(node);
  return (
    explicitSrc.length === 0 &&
    !node.env_mode &&
    node.kind !== 'fvar' &&
    node.kind !== 'bvar' &&
    node.kind !== 'binder' &&
    Boolean(macroLookup[node.macro_name])
  );
}

function hasResolvedSemantics(
  node: SnlSyntaxTree,
  macroLookup: SnlMacroSourceLookup,
  accessibleEntryIds: ReadonlySet<string>,
  binderNames: ReadonlySet<string>
): boolean {
  if (node.kind === 'binder') return true;

  const meta = nodeMetadata(node);
  const bindRef = typeof meta.bindRef === 'string' ? meta.bindRef : '';
  const src = explicitEntrySource(node);
  const srcStatus = typeof meta.srcStatus === 'string' ? meta.srcStatus : '';

  // An explicit source on a non-binder overrides a same-named local binding:
  // it is valid only when context lookup found the target entry and exact export.
  if (src.length > 0) {
    return (
      node.kind === 'bvar' &&
      srcStatus.length === 0 &&
      accessibleEntryIds.has(src)
    );
  }

  if (node.kind === 'bvar' && node.source?.type === 'tree_path') {
    return true;
  }

  if (
    node.kind === 'bvar' &&
    bindRef.length > 0 &&
    binderNames.has(node.macro_name)
  ) {
    return true;
  }

  // Delimited text/formula nodes and parser-classified free variables are
  // synthetic payloads, never catalog constants even if their text collides.
  if (node.env_mode || node.kind === 'fvar' || node.kind === 'bvar') {
    return false;
  }

  const macro = macroLookup[node.macro_name];
  if (!macro) return false;
  const entries = Array.isArray(macro.source?.entries) ? macro.source.entries : [];
  const urls = Array.isArray(macro.source?.urls) ? macro.source.urls : [];
  return (
    urls.some((url) => typeof url === 'string' && url.length > 0) ||
    entries.some((id) => accessibleEntryIds.has(id))
  );
}

/**
 * Compute the SNL Structural Index while retaining raw strong/weak freedom.
 * A known macro with an unresolved source contributes weak freedom; an unknown
 * node contributes strong freedom. The categories are disjoint. Numeric
 * literals are assumed semantically clear and are excluded from both weighted
 * numerator and denominator.
 */
export interface EntryMetricContext {
  accessibleEntryIds: ReadonlySet<string>;
  contextIndex: Map<string, Set<string>>;
}


export function createSsiEngine({ tryParseSnlSyntaxTree, resolveSnlSemantics, extractExportedBinders }: SsiParser) {
  function analyzeSnlStructuralIndex(
    root: SnlSyntaxTree,
    macroLookup: SnlMacroSourceLookup,
    accessibleEntryIds: ReadonlySet<string>
  ): SnlStructuralMetrics {
    const semanticMacros = Object.fromEntries(
      Object.entries(macroLookup).map(([name, macro]) => [name, {
        name,
        description: '',
        dynamic_arity: false,
        tags: [],
        styles: [],
        source: macro.source
      }])
    ) as SnlMacroRecord;
    const semanticRoot = resolveSnlSemantics(root, semanticMacros).tree;
    const binderNames = new Set<string>();
    const collectBinders = (node: SnlSyntaxTree): void => {
      if (node.kind === 'binder') binderNames.add(node.macro_name);
      for (const child of node.children) collectBinders(child);
    };
    collectBinders(semanticRoot);

    let weakSemanticFreedom = 0;
    let strongSemanticFreedom = 0;
    let weightedTotal = 0;
    let weightedWeakSemanticFreedom = 0;
    let weightedStrongSemanticFreedom = 0;

    const walk = (node: SnlSyntaxTree): void => {
      if (!isNumericNode(node)) {
        const catalogConstant = isCatalogConstant(node, macroLookup);
        const sourced = hasResolvedSemantics(
          node,
          macroLookup,
          accessibleEntryIds,
          binderNames
        );
        const lengthExempt =
          catalogConstant ||
          node.kind === 'binder' ||
          (node.kind === 'bvar' && sourced);
        const weight = lengthExempt ? 1 : snlNodeLengthWeight(nodeMetricText(node));
        weightedTotal += weight;

        if (!sourced) {
          if (catalogConstant) {
            weakSemanticFreedom += 1;
            weightedWeakSemanticFreedom += weight;
          } else {
            strongSemanticFreedom += 1;
            weightedStrongSemanticFreedom += weight;
          }
        }
      }

      for (const child of node.children) walk(child);
    };
    walk(semanticRoot);

    const structuralIndex =
      weightedTotal === 0
        ? 1
        : Math.min(
            1,
            Math.max(
              0,
              1 - (
                weightedWeakSemanticFreedom + weightedStrongSemanticFreedom
              ) / weightedTotal
            )
          );
    return {
      weakSemanticFreedom,
      strongSemanticFreedom,
      weightedTotal,
      weightedWeakSemanticFreedom,
      weightedStrongSemanticFreedom,
      structuralIndex
    };
  }

  function buildEntryMetricContext(
    entries: EntryPoolItemForLookup[]
  ): EntryMetricContext {
    return {
      accessibleEntryIds: new Set(entries.map((entry) => entry.id)),
      contextIndex: buildContextIndex(entries, extractExportedBinders)
    };
  }

  function computeEntryMetrics(
    snl: string | undefined,
    macroSources: SnlMacroSourceLookup,
    context: EntryMetricContext
  ): EntryMetricResult {
    if (typeof snl !== 'string' || snl.trim().length === 0) {
      return { kind: 'unavailable', reason: 'noContent' };
    }
    const parsed = tryParseSnlSyntaxTree(snl);
    if (!parsed.ok) {
      return {
        kind: 'unavailable',
        reason: 'parseError',
        error: parsed.error
      };
    }
    applyContextSrcLookup(parsed.tree, context.contextIndex);
    return {
      kind: 'ok',
      metrics: analyzeSnlStructuralIndex(
        parsed.tree,
        macroSources,
        context.accessibleEntryIds
      )
    };
  }

  function computeEntryMetricsForIds(
    entries: EntryPoolItemForLookup[],
    entryIds: Iterable<string>,
    macroSources: SnlMacroSourceLookup
  ): Map<string, EntryMetricResult> {
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const context = buildEntryMetricContext(entries);
    const results = new Map<string, EntryMetricResult>();
    for (const id of new Set(entryIds)) {
      const entry = entriesById.get(id);
      if (!entry) continue;
      results.set(
        id,
        computeEntryMetrics(entry.content?.snl, macroSources, context)
      );
    }
    return results;
  }

  return { analyzeSnlStructuralIndex, buildEntryMetricContext, computeEntryMetrics, computeEntryMetricsForIds };
}
