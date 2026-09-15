// @vitest-environment jsdom
// Real CLI persistence + production BrowserReader/Basics DOM. jsdom is NOT a geometry oracle.
import { createElement } from 'react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, cleanup, waitFor } from '@testing-library/react';
import { parseSnlSyntaxTree } from '@sjtu-ai4math/snl-basics/core';
// @ts-ignore JavaScript fixture generator shared with the browser harness.
import { authorInputs, createSvgEntryFixture, svgEntryReaderSnapshot } from '../scripts/svg-entry-integration-fixture.mjs';
import { indexLibraryGraph, readingOrder, numberAllForIndexed } from './libraryGraph';
import { BrowserReader } from '../webview/src/reader/BrowserReader';
import { get_content_language, set_content_language } from '../webview/src/runtime/preferencesRuntime';
import { harvestLibraryHtml } from '../webview/src/export/htmlExport';
import type { FrozenReaderSnapshot } from './sharedReaderSnapshot';

let fixture: any;
const authored = authorInputs();
const priorLanguage = get_content_language();
beforeAll(() => {
  fixture = createSvgEntryFixture({ log: process.env.SNL_FIXTURE_LOG });
}, 60000);
beforeEach(() => {
  const nativeRect = HTMLElement.prototype.getBoundingClientRect;
  // Explicit jsdom seam: only unblock the calibrated rule's positive-size admission.
  // These invented pixels are NOT measurement evidence; all rendering remains real.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.matches('.snlFormulaForeignMarker .rule')
      ? ({ x: 0, y: 0, left: 0, top: 0, width: 120, height: 50, right: 120, bottom: 50, toJSON: () => ({}) } as DOMRect)
      : nativeRect.call(this);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); set_content_language(priorLanguage); history.replaceState(null, '', '/'); });
function outline(f: any) {
  const graph = f.library.graph;
  const idx = indexLibraryGraph(graph);
  const entries = new Map<string, any>(f.entries.map((e: any) => [e.id, e]));
  const kinds = new Map<string, any>(f.entryKinds.map((k: any) => [k.id, k]));
  const numbers = numberAllForIndexed(idx, entries, kinds, f.library.counters.counters);
  // The authored graph has two roots, no branch edges. Assert before projection.
  expect(graph.relationships).toEqual([]);
  return readingOrder(graph).map(nodeId => {
    const entry = entries.get(idx.nodesById.get(nodeId)!.props.entryId!);
    if (!entry) throw new Error('Dangling fixture Entry');
    return { nodeId, entry, kind: kinds.get(entry.kind), counterLabel: numbers.get(nodeId), children: [] };
  });
}
function walk(tree: any): any[] { return [tree, ...tree.children.flatMap(walk)]; }

describe('SVG-CONS-1 complete author fixture', () => {
  it('round-trips every authored field through official create/get/validate, not legacy envelopes', () => {
    expect(fixture.validation.data).toMatchObject({ valid: true, issues: [] });
    expect(fixture.entries).toEqual(authored.entries);
    expect(Object.keys(fixture.macros).sort()).toEqual(['A', 'B', 'Left', 'Right', 'diagram', 'pair', 'wrap']);
    for (const value of authored.macros) expect(fixture.macros[value.name]).toEqual(value);
    expect(fixture.library).toEqual(authored.library);
    expect(fixture.entryKinds).toEqual(authored.entryKinds);
    expect(fixture.macroKinds).toEqual(authored.macroKinds);
    expect(fixture.package).toMatchObject({ ...authored.package, entry_ids: ['svg-primary', 'svg-reference'] });
    expect(fixture.config.active_macro_packages).toContain('svg-fixture');
    expect(fixture.entries.every((e: any) => e.package === authored.entryDefaultPackage)).toBe(true);
    expect(outline(fixture).map(n => [n.nodeId, n.entry.id, n.counterLabel])).toEqual([
      ['node.svg-primary', 'svg-primary', '1'], ['node.svg-reference', 'svg-reference', '2']
    ]);
    expect(fixture.library.counters.counters[0].count).toBe(2);
    const raw = readFileSync(resolve(fixture.root, '.SNL_Doc/assets/commutative-square.svg'));
    expect(fixture.resource.revision).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`);
    expect(raw.toString()).toBe(fixture.resource.text);
    expect(raw.toString().match(/data-snl-slot=/g)).toHaveLength(4);
    for (const language of ['en', 'zh-CN']) {
      const template = fixture.macros.diagram.styles[0].template.values[language];
      expect(template.block_template_name).toBe('svg_template');
      expect(template.svg_template).toMatchObject({
        asset: { source: 'commutative-square.svg', base_identity: 'workspace:.SNL_Doc/assets', revision: fixture.resource.revision, request_epoch: 1 },
        generation: 1, producer_revision: 'svg-entry-fixture-v1', formula_embed: { total_height_em: 3.2, baseline_ratio: 0.72 }
      });
    }
    const primary = walk(parseSnlSyntaxTree(fixture.entries[0].content.snl));
    const reference = walk(parseSnlSyntaxTree(fixture.entries[1].content.snl));
    expect(primary.map(n => n.macro_name)).toEqual(['pair', 'wrap', 'diagram', 'A', 'B', 'Left', 'Right', 'ref']);
    expect(primary.find(n => n.macro_name === 'ref').postfix).toMatchObject({ type: 'name', name: 'svg-reference' });
    expect(reference.map(n => n.macro_name)).toEqual(['diagram', 'B', 'A', 'Right', 'Left']);
    expect(fixture.macros.wrap.styles[0].template.body).toBe('x+#0=y');
  });

  it.each(['en', 'zh-CN'])('isolated subtree consumer DOM control: formula and block, language %s', async language => {
    const f = structuredClone({ ...fixture, run: undefined });
    // Opt-in independent mutation controls, only on this in-memory fixture copy.
    if (process.env.SNL_FIXTURE_MUTATION === 'field') f.macros.diagram.styles[0].template.values[language].svg_template.accessibility.label = 'lost label';
    if (process.env.SNL_FIXTURE_MUTATION === 'reference') f.entries[0].content.snl = f.entries[0].content.snl.replace('ref@svg-reference', 'ref@svg-primary');
    if (process.env.SNL_FIXTURE_MUTATION === 'slot') {
      f.resource.text = f.resource.text.replace('data-snl-slot="0"', 'data-snl-slot="9"').replace('data-snl-slot="1"', 'data-snl-slot="0"').replace('data-snl-slot="9"', 'data-snl-slot="1"');
      f.resource.revision = `sha256:${createHash('sha256').update(f.resource.text).digest('hex')}`;
      for (const t of Object.values(f.macros.diagram.styles[0].template.values) as any[]) t.svg_template.asset.revision = f.resource.revision;
    }
    const primary = parseSnlSyntaxTree(f.entries[0].content.snl);
    expect(walk(primary).find(n => n.macro_name === 'ref').postfix.name).toBe('svg-reference');
    // Diagnostic control only: render the original wrap subtree as a formula root.
    // Full unchanged Entry acceptance is tested separately below.
    f.entries[0].content.snl = 'wrap(diagram(A,B,Left,Right))';
    set_content_language(language);
    history.replaceState(null, '', '#/library');
    const snapshot = svgEntryReaderSnapshot(f, outline(f), language) as FrozenReaderSnapshot;
    const view = render(createElement(BrowserReader, { snapshot }));
    await waitFor(() => expect(view.container.querySelectorAll('.snl-svg-template-artwork')).toHaveLength(2), { timeout: 5000 });
    const label = language === 'en' ? 'Commutative square from A to B' : '从 A 到 B 的交换图';
    expect(view.container.textContent).toContain(language === 'en' ? 'Parameterized SVG in block and formula' : '块与公式中的参数化 SVG');
    expect(view.container.textContent).toContain('Referenced SVG entry');
    const artworks = [...view.container.querySelectorAll('.snl-svg-template-artwork')];
    for (const [index, artwork] of artworks.entries()) {
      const surface = artwork.closest('[aria-label]');
      expect(surface?.getAttribute('aria-label')).toBe(label);
      expect(artwork.querySelector('svg')?.getAttribute('viewBox') ?? artwork.getAttribute('viewBox')).toBe('0 0 240 100');
      const rect = artwork.querySelector('rect')!;
      expect([rect.getAttribute('x'), rect.getAttribute('y'), rect.getAttribute('width'), rect.getAttribute('height'), rect.getAttribute('rx'), rect.getAttribute('fill'), rect.getAttribute('stroke'), rect.getAttribute('stroke-width')]).toEqual(['2','2','236','96','10','none','#175cd3','4']);
      expect([...artwork.querySelectorAll('path')].map(p => [p.getAttribute('d'), p.getAttribute('stroke'), p.getAttribute('stroke-width'), p.getAttribute('fill')])).toEqual([['M55 40H185','currentColor','4',null], ['M173 30L189 40L173 50Z',null,null,'currentColor']]);
      const expected = index === 0 ? ['A','B','L','R'] : ['B','A','R','L'];
      const slots = [...artwork.querySelectorAll('[data-snl-slot]')];
      expect(slots.map(s => s.getAttribute('data-snl-slot'))).toEqual(['0','1','2','3']);
      expect(slots.map(s => s.getAttribute('transform'))).toEqual(['translate(18 18)','translate(198 18)','translate(70 54)','translate(145 54)']);
      // jsdom has no layout: child portals remain in staging/fallback, not in <g>.
      const host = artwork.closest('.snl-svg-template')!;
      for (const [i, value] of expected.entries()) {
        // Artwork mounts before asynchronous semantic slot children settle.
        // Keep every exact label oracle, but wait for that child's own readiness.
        await waitFor(() => {
          const portal = host.querySelector(`[data-snl-foreign-placement="svg-slot:${i}"]`);
          expect(portal?.textContent).toContain(value);
        }, { timeout: 5000 });
      }
    }
    expect(view.container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(5);
    expect(view.container.textContent).toContain('x'); expect(view.container.textContent).toContain('='); expect(view.container.textContent).toContain('y');
    expect(view.container.querySelector('.snl-svg-template-loading, .snl-svg-template-error')).toBeNull();
    const exported = harvestLibraryHtml(view.container, '');
    expect(exported.html).toContain('data-snl-slot="3"');
    expect(exported.html).toContain('M173 30L189 40L173 50Z');
    if (process.env.SNL_FIXTURE_DOM_PREFIX) {
      writeFileSync(`${process.env.SNL_FIXTURE_DOM_PREFIX}-${language}.html`, view.container.innerHTML);
      writeFileSync(`${process.env.SNL_FIXTURE_DOM_PREFIX}-${language}.snapshot.json`, JSON.stringify(snapshot, null, 2));
    }
    // Direct reference route is the same readback Entry, not a separate invented sample.
    act(() => { history.replaceState(null, '', '#/entry/svg-reference'); window.dispatchEvent(new Event('hashchange')); });
    // BrowserReader retains the Library while opening the Entry detail route.
    await waitFor(() => expect(view.container.querySelectorAll('.snl-svg-template-artwork')).toHaveLength(3));
    expect(history.state).toBeNull();
    expect(view.container.textContent).toContain('Referenced SVG entry');
  }, 20000);
  it.each(['formula', 'unexported reference'])('unchanged author Entry consumer contract: %s', async requirement => {
    const f = { ...fixture };
    history.replaceState(null, '', '#/library');
    const snapshot = svgEntryReaderSnapshot(f, outline(f), 'en') as FrozenReaderSnapshot;
    const view = render(createElement(BrowserReader, { snapshot }));
    await waitFor(() => expect(view.container.querySelector('[data-name="ref"]')).not.toBeNull());
    await waitFor(() => expect(view.container.querySelector('.snl-svg-template-artwork')).not.toBeNull());
    if (process.env.SNL_FIXTURE_DOM_PREFIX) {
      writeFileSync(`${process.env.SNL_FIXTURE_DOM_PREFIX}-unchanged.html`, view.container.innerHTML);
      writeFileSync(`${process.env.SNL_FIXTURE_DOM_PREFIX}-unchanged.snapshot.json`, JSON.stringify(snapshot, null, 2));
    }
    if (requirement === 'formula') {
      expect(view.container.querySelectorAll('.snl-svg-template-artwork')).toHaveLength(2);
      expect(view.container.textContent).not.toContain('cannot be used inside a formula');
    } else {
      // @entry is a binding source, not an arbitrary hyperlink. The complete
      // historical target exports no @ref binder. Keep the authored input and
      // require the current fail-closed fvar classification; do not fabricate a
      // Macro or binder merely to satisfy the earlier speculative link oracle.
      // Positive exported-binding activation is covered by EntryRenderRealClick.
      expect(f.entries[1].content.snl).toBe('diagram(B,A,Right,Left)');
      expect(view.container.querySelector('[data-name="ref"]')?.getAttribute('data-kind')).toBe('fvar');
      expect(view.container.querySelector('[data-name="ref"][role="button"], [data-src="svg-reference"]')).toBeNull();
    }
  });

});
