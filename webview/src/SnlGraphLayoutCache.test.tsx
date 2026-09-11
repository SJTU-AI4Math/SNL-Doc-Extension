import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';
import * as geometry from '../../src/graphLayout';
import { graphLayoutInput, graphLayoutKey, generateGraphLayout } from '../../src/graphLayoutCacheModel';
import { set_content_language } from './runtime/preferencesRuntime';
const coloring = { light: { stroke: '#123456', background: '#abcdef' }, dark: { stroke: '#123456', background: '#abcdef' } };
const message = () => ({ type: 'graph', scope: { mode: 'library', slug: 'one' }, title: 'Graph',
  nodes: ['a','b','c'].map(id => ({ id, packageId: 'p', kindId: 'theorem', title: id, kind: 'Theorem', coloring })),
  edges: [['a','b'],['b','c'],['a','c']].map(([from,to]) => ({ id: from+to, from, to, label: 'depends', isDependency: true, isAtomic: from+to !== 'ac' })), warnings: [] });
function packet() {
  const msg = message();
  const input = graphLayoutInput('one', 'en', msg.nodes.map(n => ({ ...n, color: '', background: '' })), msg.edges);
  return { ...msg, layoutCache: { key: graphLayoutKey(input), layout: generateGraphLayout(input) } };
}
function send(msg: unknown) { act(() => window.dispatchEvent(new MessageEvent('message', { data: msg }))); }
beforeEach(() => { (globalThis as any).__snlApi = { postMessage: vi.fn() }; set_content_language('en'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); set_content_language('en'); });
it('renders host cached coordinates and edge routes without executing layout; recolors from current source', () => {
  const msg = packet();
  const compute = vi.spyOn(geometry, 'layout');
  const { container } = render(<SnlGraphApp />);
  send(msg);
  expect(screen.getByRole('button', { name: 'Entry a (a)' })).toBeTruthy();
  expect(compute).not.toHaveBeenCalled();
  const expected = msg.layoutCache.layout.nodes.find(n => n.id === 'a')!;
  const node = screen.getByRole('button', { name: 'Entry a (a)' });
  expect(node.getAttribute('transform')).toBe(`translate(${expected.x} ${expected.y})`);
  expect(node.querySelector('rect')?.getAttribute('fill')).toBe('#abcdef');
  const edge = msg.layoutCache.layout.edges.find(e => e.id === 'ac')!;
  const target = msg.layoutCache.layout.nodes.find(n => n.id === 'c')!;
  expect([...container.querySelectorAll('path')].some(p => p.getAttribute('d') === geometry.edgePath(expected,target,edge.waypoints).d)).toBe(true);
  fireEvent.click(node); // selection is not generated data
  expect(compute).not.toHaveBeenCalled();
});
it('keeps filtered projections in memory and returns to cached geometry without storing selection', () => {
  const msg = packet(); const compute = vi.spyOn(geometry, 'layout');
  render(<SnlGraphApp />); send(msg);
  fireEvent.click(screen.getByTitle('Expand filters'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
  expect(compute).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
  expect(compute).toHaveBeenCalledTimes(1);
});
it.each(['scope','title','language','nonfinite','reference','style'])('rejects %s stale or unsafe host geometry and renders a fresh safe graph', reason => {
  const msg = packet();
  if (reason === 'scope') msg.scope.slug = 'two';
  if (reason === 'title') msg.nodes[0].title = 'Long title that changes layout width';
  if (reason === 'language') set_content_language('zh-CN');
  if (reason === 'nonfinite') msg.layoutCache.layout.nodes[0].x = Infinity;
  if (reason === 'reference') msg.layoutCache.layout.edges[0].to = 'not-a-node';
  if (reason === 'style') msg.layoutCache.layout.nodes[0].background = 'url(evil)';
  const compute = vi.spyOn(geometry, 'layout');
  const { container } = render(<SnlGraphApp />); send(msg);
  expect(compute).toHaveBeenCalledTimes(1);
  expect(container.innerHTML).not.toContain('Infinity');
  expect(container.innerHTML).not.toContain('url(evil)');
  expect(container.querySelectorAll('svg defs')).toHaveLength(1);
});
