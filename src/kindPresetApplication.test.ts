import { describe, expect, it } from 'vitest';
import { prepareKindPresetApplication } from './kindPresetApplication';

const presets = [{
  id: 'lean4-document',
  kinds: [{
    id: 'module', name: 'Module',
    coloring: { light: { stroke: '#475569', background: '#f1f5f9' }, dark: { stroke: '#94a3b8', background: '#0f172a' } },
    defaultCounterName: 'module', style: 'section'
  }]
}];

describe('prepareKindPresetApplication', () => {
  it('returns cloned kinds only for an empty catalog', () => {
    const result = prepareKindPresetApplication(presets, 'lean4-document', []);
    expect(result).toMatchObject({ status: 'applied', kinds: presets[0].kinds });
    if (result.status !== 'applied') throw new Error('expected applied');
    expect(result.kinds).not.toBe(presets[0].kinds);
    expect(result.kinds[0]).not.toBe(presets[0].kinds[0]);
    expect(result.kinds[0].coloring).not.toBe(presets[0].kinds[0].coloring);
  });

  it('refuses to clobber a non-empty catalog', () => {
    expect(prepareKindPresetApplication(presets, 'lean4-document', [{ id: 'existing' }]))
      .toEqual({ status: 'nonEmpty', existing: 1 });
  });

  it('rejects an unknown preset id', () => {
    expect(prepareKindPresetApplication(presets, 'missing', []))
      .toEqual({ status: 'unknownPreset', presetId: 'missing' });
  });
});
