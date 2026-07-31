import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');

describe('SNL Structural Index settings', () => {
  it('exposes only the two color thresholds for the single displayed metric', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8')
    ) as {
      contributes: { configuration: { properties: Record<string, unknown> } };
    };
    const metricKeys = Object.keys(pkg.contributes.configuration.properties).filter(
      (key) => key.startsWith('snlDoc.metrics.')
    );

    expect(metricKeys).toEqual([
      'snlDoc.metrics.structuralIndexRedBelow',
      'snlDoc.metrics.structuralIndexGreenAtLeast'
    ]);
  });
});
