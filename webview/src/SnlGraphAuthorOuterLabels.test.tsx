import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';
const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async original => ({ ...(await original<typeof import('./vscodeApi')>()), useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api }));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
  nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, packageId: `package-${Math.floor(i / 3)}`, title: `Node ${i}`, kind: 'Theorem', kindId: 'theorem', coloring: null })),
  edges: Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, from: `n${i + 1}`, to: `n${i % 3}`, label: 'depends', isDependency: true, isAtomic: true }))
};
const control = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } });
const canvas = () => document.getElementById('snl-graph-background')!.closest('svg')!;
const labels = () => [...canvas().querySelectorAll<SVGTextElement>('[data-package-label]')];
const viewport = () => {
  const [x, y, scale] = canvas().querySelector(':scope > g[transform]')!.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
  return { x, y, scale };
};
beforeEach(() => {
  document.documentElement.lang = 'en';
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON() {} });
  // jsdom has no font metrics. A long measured advance makes horizontal fitting observable.
  Object.defineProperty(SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 240 });
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(SVGElement.prototype, 'getComputedTextLength'); Reflect.deleteProperty(SVGElement.prototype, 'getBBox'); document.documentElement.lang = ''; });

describe('screen-space outward Package labels', () => {
  it('aligns actual overhanging glyph boxes and does not accumulate corrections across refits', () => {
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: function(this: SVGElement) {
      const x = Number(this.getAttribute('x')) + Number(this.getAttribute('dx'));
      const y = Number(this.getAttribute('y')) + Number(this.getAttribute('dy'));
      const anchor = this.getAttribute('text-anchor'), baseline = this.getAttribute('dominant-baseline');
      return { x: x + (anchor === 'end' ? -240 : anchor === 'middle' ? -120 : 0) - .4,
        y: y + (baseline === 'text-after-edge' ? -14 : baseline === 'central' ? -7 : 0) - .2,
        width: 242, height: 14.4 };
    }});
    render(<SnlGraphApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: graph })));
    control('Layout', 'radial-outward');
    const check = () => {
      for (const label of labels()) {
        const b = label.getBBox(), x = Number(label.getAttribute('x')), y = Number(label.getAttribute('y'));
        const a = label.getAttribute('text-anchor'), d = label.getAttribute('dominant-baseline');
        expect(b.x + (a === 'end' ? b.width : a === 'middle' ? b.width / 2 : 0)).toBeCloseTo(x, 8);
        expect(b.y + (d === 'text-after-edge' ? b.height : d === 'central' ? b.height / 2 : 0)).toBeCloseTo(y, 8);
      }
    };
    check();
    const offsets = () => labels().map(e => [Number(e.getAttribute('dx')), Number(e.getAttribute('dy'))]);
    const before = offsets();
    for (let i = 0; i < 4; i++) { fireEvent.click(screen.getByTestId('graph-filter-toggle')); check();
      offsets().forEach((pair,j) => pair.forEach((n,k) => expect(n).toBeCloseTo(before[j][k],8))); }
    fireEvent.wheel(canvas(), { deltaY: 100, clientX: 350, clientY: 300 });check();
  });
  for (const mode of ['radial-inward', 'radial-outward']) for (const packing of ['bands', 'rings']) {
    it.each([undefined, 40])(`${mode}/${packing} stays horizontal at the exact screen anchor and fixed-size on pan/zoom (measured height %s)`, measuredHeight => {
      if (measuredHeight) Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ height: measuredHeight }) });
      render(<SnlGraphApp />);
      act(() => window.dispatchEvent(new MessageEvent('message', { data: graph })));
      fireEvent.click(screen.getByTestId('graph-filter-toggle'));
      control('Layer packing', packing); control('Layout', mode);
      const positions = () => [...canvas().querySelectorAll('[data-node-id]')].map(n => n.getAttribute('transform'));
      const before = positions();
      const check = (fitted: boolean) => {
        const vp = viewport();
        const anchors = labels().map(label => label.getAttribute('text-anchor'));
        expect(anchors).toContain('start'); expect(anchors).toContain('end');
        for (const label of labels()) {
          const [wx, wy] = label.getAttribute('data-world-anchor')!.split(',').map(Number);
          const x = Number(label.getAttribute('x')), y = Number(label.getAttribute('y'));
          expect(x).toBeCloseTo(vp.x + wx * vp.scale, 9); expect(y).toBeCloseTo(vp.y + wy * vp.scale, 9);
          expect(label.getAttribute('font-size')).toBe('12');
          expect(label.parentElement!.closest('[transform]')).toBeNull();
          expect(label.style.transform).toBe('');
          expect(label.getAttribute('transform')).toBeNull();
          const origin = JSON.parse(canvas().getAttribute('data-radial-center')!);
          const outwardAngle = Math.atan2(wy - origin.y, wx - origin.x);
          const cos = Math.cos(outwardAngle), sin = Math.sin(outwardAngle);
          const textAnchor = Math.abs(cos) < 1e-10 ? 'middle' : cos < 0 ? 'end' : 'start';
          const baseline = Math.abs(sin) < 1e-10 ? 'central' : sin < 0 ? 'text-after-edge' : 'text-before-edge';
          expect(label.getAttribute('text-anchor')).toBe(textAnchor);
          expect(label.getAttribute('dominant-baseline')).toBe(baseline);
          const sector = canvas().querySelector(`[data-package-id="${label.getAttribute('data-package-label')}"] path`)!;
          const values = sector.getAttribute('d')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
          const radius = values[2];
          expect(Math.hypot(wx - origin.x, wy - origin.y)).toBeCloseTo(radius, 7);
          // Both outer-arc endpoints must be on this same circle;
          // the two ends are equidistant from the bisector anchor.
          expect(Math.hypot(values[0] - origin.x, values[1] - origin.y)).toBeCloseTo(radius, 7);
          expect(Math.hypot(values[7] - origin.x, values[8] - origin.y)).toBeCloseTo(radius, 7);
          const left = textAnchor === 'middle' ? -122 : textAnchor === 'end' ? -244 : 0;
          const h = measuredHeight ?? 18;
          const top = baseline === 'central' ? -h / 2 : baseline === 'text-after-edge' ? -h : 0;
          for (const dx of [left, left + 244]) for (const dy of [top, top + h]) {
            expect(dx * Math.cos(outwardAngle) + dy * Math.sin(outwardAngle)).toBeGreaterThanOrEqual(-1e-9);
            if (fitted) {
              expect(x + dx).toBeGreaterThanOrEqual(20 - 1e-5); expect(x + dx).toBeLessThanOrEqual(880 + 1e-5);
              expect(y + dy).toBeGreaterThanOrEqual(20 - 1e-5); expect(y + dy).toBeLessThanOrEqual(680 + 1e-5);
            }
          }
        }
      };
      check(true);
      for (const deltaY of [100, 100, -100]) { fireEvent.wheel(canvas(), { deltaY, clientX: 350, clientY: 300 }); check(false); }
      const prior = viewport();
      fireEvent.pointerDown(canvas(), { clientX: 300, clientY: 300 });
      fireEvent.pointerMove(canvas(), { clientX: 337, clientY: 281 });
      fireEvent.pointerUp(canvas(), { clientX: 337, clientY: 281 });
      expect(viewport().x).toBeCloseTo(prior.x + 37); expect(viewport().y).toBeCloseTo(prior.y - 19);
      check(false); expect(positions()).toEqual(before);
      control('Layout', 'rectangle');
      for (const label of labels()) {
        expect(label.style.transform).toBe(''); expect(label.getAttribute('text-anchor')).toBeNull();
        expect(label.getAttribute('dominant-baseline')).toBeNull();
      }
    });
  }
});
