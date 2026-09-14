// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultHighlightStrategy } from '@sjtu-ai4math/snl-basics';
import { createAnnotationHighlightStrategy } from './annotationHighlight';
import type { MacroRecord } from './macroData';

const macros: MacroRecord = {
  'Type.annotation': { name: 'Type.annotation', description: '', source: { entries: [], urls: [] },
    dynamic_arity: false, tags: [], styles: [
      { style_name: 'nameless', tags: [], template: { mode: 'formula_inline', body: '#1' } },
      { style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '#0 : #1' } }
    ] }
};
const snl = 'root(Type.annotation[nameless](@x,T),x@#0.0)';
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture(binderVisible = false) {
  const container = document.createElement('div');
  const panel = document.createElement('div');
  panel.className = 'katex-panel';
  container.className = 'katex-html';
  panel.append(container);
  container.innerHTML = '<span data-kind="binder" data-tree-path="0.0"></span><span data-tree-path="0.1">T</span><span data-kind="bvar" data-tree-path="1" data-source-path="0.0">x</span>';
  document.body.append(panel);
  const [binder, domain, target] = [...container.children] as HTMLElement[];
  for (const element of [binder, domain, target]) {
    vi.spyOn(element, 'getClientRects').mockReturnValue((element === binder && !binderVisible ? [] : [{ width: 10, height: 10 }]) as unknown as DOMRectList);
  }
  return { container, panel, binder, domain, target };
}
function compute(source = snl, catalog = macros, visible = false, phase: 0 | 1 | 2 = 2) {
  const f = fixture(visible);
  const strategy = createAnnotationHighlightStrategy(source, catalog, 'en');
  return { ...f, result: strategy.computeHighlightSet(f.target, f.container, new Map(), phase) };
}
describe('explicit published annotation presentation only', () => {
  it('adds the visible domain without changing source identity or base buckets', () => {
    const f = compute();
    expect(f.result.binderDecl).toContain(f.domain);
    expect(f.target.dataset.sourcePath).toBe('0.0');
    const base = defaultHighlightStrategy.computeHighlightSet(f.target, f.container, new Map(), 2);
    expect(f.result.singleHover).toBe(base.singleHover);
    expect(f.result.bvarScope).toEqual(base.bvarScope);
  });
  it.each([
    'root(Other[nameless](@x,T),x@#0.0)',
    'root(Type.annotation[default](@x,T),x@#0.0)',
    'root(Type.annotation(@x,T),x@#0.0)',
    'root(Type.annotation[nameless](x,T),x@#0.0)',
    'root(Type.annotation[nameless](@x),x@#0.0)',
    'Type.annotation[nameless]('
  ])('does not infer authority from %s', source => {
    expect(compute(source).result.binderDecl.some(e => e.dataset.treePath === '0.1')).toBe(false);
  });
  it('checks the selected actual template, not the style name alone', () => {
    const changed = structuredClone(macros);
    changed['Type.annotation'].styles[0].template = { mode: 'formula_inline', body: '#0 : #1' };
    expect(compute(snl, changed).result.binderDecl.some(e => e.dataset.treePath === '0.1')).toBe(false);
    expect(compute(snl, {}).result.binderDecl.some(e => e.dataset.treePath === '0.1')).toBe(false);
  });
  it('leaves an explicit visible binder to the base policy', () => {
    const f = compute(snl, macros, true);
    expect(f.result.binderDecl).toEqual([f.binder]);
  });
  it('does not add a declaration in phase zero', () => {
    expect(compute(snl, macros, false, 0).result.binderDecl).toEqual([]);
  });
  it('does not borrow a domain from a sibling or nested surface', () => {
    const a = fixture(), b = fixture();
    a.domain.remove();
    a.container.append(b.panel);
    const strategy = createAnnotationHighlightStrategy(snl, macros, 'en');
    expect(strategy.computeHighlightSet(a.target, a.container, new Map()).binderDecl).not.toContain(b.domain);
    expect(strategy.computeHighlightSet(b.target, a.container, new Map()).binderDecl).not.toContain(b.domain);
    b.panel.remove(); document.body.append(b.panel);
    expect(strategy.computeHighlightSet(a.target, a.container, new Map()).binderDecl).not.toContain(b.domain);
  });
  it('requires a visible domain anchor', () => {
    const f = fixture(); f.domain.style.visibility = 'hidden';
    const strategy = createAnnotationHighlightStrategy(snl, macros, 'en');
    expect(strategy.computeHighlightSet(f.target, f.container, new Map()).binderDecl).not.toContain(f.domain);
  });
});
