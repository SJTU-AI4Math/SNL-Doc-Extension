import * as vscode from 'vscode';

export interface EntryMetricThresholds {
  /** SNL Structural Index percentages below this are red. */
  structuralIndexRedBelow: number;
  /** Index percentages at or above this are green; the middle band is orange. */
  structuralIndexGreenAtLeast: number;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readEntryMetricThresholds(): EntryMetricThresholds {
  const config = vscode.workspace.getConfiguration('snlDoc.metrics');
  const structuralIndexRedBelow = Math.min(
    100,
    Math.max(0, finiteNumber(config.get('structuralIndexRedBelow'), 60))
  );
  const structuralIndexGreenAtLeast = Math.min(
    100,
    Math.max(
      structuralIndexRedBelow,
      finiteNumber(config.get('structuralIndexGreenAtLeast'), 80)
    )
  );
  return {
    structuralIndexRedBelow,
    structuralIndexGreenAtLeast
  };
}
