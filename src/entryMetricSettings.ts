import * as vscode from 'vscode';

export interface EntryMetricThresholds {
  /** Semantic freedom values below this are green. */
  semanticFreedomGreenBelow: number;
  /** Semantic freedom values above this are red; the middle band is orange. */
  semanticFreedomRedAbove: number;
  /** Structured percentages below this are red. */
  structuredRatioRedBelow: number;
  /** Structured percentages at or above this are green; the middle band is orange. */
  structuredRatioGreenAtLeast: number;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readEntryMetricThresholds(): EntryMetricThresholds {
  const config = vscode.workspace.getConfiguration('snlDoc.metrics');
  const semanticFreedomGreenBelow = Math.max(
    0,
    finiteNumber(config.get('semanticFreedomGreenBelow'), 3)
  );
  const semanticFreedomRedAbove = Math.max(
    semanticFreedomGreenBelow,
    finiteNumber(config.get('semanticFreedomRedAbove'), 5)
  );
  const structuredRatioRedBelow = Math.min(
    100,
    Math.max(0, finiteNumber(config.get('structuredRatioRedBelow'), 60))
  );
  const structuredRatioGreenAtLeast = Math.min(
    100,
    Math.max(
      structuredRatioRedBelow,
      finiteNumber(config.get('structuredRatioGreenAtLeast'), 80)
    )
  );
  return {
    semanticFreedomGreenBelow,
    semanticFreedomRedAbove,
    structuredRatioRedBelow,
    structuredRatioGreenAtLeast
  };
}
