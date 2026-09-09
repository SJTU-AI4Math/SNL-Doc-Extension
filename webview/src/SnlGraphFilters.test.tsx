import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SnlGraphApp } from './SnlGraphApp';

const api = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('./vscodeApi', async (original) => ({
  ...(await original<typeof import('./vscodeApi')>()),
  useVsCodeApiRef: () => ({ current: api }), getVsCodeApi: () => api
}));
const node = (id: string, kindId: string) => ({
  id, packageId: 'logic', title: id.toUpperCase(), kind: kindId, kindId, coloring: null
});
const edge = (id: string, from: string, to: string, label = 'uses', isDependency = false, isAtomic: boolean | null = null) => ({
  id, from, to, label, isDependency, isAtomic
});
const graph = {
  type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
  nodes: [node('a', 'theorem'), node('b', 'lemma'), node('c', 'definition')],
  // Self-loops keep single-kind truth-table results visible under hide-isolated.
  edges: [edge('aa', 'a', 'a'), edge('bb', 'b', 'b'), edge('cc', 'c', 'c'), edge('ab', 'a', 'b')]
};
function send(data: unknown = graph): void { act(() => window.dispatchEvent(new MessageEvent('message', { data }))); }
function mount(data: unknown = graph) {
  const view = render(<SnlGraphApp />); send(data);
  fireEvent.click(screen.getByTitle('Expand filters'));
  // Predicate tests inspect induced relationships, independently of paint's off default.
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show relationships' }));
  return view;
}
const cards = () => screen.queryAllByTestId('graph-filter-clause');
function add() {
  fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
  return cards().at(-1)!;
}
const check = (card: HTMLElement, name: string) => fireEvent.click(within(card).getByRole('checkbox', { name }));
const ids = () => [...document.querySelectorAll('[data-node-id]')].map(n => n.getAttribute('data-node-id')).sort();
function relationship(values: string[], direction = 'either') {
  const card = add();
  // Check the public option before changing, so RED identifies missing UI, not
  // a synthetic change to an unsupported select value.
  expect(within(card).getByRole('option', { name: 'Relationship' })).toBeTruthy();
  fireEvent.change(within(card).getByRole('combobox', { name: 'Filter kind' }), { target: { value: 'relationship' } });
  fireEvent.change(within(card).getByRole('combobox', { name: 'Direction' }), { target: { value: direction } });
  for (const value of values) check(card, value);
  return card;
}

beforeEach(() => {
  document.documentElement.lang = 'en';
  api.postMessage.mockReset(); api.getState.mockReset(); api.setState.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.lang = ''; });

describe('relationship node predicates', () => {
  it('defaults to atomic-only before layout, preserves an explicit opt-out on refresh and resets on remount', () => {
    const data = { ...graph, edges: [edge('aa', 'a', 'a', 'atomic', true, true),
      edge('bb', 'b', 'b', 'composite', true, false), edge('cc', 'c', 'c', 'unknown', true, null),
      edge('ab', 'a', 'b', 'authored', false, null)] };
    const view = mount(data);
    const toggle = screen.getByRole('checkbox', { name: 'atomic deps only' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(ids()).toEqual(['a', 'b']);
    expect(screen.queryByRole('button', { name: 'Relationship composite: b to b' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Relationship unknown: c to c' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Relationship authored: a to b' })).toBeTruthy();
    fireEvent.click(toggle);
    expect(ids()).toEqual(['a', 'b', 'c']);
    send(data);
    expect(toggle.checked).toBe(false);
    expect(ids()).toEqual(['a', 'b', 'c']);
    view.unmount(); mount(data);
    expect((screen.getByRole('checkbox', { name: 'atomic deps only' }) as HTMLInputElement).checked).toBe(true);
    expect(ids()).toEqual(['a', 'b']);
  });
  it.each(['rectangle', 'radial-inward', 'radial-outward'])('uses true from-to direction, OR labels and self-loops in %s', mode => {
    mount({ ...graph, edges: [edge('aa', 'a', 'a', 'keep'), edge('bb', 'b', 'b', 'keep'), edge('cc', 'c', 'c', 'keep'),
      edge('ab', 'a', 'b', 'red'), edge('ba', 'b', 'a', 'blue'), edge('cc-red', 'c', 'c', 'red')] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Layout' }), { target: { value: mode } });
    const card = relationship(['red'], 'incoming');
    expect(ids()).toEqual(['b', 'c']);
    fireEvent.change(within(card).getByRole('combobox', { name: 'Direction' }), { target: { value: 'outgoing' } });
    expect(ids()).toEqual(['a', 'c']);
    check(card, 'blue');
    expect(ids()).toEqual(['a', 'b', 'c']);
    check(card, 'blue');
    fireEvent.change(within(card).getByRole('combobox', { name: 'Direction' }), { target: { value: 'either' } });
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it.each([false, true])('evaluates every relationship on one common scope graph before any node filters (reverse order: %s)', reverse => {
    mount({ ...graph,
      nodes: [node('a', 'theorem'), node('b', 'theorem'), node('c', 'lemma'), node('d', 'lemma')],
      edges: [edge('ca', 'c', 'a', 'red'), edge('db', 'd', 'b', 'red'),
        edge('ac', 'a', 'c', 'blue'), edge('bd', 'b', 'd', 'blue'), edge('ab', 'a', 'b', 'neutral')]
    });
    const steps = reverse ? [['blue', 'outgoing'], ['red', 'incoming']] : [['red', 'incoming'], ['blue', 'outgoing']];
    const kind = add(); check(kind, 'theorem');
    // Quick-kind restrictions must also not shrink the relationship input.
    const quickLemma = screen.getAllByRole('checkbox', { name: 'lemma' }).find(el => !el.closest('[data-filter-id]'))!;
    fireEvent.click(quickLemma);
    for (const [value, direction] of steps) relationship([value], direction);
    expect(ids()).toEqual(['a', 'b']);
    expect(screen.getByRole('button', { name: 'Relationship neutral: a to b' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Relationship red: c to a' })).toBeNull();
  });

  it('applies atomic-only before relationship predicates, retains nondependency edges and full label choices', () => {
    mount({ ...graph, edges: [edge('aa', 'a', 'a', 'keep'), edge('bb', 'b', 'b', 'keep'), edge('cc', 'c', 'c', 'keep'),
      edge('ab', 'a', 'b', 'composite', true, false), edge('bc', 'b', 'c', 'unknown', true, null),
      edge('ca', 'c', 'a', 'atomic', true, true), edge('ba', 'b', 'a', 'authored', false, false)] });
    // Explicitly opt out before exercising the all→atomic transition.
    fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
    const card = relationship(['composite'], 'outgoing');
    expect(ids()).toEqual(['a']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
    expect(ids()).toEqual([]);
    expect(within(card).getByRole('checkbox', { name: 'composite' })).toBeTruthy();
    check(card, 'unknown');
    expect(ids()).toEqual([]);
    check(card, 'atomic');
    expect(ids()).toEqual(['c']);
    check(card, 'authored');
    expect(ids()).toEqual(['b', 'c']);
    fireEvent.click(screen.getByRole('checkbox', { name: 'atomic deps only' }));
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('induces edges of all labels, then hides isolated matching nodes', () => {
    mount({ ...graph, edges: [edge('ab', 'a', 'b', 'red')] });
    const card = relationship(['red'], 'incoming');
    expect(ids()).toEqual([]); // b matches, but a does not; b becomes isolated
    fireEvent.change(within(card).getByRole('combobox', { name: 'Direction' }), { target: { value: 'either' } });
    expect(ids()).toEqual(['a', 'b']);
    expect(screen.getByRole('button', { name: 'Relationship red: a to b' })).toBeTruthy();
  });
});

describe('filter refresh and panel lifecycle', () => {
  it('retains unavailable selected kinds and labels after scope refresh and recovers without resetting clauses', () => {
    mount();
    const kind = add(); check(kind, 'lemma');
    const relation = relationship(['uses'], 'incoming');
    const beforeIds = cards().map(card => card.getAttribute('data-filter-id'));
    expect(ids()).toEqual(['b']);
    // Pool-only entryOptions are for popovers, not the graph filter universe.
    send({ ...graph, scope: { mode: 'library', slug: 'limited' },
      nodes: [node('x', 'new-kind')], edges: [edge('xx', 'x', 'x', 'new-label')],
      entryOptions: [{ id: 'b', title: 'B' }, { id: 'outside', title: 'OUTSIDE' }] });
    expect(ids()).toEqual([]);
    expect(cards().map(card => card.getAttribute('data-filter-id'))).toEqual(beforeIds);
    const missingKind = within(kind).getByRole('checkbox', { name: 'lemma (unavailable)' }) as HTMLInputElement;
    const missingLabel = within(relation).getByRole('checkbox', { name: 'uses (unavailable)' }) as HTMLInputElement;
    expect(missingKind.checked).toBe(true); expect(missingKind.disabled).toBe(false);
    expect(missingLabel.checked).toBe(true); expect(missingLabel.disabled).toBe(false);
    expect(within(kind).queryByRole('checkbox', { name: 'theorem' })).toBeNull();
    expect(within(kind).getByRole('checkbox', { name: 'new-kind' })).toBeTruthy();
    expect(within(relation).getByRole('checkbox', { name: 'new-label' })).toBeTruthy();
    expect((within(relation).getByRole('combobox', { name: 'Direction' }) as HTMLSelectElement).value).toBe('incoming');
    send();
    expect(ids()).toEqual(['b']);
    expect(within(kind).queryByText(/unavailable/)).toBeNull();
    expect(within(relation).queryByText(/unavailable/)).toBeNull();
    send({ ...graph, nodes: [], edges: [] });
    fireEvent.click(within(kind).getByRole('checkbox', { name: 'lemma (unavailable)' }));
    expect(within(kind).getByText('Draft — no values; ignored')).toBeTruthy();
    expect(within(kind).queryByRole('checkbox', { name: 'lemma (unavailable)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(cards()).toHaveLength(0);
  });

  it('keeps settings reachable on zero results, across collapse/error/refresh, but never persists and resets on remount', () => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const view = mount();
    const first = add(); check(first, 'theorem');
    const second = add(); check(second, 'lemma');
    expect(ids()).toEqual([]);
    expect(screen.getByTestId('graph-filtered-empty').textContent).toContain('Adjust or clear filters');
    const tab = screen.getByTitle('Collapse filters');
    expect(tab.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(tab);
    expect(screen.queryByTestId('graph-filters')).toBeNull();
    expect(screen.getByTitle('Expand filters').getAttribute('aria-expanded')).toBe('false');
    send({ type: 'graphError', scope: { mode: 'pool' }, title: 'Graph', message: 'refresh broke' });
    expect(screen.getByRole('alert').textContent).toContain('refresh broke');
    fireEvent.click(screen.getByTitle('Expand filters'));
    expect(cards()).toHaveLength(2);
    send();
    expect(ids()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    check(cards()[1], 'Enabled');
    send();
    expect((within(cards()[1]).getByRole('checkbox', { name: 'Enabled' }) as HTMLInputElement).checked).toBe(false);
    expect(ids()).toEqual(['a']);
    expect(api.setState).not.toHaveBeenCalled();
    expect(api.getState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(api.postMessage.mock.calls).toEqual([[{ type: 'ready' }]]);
    view.unmount();
    mount();
    expect(cards()).toHaveLength(0);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('localizes accessible groups and controls in Chinese, and changes kind to an explicitly empty draft without inventing Tags', () => {
    document.documentElement.lang = 'zh-CN';
    render(<SnlGraphApp />); send();
    fireEvent.click(screen.getByTitle('展开筛选器'));
    fireEvent.click(screen.getByRole('button', { name: '添加筛选' }));
    const card = screen.getByRole('group', { name: '筛选 1' });
    expect(within(card).getByText('草稿 — 未选择值，不参与筛选')).toBeTruthy();
    expect(within(card).getByRole('group', { name: '选值（OR）' })).toBeTruthy();
    const select = within(card).getByRole('combobox', { name: '筛选种类' });
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['条目种类', '关系']);
    check(card, 'theorem');
    fireEvent.change(select, { target: { value: 'relationship' } });
    expect(within(card).getByText('草稿 — 未选择值，不参与筛选')).toBeTruthy();
    expect(ids()).toEqual(['a', 'b', 'c']);
    const direction = within(card).getByRole('combobox', { name: '方向' });
    expect(within(direction).getAllByRole('option').map(option => option.textContent)).toEqual(['任意方向', '入边', '出边']);
    check(card, 'uses');
    send({ ...graph, edges: [] });
    const unavailable = within(card).getByRole('checkbox', { name: 'uses（不可用）' });
    act(() => (unavailable as HTMLInputElement).focus());
    expect(document.activeElement).toBe(unavailable);
    check(card, '启用');
    expect(within(card).getByText('已停用 — 不参与筛选')).toBeTruthy();
    expect(within(card).getByRole('button', { name: '移除筛选' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清空筛选' }));
    expect(cards()).toHaveLength(0);
  });
});

describe('temporary graph filter clauses', () => {
  it('starts empty; ORs values, ANDs duplicate-kind clauses, and ignores clearly marked empty drafts', () => {
    mount();
    expect(cards()).toHaveLength(0);
    expect(ids()).toEqual(['a', 'b', 'c']);
    const first = add();
    expect(within(first).getByText('Draft — no values; ignored')).toBeTruthy();
    expect(ids()).toEqual(['a', 'b', 'c']);
    check(first, 'theorem');
    expect(ids()).toEqual(['a']);
    check(first, 'lemma');
    expect(ids()).toEqual(['a', 'b']);
    const second = add();
    expect(ids()).toEqual(['a', 'b']);
    check(second, 'lemma');
    check(second, 'definition');
    expect(ids()).toEqual(['b']);
    check(second, 'lemma');
    expect(ids()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
    check(second, 'Enabled');
    expect(ids()).toEqual(['a', 'b']);
    check(second, 'Enabled');
    expect(ids()).toEqual([]);
    fireEvent.click(within(second).getByRole('button', { name: 'Remove filter' }));
    expect(ids()).toEqual(['a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(cards()).toHaveLength(0);
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('retains stable card identity after deletion and adds without reusing IDs; combines the existing quick-kind filter', () => {
    mount();
    const first = add(), second = add();
    const firstId = first.getAttribute('data-filter-id'), secondId = second.getAttribute('data-filter-id');
    expect(firstId).toBeTruthy(); expect(secondId).not.toBe(firstId);
    check(second, 'lemma');
    fireEvent.click(within(first).getByRole('button', { name: 'Remove filter' }));
    expect(cards()[0]).toBe(second);
    expect(cards()[0].getAttribute('data-filter-id')).toBe(secondId);
    const third = add();
    expect([firstId, secondId]).not.toContain(third.getAttribute('data-filter-id'));
    fireEvent.click(screen.getByTitle('Hide every entry kind'));
    expect(ids()).toEqual([]);
    fireEvent.click(screen.getByTitle('Show every entry kind (reset kind filter)'));
    expect(ids()).toEqual(['b']);
    check(second, 'lemma');
    expect(within(second).getByText('Draft — no values; ignored')).toBeTruthy();
    expect(ids()).toEqual(['a', 'b', 'c']);
  });
});
