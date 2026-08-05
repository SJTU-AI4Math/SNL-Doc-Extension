// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EntryMetricValue,
  type EntryMetricResult,
  type EntryMetricThresholds
} from './EntryMetrics';

const thresholds: EntryMetricThresholds = {
  structuralIndexRedBelow: 60,
  structuralIndexGreenAtLeast: 80
};

const result: EntryMetricResult = {
  kind: 'ok',
  metrics: {
    weakSemanticFreedom: 1,
    strongSemanticFreedom: 2,
    weightedTotal: 4,
    weightedWeakSemanticFreedom: 1,
    weightedStrongSemanticFreedom: 2,
    structuralIndex: 0.5
  }
};

afterEach(cleanup);
beforeEach(() => { document.documentElement.lang = 'en'; });

describe('SNL Structural Index display', () => {
  it('shows one index and keeps raw strong/weak freedom in the tooltip', () => {
    render(
      <EntryMetricValue
        result={result}
        metric="structuralIndex"
        thresholds={thresholds}
      />
    );

    const value = screen.getByText('0.50');
    expect(value.getAttribute('title')).toContain('SNL Structural Index: 0.50');
    expect(value.getAttribute('title')).toContain('Strong semantic freedom: 2');
    expect(value.getAttribute('title')).toContain('Weak semantic freedom: 1');
  });

  it('localizes metric tooltips and unavailable reasons in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(
      <>
        <EntryMetricValue result={result} metric="structuralIndex" thresholds={thresholds} />
        <EntryMetricValue result={{ kind: 'unavailable', reason: 'noContent' }} metric="structuralIndex" thresholds={thresholds} />
      </>
    );
    expect(view.getByText('0.50').getAttribute('title')).toContain('SNL 结构索引：0.50');
    expect(view.getByText('—').getAttribute('title')).toBe('此条目没有 SNL 内容。');
  });
});
