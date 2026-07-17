import React from 'react';
import {
  analyzeSnlTreeSources,
  tryParseSnlSyntaxTree,
  type SnlMacroSourceLookup,
  type SnlSourceMetrics
} from '@snl-basics/react';

export interface EntryMetricThresholds {
  semanticFreedomGreenBelow: number;
  semanticFreedomRedAbove: number;
  structuredRatioRedBelow: number;
  structuredRatioGreenAtLeast: number;
}

export const DEFAULT_ENTRY_METRIC_THRESHOLDS: EntryMetricThresholds = {
  semanticFreedomGreenBelow: 3,
  semanticFreedomRedAbove: 5,
  structuredRatioRedBelow: 60,
  structuredRatioGreenAtLeast: 80
};

export type EntryMetricResult =
  | { kind: 'ok'; metrics: SnlSourceMetrics }
  | { kind: 'unavailable'; reason: string };

export function computeEntryMetrics(
  snl: string | undefined,
  macroSources: SnlMacroSourceLookup,
  entryIds: ReadonlySet<string>
): EntryMetricResult {
  if (typeof snl !== 'string' || snl.trim().length === 0) {
    return { kind: 'unavailable', reason: 'This entry has no SNL content.' };
  }
  const parsed = tryParseSnlSyntaxTree(snl);
  if (!parsed.ok) {
    return {
      kind: 'unavailable',
      reason: `Cannot compute metrics because the SNL tree does not parse: ${parsed.error}`
    };
  }
  return {
    kind: 'ok',
    metrics: analyzeSnlTreeSources(parsed.tree, macroSources, entryIds)
  };
}

type MetricKind = 'semanticFreedom' | 'structuredRatio';

function metricColor(
  kind: MetricKind,
  metrics: SnlSourceMetrics,
  thresholds: EntryMetricThresholds
): string {
  if (kind === 'semanticFreedom') {
    if (metrics.semanticFreedom < thresholds.semanticFreedomGreenBelow) {
      return 'var(--vscode-testing-iconPassed, #3fb950)';
    }
    if (metrics.semanticFreedom > thresholds.semanticFreedomRedAbove) {
      return 'var(--vscode-errorForeground, #f48771)';
    }
    return 'var(--vscode-editorWarning-foreground, #cca700)';
  }

  const percent = metrics.structuredRatio * 100;
  if (percent < thresholds.structuredRatioRedBelow) {
    return 'var(--vscode-errorForeground, #f48771)';
  }
  if (percent >= thresholds.structuredRatioGreenAtLeast) {
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
  if (result.kind === 'unavailable') {
    return (
      <span title={result.reason} style={{ opacity: 0.5 }}>
        —
      </span>
    );
  }

  const { metrics } = result;
  const value =
    metric === 'semanticFreedom'
      ? String(metrics.semanticFreedom)
      : metrics.structuredRatio.toFixed(2);
  const label = metric === 'semanticFreedom' ? 'Semantic freedom' : 'Structured ratio';
  const displayedValue = compact
    ? `${metric === 'semanticFreedom' ? 'F' : 'S'} ${value}`
    : value;
  return (
    <span
      title={`${label}: ${value} (${metrics.sourcedNodes}/${metrics.totalNodes} sourced nodes)`}
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
