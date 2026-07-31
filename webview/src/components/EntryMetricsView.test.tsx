// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
});
