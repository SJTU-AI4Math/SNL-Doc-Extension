import { describe, expect, it } from 'vitest';
import { prepareKindPresetApplication } from './kindPresetApplication';

const presets = [{
  id: 'lean4-document',
  kinds: [{
    id: 'module',
    name: { type: 'i18n', default_language: 'en', values: { en: 'Module', 'zh-CN': '模块' } },
    description: { type: 'i18n', default_language: 'en', values: { en: 'Groups declarations.', 'zh-CN': '组织声明。' } },
    coloring: {
      light: { stroke: '#475569', background: '#f1f5f9' },
      dark: { stroke: '#94a3b8', background: '#1e293b' }
    },
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
    expect(result.kinds[0].coloring.light).not.toBe(presets[0].kinds[0].coloring.light);
    expect(result.kinds[0].coloring.dark).not.toBe(presets[0].kinds[0].coloring.dark);
    expect(result.kinds[0].name).toEqual(presets[0].kinds[0].name);
    expect(result.kinds[0].name).not.toBe(presets[0].kinds[0].name);
    expect(result.kinds[0].description).not.toBe(presets[0].kinds[0].description);
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
