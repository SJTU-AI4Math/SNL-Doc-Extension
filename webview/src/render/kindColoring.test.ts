import { describe, expect, it } from 'vitest';
import { apply_preferences_snapshot } from '../runtime/preferencesRuntime';
import { resolveWebviewKindColoring } from './kindColoring';

const coloring = {
  light: { stroke: '#111111', background: '#eeeeee' },
  dark: { stroke: '#dddddd', background: '#222222' }
};

describe('resolveWebviewKindColoring', () => {
  it('selects the live theme variant through the SNL-Basics resolver', () => {
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'kind-resolver', revision: 1,
      preferences: { language: 'en', color_scheme: 'light', motion: 'full' }
    });
    expect(resolveWebviewKindColoring(coloring)).toEqual(coloring.light);
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'kind-resolver', revision: 2,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' }
    });
    expect(resolveWebviewKindColoring(coloring)).toEqual(coloring.dark);
  });
});
