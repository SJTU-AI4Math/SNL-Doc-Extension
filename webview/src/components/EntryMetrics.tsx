import React from 'react';
import { isEntryMetricResult, type CachedEntryMetrics } from '../../../src/cachedEntryMetrics';
import { tryParseSnlSyntaxTree, extractExportedBinders } from '@sjtu-ai4math/snl-basics/core';
import { resolveSnlSemantics } from '@sjtu-ai4math/snl-basics';
import { createSsiEngine, type EntryMetricResult, type SnlStructuralMetrics } from '../../../src/ssiMetrics';
export { countSnlSemanticTokens, snlNodeLengthWeight, type EntryMetricResult, type SnlStructuralMetrics, type EntryMetricContext, type SnlMacroSourceLookup } from '../../../src/ssiMetrics';
export const { analyzeSnlStructuralIndex, buildEntryMetricContext, computeEntryMetrics, computeEntryMetricsForIds } = createSsiEngine({ tryParseSnlSyntaxTree, extractExportedBinders, resolveSnlSemantics });
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
const MESSAGES = defineUiMessages(
  'entryMetrics',
  {
    global: 'Global SSI', globalUnavailable: 'Global SSI unavailable',
    noContent: 'This entry has no SNL content.', parseError: 'Cannot compute metrics because the SNL tree does not parse: {error}',
    index: 'SNL Structural Index: {value}', strong: 'Strong semantic freedom: {value}',
    weak: 'Weak semantic freedom: {value}', weightedStrong: 'Weighted strong freedom: {value}',
    weightedWeak: 'Weighted weak freedom: {value}', weightedTotal: 'Weighted total: {value}'
  },
  {
    global: '全局 SSI', globalUnavailable: '全局 SSI 不可用',
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

/** Saved metrics only. A missing/frozen-local payload must never look global. */
export function CachedEntryMetricValue({ entryId, cachedEntryMetrics }: {
  entryId: string; cachedEntryMetrics?: CachedEntryMetrics;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const cache = cachedEntryMetrics?.scope === 'workspace' ? cachedEntryMetrics : undefined;
  const result = cache?.status === 'ready' && Object.hasOwn(cache.entries, entryId) ? cache.entries[entryId] : undefined;
  return <span data-snl-cached-entry-metrics={entryId} title={t('global')}>
    {isEntryMetricResult(result) ? <EntryMetricValue result={result} metric="structuralIndex" thresholds={DEFAULT_ENTRY_METRIC_THRESHOLDS} compact />
      : <span style={{ opacity: 0.5 }} title={cache?.status === 'unavailable' ? cache.error : undefined}>{t('globalUnavailable')}</span>}
  </span>;
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
