import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserReader } from './BrowserReader';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const alpha = { id: 'Alpha', package: 'P', kind: 'lemma', title: 'Alpha title', content: { snl: 'symbol' }, pointer: null };
const beta = { id: 'Beta', package: 'P', kind: 'definition', title: 'Beta title', content: { markdown: 'Frozen source body' }, pointer: null };
const snapshot: FrozenReaderSnapshot = {
  version: 1, renderSnapshotId: 'discovery-test',
  library: { slug: 'L', title: 'Library', warnings: [], outline: [{ nodeId: 'second', entry: alpha, kind: null, counterLabel: null, children: [] }] },
  entries: [alpha, beta], entryKinds: [], entryPackages: { Alpha: 'P', Beta: 'P' },
  macros: { symbol: { name: 'symbol', kind: 'symbol', description: '', dynamic_arity: false, tags: [], source: { entries: ['Beta', 'not-exported'], urls: [] }, styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: '\\alpha' } }] } },
  macroKinds: [], relationships: [
    { id: 'manual', from: 'Alpha', to: 'Beta', label: 'explains', metadata: { note: 'unknown' } },
    { id: 'derived', from: 'Beta', to: 'Alpha', label: 'depends', metadata: { generator: 'macro-source-scan', isAtomic: false } }
  ],
  preferences: { language: 'en', color_scheme: 'light', motion: 'reduced' }, contentLanguage: 'en',
  languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }], resources: {}
};
let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear(); history.replaceState(null, '', '#/library');
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = async (hash: string) => { history.replaceState(null, '', hash); await act(async () => root.render(<BrowserReader snapshot={snapshot} />)); };
const click = async (node: Element | null, ctrlKey = false) => { expect(node).not.toBeNull(); await act(async () => node!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey }))); };
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); }); };
const input = async (node: HTMLInputElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); await settle(); };
const visibleMain = () => Array.from(element.querySelectorAll('main')).find(node => !node.closest('[hidden]'))!;

it('reads a Macro through real preview and exposes only exported source Entry navigation', async () => {
  await mount('#/search?mode=macro&counterpart=Beta');
  await click(visibleMain().querySelector('[role="option"]'));
  expect(location.hash).toContain('#/macro/symbol');
  expect(visibleMain().querySelector('[data-macro-preview="symbol"] .katex')).not.toBeNull();
  expect(visibleMain().textContent).toContain('Read-only Macro preview');
  const sourceLink = Array.from(visibleMain().querySelectorAll('button')).find(button => button.textContent === 'Beta');
  expect(Array.from(visibleMain().querySelectorAll('button')).some(button => button.textContent === 'not-exported')).toBe(false);
  await click(sourceLink ?? null);
  expect(location.hash).toContain('#/entry/Beta');
  expect(visibleMain().textContent).toContain('Frozen source body');
  await click(visibleMain().querySelector('button'));
  expect(location.hash).toContain('#/macro/symbol');
});

it('mounts the shared semantic graph, filters real edges, and returns node reading to the graph', async () => {
  await mount('#/graph?return=%23%2Fnode%2Fsecond');
  expect(visibleMain()?.textContent ?? '').toContain('2 nodes');
  expect(visibleMain().textContent).toContain('1 edge');
  expect(visibleMain().querySelectorAll('g[aria-label^="Relationship"]')).toHaveLength(1);
  expect(visibleMain().querySelectorAll('g[aria-label^="Relationship"][role="button"]')).toHaveLength(0);
  await click(visibleMain().querySelector('button[title="Expand filters"]'));
  const atomic = Array.from(visibleMain().querySelectorAll('label')).find(label => label.textContent?.includes('atomic deps only'))?.querySelector('input');
  expect(atomic?.checked).toBe(true);
  expect(visibleMain().querySelector('g[aria-label^="Relationship"]')?.getAttribute('aria-label')).toContain('explains');
  await click(atomic ?? null);
  expect(visibleMain().querySelectorAll('g[aria-label^="Relationship"]')).toHaveLength(2);
  await click(visibleMain().querySelector('g[aria-label="Entry Beta title (Beta)"]'), true);
  expect(location.hash).toContain('#/entry/Beta');
  await click(visibleMain().querySelector('button'));
  expect(location.hash).toBe('#/graph?return=%23%2Fnode%2Fsecond');
});

it('refits graph dimensions without undoing zoom and releases replayed observers before late delivery', async () => {
  let width = 900;
  const geometry = vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: 600, width, height: 600, toJSON() {} }));
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<Element>(); disconnected = false;
    constructor(private callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    disconnect() { this.disconnected = true; }
    notify() { this.callback([], this as unknown as ResizeObserver); }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  history.replaceState(null, '', '#/graph');
  await act(async () => root.render(<StrictMode><BrowserReader snapshot={snapshot} /></StrictMode>));
  const svg = visibleMain().querySelector('g[aria-label^="Entry"]')!.closest('svg')!;
  const observer = [...observers].reverse().find(o => o.targets.has(svg) && !o.disconnected)!;
  expect(observer).toBeDefined();
  const viewport = svg.querySelector('g[transform]')!;
  const initial = viewport.getAttribute('transform');
  await act(async () => svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -20, clientX: 200, clientY: 200 })));
  const zoomed = viewport.getAttribute('transform'); expect(zoomed).not.toBe(initial);
  await act(async () => observer.notify()); expect(viewport.getAttribute('transform')).toBe(zoomed);
  width = 500; await act(async () => observer.notify()); expect(viewport.getAttribute('transform')).not.toBe(zoomed);
  await act(async () => root.unmount()); expect(observer.disconnected).toBe(true);
  const reads = geometry.mock.calls.length;
  await act(async () => { for (const o of observers.filter(o => o.targets.has(svg))) o.notify(); });
  expect(geometry.mock.calls.length).toBe(reads);
});

it('resets search controls on explicit same-kind navigation without remounting while typing', async () => {
  await mount('#/search');
  const search = visibleMain().querySelector<HTMLInputElement>('input[type="text"]')!;
  await input(search, 'Alpha');
  expect(visibleMain().querySelector<HTMLInputElement>('input[type="text"]')).toBe(search);
  await click(Array.from(element.querySelectorAll('nav button')).find(b => b.textContent === 'SNoogL') ?? null);
  expect(visibleMain().querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('');
  await input(visibleMain().querySelector<HTMLInputElement>('input[type="text"]')!, 'Beta');
  await act(async () => {
    history.replaceState(null, '', '#/search?q=Alpha');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(visibleMain().querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Alpha');
  expect(visibleMain().querySelectorAll('[role="option"]')).toHaveLength(1);
});

it('mounts the shared SNoogL search on a deep link and returns Entry reading to the exact query', async () => {
  await mount('#/search?return=%23%2Fnode%2Fsecond');
  expect(visibleMain().textContent).toContain('frozen export');
  const search = visibleMain().querySelector<HTMLInputElement>('input[type="text"]');
  expect(search).not.toBeNull();
  await input(search!, 'Alpha');
  expect(visibleMain().querySelectorAll('[role="option"]')).toHaveLength(1);
  const searchHash = location.hash;
  await click(visibleMain().querySelector('[role="option"]'));
  expect(location.hash).toContain('#/entry/Alpha');
  await click(visibleMain().querySelector('button'));
  expect(location.hash).toBe(searchHash);
  expect(visibleMain().querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Alpha');
});
