import { describe, expect, it } from 'vitest';
import type { SnlMacro } from '@sjtu-ai4math/snl-basics';
import { prerenderPopovers } from './popoverPrerender';

const macro: SnlMacro = {
  name: 'Type.judge',
  description: 'typing judgement',
  source: { entries: [], urls: [] },
  kind: 'rule',
  dynamic_arity: false,
  tags: [],
  styles: [{
    style_name: 'default',
    tags: [],
    template: { mode: 'formula_inline', body: '#0 : #1' }
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

  it('keeps source-backed Basics semantic nodes so recursive Entry references are discovered', async () => {
    const refMacro: SnlMacro = {
      name: 'Ref', description: 'Entry reference',
      source: { entries: ['grandchild'], urls: [] },
      kind: 'const', dynamic_arity: false, tags: [],
      styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '#0' } }]
    };
    const result = await prerenderPopovers('<span data-src="child">child</span>', {
      loadDetail: async (entryId) => entryId === 'child'
        ? {
            entry: {
              id: 'child', kind: 'definition', title: 'Child',
              content: { snl: 'Ref(x)' }, contribution_info: null, pointer: null
            },
            kind: null
          }
        : {
            entry: {
              id: 'grandchild', kind: 'definition', title: 'Grandchild',
              content: { text: 'Grandchild body' }, contribution_info: null, pointer: null
            },
            kind: null
          },
      entries: [
        { id: 'child', title: 'Child', hasContent: true, snl: 'Ref(x)' },
        { id: 'grandchild', title: 'Grandchild', hasContent: true }
      ],
      userMacros: { Ref: refMacro },
      timeoutMs: 1500
    });

    expect(Object.keys(result.fragments)).toEqual(['child', 'grandchild']);
    expect(result.fragments.child).toContain('data-src="grandchild"');
    expect(result.fragments.child).toContain('data-snl-keyboard-activation="true"');
    expect(result.fragments.grandchild).toContain('Grandchild body');
  });
});
