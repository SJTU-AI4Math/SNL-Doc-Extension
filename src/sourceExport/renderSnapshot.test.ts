import { describe, expect, it } from 'vitest';
import { assertRenderSnapshot, renderDependencyId } from './renderSnapshot';

describe('export render snapshot authority', () => {
  const base = { entries: [{ id: 'E', pointer: { mode: 'lines', file: 'E.lean', line: 1 }, content: { markdown: { default: 'en', en: 'A', 'zh-CN': '甲' } } }], macros: { f: { styles: ['a'] } }, config: { languages: ['en', 'zh-CN'] } };
  it('binds non-initial locales, pointers, macros and config, independent of key ordering', () => {
    const id = renderDependencyId(base);
    expect(renderDependencyId({ config: base.config, macros: base.macros, entries: base.entries })).toBe(id);
    for (const mutate of [
      (v: typeof base) => { v.entries[0].content.markdown['zh-CN'] = '乙'; },
      (v: typeof base) => { v.entries[0].pointer.line = 2; },
      (v: typeof base) => { v.macros.f.styles[0] = 'b'; },
      (v: typeof base) => { v.config.languages.push('fr'); }
    ]) {
      const changed = structuredClone(base); mutate(changed);
      expect(() => assertRenderSnapshot(id, changed)).toThrow('dependencies changed');
    }
    expect(() => assertRenderSnapshot(id, base)).not.toThrow();
  });
});
