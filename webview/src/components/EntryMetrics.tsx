import React from 'react';
import {
  tryParseSnlSyntaxTree,
  resolveSnlSemantics,
  type SnlMacroSourceLookup,
  type SnlSyntaxTree
} from '@sjtu-ai4math/snl-basics/core';
import {
  applyContextSrcLookup,
  buildContextIndex,
  type EntryPoolItemForLookup
} from '../render/contextSrcLookup';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'entryMetrics',
  {
    noContent: 'This entry has no SNL content.', parseError: 'Cannot compute metrics because the SNL tree does not parse: {error}',
    index: 'SNL Structural Index: {value}', strong: 'Strong semantic freedom: {value}',
    weak: 'Weak semantic freedom: {value}', weightedStrong: 'Weighted strong freedom: {value}',
    weightedWeak: 'Weighted weak freedom: {value}', weightedTotal: 'Weighted total: {value}'
  },
  {
    noContent: '此条目没有 SNL 内容。', parseError: '无法计算指标，因为 SNL 树解析失败：{error}',
    index: 'SNL 结构索引：{value}', strong: '强语义自由度：{value}',
    weak: '弱语义自由度：{value}', weightedStrong: '加权强自由度：{value}',
    weightedWeak: '加权弱自由度：{value}', weightedTotal: '加权总量：{value}'
  }
);

export interface EntryMetricThresholds {
  structuralIndexRedBelow: number;
  structuralIndexGreenAtLeast: number;
}

export const DEFAULT_ENTRY_METRIC_THRESHOLDS: EntryMetricThresholds = {
  structuralIndexRedBelow: 60,
  structuralIndexGreenAtLeast: 80
};

export type EntryMetricResult =
  | { kind: 'ok'; metrics: SnlStructuralMetrics }
  | { kind: 'unavailable'; reason: 'noContent' }
  | { kind: 'unavailable'; reason: 'parseError'; error: string };

export interface SnlStructuralMetrics {
  /** Unsourced non-catalog nodes, excluding numeric literals. */
  weakSemanticFreedom: number;
  /** Weak freedom plus catalog macros whose source cannot be resolved. */
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

function semanticPayload(node: SnlSyntaxTree): string {
  return typeof node.temporary_source === 'string' ? node.temporary_source : node.macro_name;
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
    semanticPayload(node).trim()
  );
}

function isCatalogConstant(
  node: SnlSyntaxTree,
  macroLookup: SnlMacroSourceLookup
): boolean {
  const meta = nodeMetadata(node);
  const explicitSrc = node.source?.type === 'entry'
    ? node.source.entry_id
    : node.postfix?.type === 'name'
      ? node.postfix.name
      : typeof meta.src === 'string' ? meta.src : '';
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
  const treeSource = node.source?.type === 'tree_path';
  const bindRef = typeof meta.bindRef === 'string' ? meta.bindRef : '';
  const src = node.source?.type === 'entry'
    ? node.source.entry_id
    : node.postfix?.type === 'name'
      ? node.postfix.name
      : typeof meta.src === 'string' ? meta.src : '';
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

  if (
    node.kind === 'bvar' &&
    (treeSource || bindRef.length > 0) &&
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
 * A known macro with an unresolved source affects strong freedom only; an
 * unknown node affects both. Numeric literals are assumed semantically clear
 * and are excluded from both weighted numerator and denominator.
 */
export function analyzeSnlStructuralIndex(
  root: SnlSyntaxTree,
  macroLookup: SnlMacroSourceLookup,
  accessibleEntryIds: ReadonlySet<string>
): SnlStructuralMetrics {
  const resolvedRoot = resolveSnlSemantics(root, macroLookup as never).tree;
  const binderNames = new Set<string>();
  const collectBinders = (node: SnlSyntaxTree): void => {
    if (node.kind === 'binder') binderNames.add(node.macro_name);
    for (const child of node.children) collectBinders(child);
  };
  collectBinders(resolvedRoot);

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
      const weight = lengthExempt ? 1 : snlNodeLengthWeight(semanticPayload(node));
      weightedTotal += weight;

      if (!sourced) {
        strongSemanticFreedom += 1;
        weightedStrongSemanticFreedom += weight;
        if (!catalogConstant) {
          weakSemanticFreedom += 1;
          weightedWeakSemanticFreedom += weight;
        }
      }
    }

    for (const child of node.children) walk(child);
  };
  walk(resolvedRoot);

  const structuralIndex =
    weightedTotal === 0
      ? 1
      : Math.min(
          1,
          Math.max(0, 1 - weightedStrongSemanticFreedom / weightedTotal)
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

export interface EntryMetricContext {
  accessibleEntryIds: ReadonlySet<string>;
  contextIndex: Map<string, Set<string>>;
}

export function buildEntryMetricContext(
  entries: EntryPoolItemForLookup[]
): EntryMetricContext {
  return {
    accessibleEntryIds: new Set(entries.map((entry) => entry.id)),
    contextIndex: buildContextIndex(entries)
  };
}

export function computeEntryMetrics(
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
  const tree = parsed.tree;
  applyContextSrcLookup(tree, context.contextIndex);
  return {
    kind: 'ok',
    metrics: analyzeSnlStructuralIndex(
      tree,
      macroSources,
      context.accessibleEntryIds
    )
  };
}

export function computeEntryMetricsForIds(
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

type MetricKind = 'structuralIndex';

function metricColor(
  _kind: MetricKind,
  metrics: SnlStructuralMetrics,
  thresholds: EntryMetricThresholds
): string {
  const percent = metrics.structuralIndex * 100;
  if (percent < thresholds.structuralIndexRedBelow) {
    return 'var(--vscode-errorForeground, #f48771)';
  }
  if (percent >= thresholds.structuralIndexGreenAtLeast) {
    return 'var(--vscode-testing-iconPassed, #3fb950)';
  }
  return 'var(--vscode-editorWarning-foreground, #cca700)';
}

export function EntryMetricValue({
  result,
  metric,
  thresholds,
  compact = false
}: {
  result: EntryMetricResult;
  metric: MetricKind;
  thresholds: EntryMetricThresholds;
  compact?: boolean;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  if (result.kind === 'unavailable') {
    const reason = result.reason === 'noContent'
      ? t('noContent')
      : t('parseError', { error: result.error });
    return (
      <span title={reason} style={{ opacity: 0.5 }}>
        —
      </span>
    );
  }

  const { metrics } = result;
  const value = metrics.structuralIndex.toFixed(2);
  const displayedValue = compact ? `SSI ${value}` : value;
  const tooltip = [
    t('index', { value }),
    t('strong', { value: metrics.strongSemanticFreedom }),
    t('weak', { value: metrics.weakSemanticFreedom }),
    t('weightedStrong', { value: metrics.weightedStrongSemanticFreedom.toFixed(2) }),
    t('weightedWeak', { value: metrics.weightedWeakSemanticFreedom.toFixed(2) }),
    t('weightedTotal', { value: metrics.weightedTotal.toFixed(2) })
  ].join('\n');
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: compact ? '2.2rem' : '2.8rem',
        padding: compact ? '0.05rem 0.3rem' : '0.08rem 0.4rem',
        borderRadius: '3px',
        border: `1px solid ${metricColor(metric, metrics, thresholds)}`,
        color: metricColor(metric, metrics, thresholds),
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: compact ? '0.72rem' : '0.82rem',
        fontWeight: 600,
        lineHeight: 1.2
      }}
    >
      {displayedValue}
    </span>
  );
}

export type { SnlMacroSourceLookup };
