import { describe, expect, it } from 'vitest';
import type { SnlMacro } from '@sjtu-ai4math/snl-basics';
import { prerenderPopovers } from './popoverPrerender';

const macro: SnlMacro = {
  name: 'Type.judge',
  description: 'typing judgement',
  source: { entries: [], urls: [] },
  kind: 'rule',
  dynamic_arity: false,
  default_style: { en: 'default' },
  tags: [],
  styles: [{
    style_name: 'default',
    mode: 'formula_inline',
    template: '#0 : #1',
    tags: []
  }]
};

describe('popover pre-render macro settling', () => {
  it('harvests the final macro-resolved frame, not the initial fvar fallback', async () => {
    const result = await prerenderPopovers(
      '<span data-src="ctx">T</span>',
      {
        loadDetail: async () => ({
          entry: {
            id: 'ctx',
            kind: 'context',
            title: 'Context -- $T$',
            content: { snl: 'Type.judge(T,Type)' },
            contribution_info: null,
            pointer: null
          },
          kind: null
        }),
        entries: [{ id: 'ctx', title: 'Context', hasContent: true, snl: 'Type.judge(T,Type)' }],
        userMacros: { 'Type.judge': macro },
        timeoutMs: 1500
      }
    );

    const html = result.fragments.ctx;
    expect(html).toContain('kind=rule');
    expect(html).toContain('}{T} : \\htmlData');
    expect(html).not.toContain('Type.judge(\\htmlData');
  });
});
