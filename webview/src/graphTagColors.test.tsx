import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';
import { apply_preferences_snapshot } from './runtime/preferencesRuntime';

const api = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('./vscodeApi', async original => ({
  ...(await original<typeof import('./vscodeApi')>()),
  useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
  nodes: [['a', ['中文', '__proto__']], ['b', ['__proto__', '中文']], ['c', ['', 'a,b']], ['d', []]].map(([id, tags]) => ({
    id, tags, packageId: 'logic', title: id, kind: 'Theorem', kindId: 'theorem', coloring: null
  })),
  edges: ['a', 'b', 'c', 'd'].map(id => ({ id, from: id, to: id, label: 'uses', isDependency: false, isAtomic: null }))
};
const send = (data: unknown = graph) => act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
function mount() { const view = render(<SnlGraphApp />); send(); fireEvent.click(screen.getByTitle('Expand filters')); return view; }
const mode = (value: string) => fireEvent.change(screen.getByRole('combobox', { name: 'Coloring mode' }), { target: { value } });
const rows = () => screen.queryAllByTestId('graph-tag-color-rule');
function add(tag: string, color: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Add color mapping' }));
  const row = rows().at(-1)!;
  const select = within(row).getByRole('combobox', { name: 'Tag' }) as HTMLSelectElement;
  const option = [...select.options].find(option => option.text === (tag === '' ? '(empty tag)' : tag))!;
  fireEvent.change(select, { target: { value: option.value } });
  fireEvent.change(within(row).getByLabelText('Color'), { target: { value: color } });
  return row;
}
const node = (id = 'a') => document.querySelector(`[data-node-id="${id}"]`)!;
const fill = (id = 'a') => node(id).querySelector('rect, circle')!.getAttribute('fill');
const viewport = () => document.querySelector('svg > g[transform]')!.getAttribute('transform');
const positions = () => ['a', 'b', 'c', 'd'].map(id => node(id).getAttribute('transform'));
beforeEach(() => {
  document.documentElement.lang = 'en';
  api.postMessage.mockReset(); api.getState.mockReset(); api.setState.mockReset();
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 400, width: 900, height: 400, toJSON() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.lang = ''; });

describe('temporary graph Tag coloring', () => {
  it.each(['rectangle', 'radial-inward', 'radial-outward'])('uses rule order, not node tag order; changes paint only in %s', layout => {
    mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), { target: { value: layout } });
    expect((screen.getByRole('combobox', { name: 'Coloring mode' }) as HTMLSelectElement).value).toBe('kind');
    const fallback = fill();
    const first = add('__proto__', '#123456'); add('中文', '#abcdef');
    expect(fill()).toBe(fallback);
    fireEvent.wheel(document.querySelector('svg > g[transform]')!.parentElement!, { deltaY: 100, clientX: 250, clientY: 150 });
    const before = positions(), vp = viewport();
    mode('tag');
    expect(fill('a')).toBe('#123456'); expect(fill('b')).toBe('#123456'); expect(fill('d')).toBe(fallback);
    fireEvent.click(within(first).getByRole('button', { name: 'Move down' }));
    expect(fill('a')).toBe('#abcdef'); expect(fill('b')).toBe('#abcdef');
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Move up' }));
    expect(fill()).toBe('#123456');
    fireEvent.change(within(first).getByLabelText('Color'), { target: { value: '#654321' } });
    expect(fill()).toBe('#654321');
    fireEvent.click(within(first).getByRole('button', { name: 'Remove color mapping' }));
    expect(fill()).toBe('#abcdef');
    mode('kind'); expect(fill()).toBe(fallback); mode('tag');
    expect(positions()).toEqual(before); expect(viewport()).toBe(vp);
    fireEvent.focus(node());
    expect(node().querySelector('rect')!.getAttribute('fill')).toBe('#abcdef');
    expect(node().querySelector('rect')!.getAttribute('stroke-width')).toBe('3.5');
    fireEvent.blur(node()); fireEvent.click(node());
    expect(fill()).toBe('#abcdef');
    expect(node().querySelector('rect, circle')!.getAttribute('stroke-width')).not.toBe('2');
  });
  it('preserves exact empty/comma tags, complete choices and unavailable rows through zero results and refresh; never persists', () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const view = mount(); mode('tag');
    const empty = add('', '#224466'); add('a,b', '#446688');
    expect(fill('c')).toBe('#224466');
    fireEvent.click(screen.getByTitle('Hide every entry kind'));
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(0);
    expect(within(empty).getByRole('option', { name: '__proto__' })).toBeTruthy();
    send({ ...graph, nodes: [], edges: [] });
    expect(within(empty).getByRole('option', { name: '(empty tag) (unavailable)' })).toBeTruthy();
    expect((within(empty).getByRole('combobox', { name: 'Tag' }) as HTMLSelectElement).value).not.toBe('');
    fireEvent.click(within(empty).getByRole('button', { name: 'Remove color mapping' }));
    expect(rows()).toHaveLength(1);
    send(); fireEvent.click(screen.getByTitle('Show every entry kind (reset kind filter)'));
    expect(fill('c')).toBe('#446688');
    expect(api.postMessage.mock.calls).toEqual([[{ type: 'ready' }]]);
    expect(api.setState).not.toHaveBeenCalled(); expect(api.getState).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    view.unmount(); mount(); expect(rows()).toHaveLength(0);
    expect((screen.getByRole('combobox', { name: 'Coloring mode' }) as HTMLSelectElement).value).toBe('kind');
  });
  it('keeps mapped fills fixed while unmatched Kind fills and independent borders follow the theme', () => {
    mount();
    send({ ...graph, nodes: graph.nodes.map(node => ({ ...node, coloring: {
      light: { stroke: '#334455', background: '#ddeeff' },
      dark: { stroke: '#aabbcc', background: '#112233' }
    } })) });
    const theme = (color_scheme: 'light' | 'dark', revision: number) => act(() => {
      apply_preferences_snapshot({ type: 'snl.preferences/snapshot', generation: 'graph-tag-theme', revision,
        preferences: { language: 'en', color_scheme, motion: 'full' } });
    });
    theme('light', 1);
    expect(fill()).toBe('#ddeeff');
    const row = add('__proto__', '#ff8800'); mode('tag');
    expect(fill()).toBe('#ff8800'); expect(fill('d')).toBe('#ddeeff');
    theme('dark', 2);
    expect(fill()).toBe('#ff8800'); expect(fill('d')).toBe('#112233');
    fireEvent.focus(node());
    expect(node().querySelector('rect')!.getAttribute('fill')).toBe('#ff8800');
    expect(node().querySelector('rect')!.getAttribute('stroke')).toBe('#aabbcc');
    // Clearing a row to its draft placeholder is distinct from choosing empty Tag.
    fireEvent.change(within(row).getByRole('combobox', { name: 'Tag' }), { target: { value: '' } });
    expect(fill()).toBe('#112233');
    theme('light', 3); expect(fill()).toBe('#ddeeff');
  });
  it('localizes coloring controls in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    render(<SnlGraphApp />); send(); fireEvent.click(screen.getByTestId('graph-filter-toggle'));
    expect(screen.getByRole('combobox', { name: '着色模式' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加颜色映射' }));
    expect(screen.getByRole('combobox', { name: '标签' })).toBeTruthy();
    expect(screen.getByLabelText('颜色')).toBeTruthy();
    expect(screen.getByRole('button', { name: '上移' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '下移' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '移除颜色映射' })).toBeTruthy();
  });
  it.each([['#ffffff', 'rgb(0, 0, 0)'], ['#000000', 'rgb(255, 255, 255)']])('keeps title text readable on custom %s backgrounds', (color, expected) => {
    mount(); add('__proto__', color); mode('tag');
    fireEvent.change(screen.getByRole('combobox', { name: 'Nodes' }), { target: { value: 'always-title' } });
    expect((node().querySelector('foreignObject > div') as HTMLElement).style.color).toBe(expected);
  });
  it.each([null, 'bad', ['ok', 1]])('rejects malformed wire tags %j without replacing the last valid graph', tags => {
    mount(); send({ ...graph, nodes: [{ ...graph.nodes[0], tags }] });
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(4);
  });
});
