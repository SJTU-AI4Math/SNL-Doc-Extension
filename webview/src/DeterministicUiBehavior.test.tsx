import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posted: unknown[] = [];
vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = { postMessage: (message: unknown) => posted.push(message) };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { DashboardApp } = await import('./DashboardApp');
const { ExportOptionsApp } = await import('./ExportOptionsApp');
const { InitKindsApp } = await import('./InitKindsApp');
const { SnooglApp } = await import('./SnooglApp');
const { SnlGraphApp } = await import('./SnlGraphApp');
const { CreateMacroApp } = await import('./CreateMacroApp');

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

beforeEach(() => { posted.length = 0; });
afterEach(cleanup);

describe('deterministic panel refresh behavior', () => {
  it('refreshes Dashboard but hides refresh for an immutable Export snapshot', () => {
    render(<DashboardApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh this panel from disk' }));
    expect(posted).toContainEqual({ type: 'nav.refresh' });
    cleanup();
    posted.length = 0;

    render(<ExportOptionsApp />);
    expect(screen.queryByRole('button', { name: 'Refresh this panel from disk' })).toBeNull();
  });

  it('SNoogL atomically adopts the query represented by published results without echoing it', async () => {
    render(<SnooglApp />);
    send({
      type: 'results',
      query: { q: 'group', mode: 'macro', filters: { kindId: 'const' } },
      results: [],
      kindsByMode: { entry: ['theorem'], macro: ['const'] },
      counterpartIdsByMode: { entry: ['Logic.group'], macro: ['entry-group'] }
    });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('group');
    expect(screen.getByRole('tab', { name: 'Macro' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('combobox', { name: 'Kind (Macro)' }) as HTMLSelectElement).value)
      .toBe('const');
    send({ type: 'results' });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('group');
    const queryCount = posted.filter(
      (message) => (message as { type?: string }).type === 'query'
    ).length;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(posted.filter(
      (message) => (message as { type?: string }).type === 'query'
    )).toHaveLength(queryCount);
  });

  it('SNoogL does not let stale result refreshes overwrite faster local typing', () => {
    render(<SnooglApp />);
    send({
      type: 'results',
      query: { q: 'abc', mode: 'entry', filters: {} },
      results: [{ kind: 'entry', id: 'current', title: 'Current result', entryKind: null, score: 2 }],
      kindsByMode: { entry: [], macro: [] },
      counterpartIdsByMode: { entry: [], macro: [] }
    });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abcdef' } });

    send({
      type: 'results',
      query: { q: 'abc', mode: 'entry', filters: {} },
      results: [{ kind: 'entry', id: 'stale', title: 'Stale result', entryKind: null, score: 2 }],
      kindsByMode: { entry: [], macro: [] },
      counterpartIdsByMode: { entry: [], macro: [] }
    });

    expect(input.value).toBe('abcdef');
    expect(screen.queryByText('Stale result')).toBeNull();
    expect(screen.getByText('Current result')).toBeTruthy();

    send({
      type: 'results',
      query: { q: 'abcdef', mode: 'entry', filters: {} },
      results: [{ kind: 'entry', id: 'fresh', title: 'Fresh result', entryKind: null, score: 2 }],
      kindsByMode: { entry: [], macro: [] },
      counterpartIdsByMode: { entry: [], macro: [] }
    });
    expect(input.value).toBe('abcdef');
    expect(screen.getByText('Fresh result')).toBeTruthy();
    expect(screen.queryByText('Current result')).toBeNull();
  });

  it('SNoogL uses the opposite ID domain only as an explicit filter', async () => {
    render(<SnooglApp />);
    send({
      type: 'results',
      query: { q: '', mode: 'entry', filters: {} },
      results: [],
      kindsByMode: { entry: [], macro: [] },
      counterpartIdsByMode: { entry: ['Logic.rule'], macro: ['entry-a'] }
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Uses Macro ID' }), {
      target: { value: 'Logic.rule' }
    });
    await waitFor(() => expect(posted).toContainEqual({
      type: 'query', q: '', mode: 'entry', filters: { counterpartId: 'Logic.rule' }
    }), { timeout: 500 });

    // A separate fresh panel may be initialized from a Macro-domain snapshot.
    // Do not reuse the locally edited Entry panel: mismatched result snapshots
    // are stale once local query intent exists and must not take over controls.
    cleanup();
    render(<SnooglApp />);
    send({
      type: 'results',
      query: { q: '', mode: 'macro', filters: { counterpartId: 'entry-a' } },
      results: [],
      kindsByMode: { entry: [], macro: [] },
      counterpartIdsByMode: { entry: ['Logic.rule'], macro: ['entry-a'] }
    });
    expect((screen.getByRole('combobox', { name: 'Source Entry ID' }) as HTMLSelectElement).value)
      .toBe('entry-a');
  });
});

describe('empty kind presets', () => {
  it('does not offer or apply zero-kind placeholders', () => {
    render(<InitKindsApp domain="entry" />);
    send({
      type: 'init', existing: 0,
      presets: [
        { id: 'empty', label: 'Empty', description: 'placeholder', count: 0 },
        { id: 'real', label: 'Real', description: 'usable', count: 2 }
      ]
    });
    expect(screen.queryByRole('option', { name: /Empty/ })).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('real');
    fireEvent.click(screen.getByRole('button', { name: 'Apply Preset' }));
    expect(posted).toContainEqual({ type: 'apply', presetId: 'real' });
  });
});

describe('macro dirty tracking', () => {
  const macro = (description: string) => ({
    name: 'foo', description, source: { entries: [], urls: [] }, dynamic_arity: false,
    default_style: { en: 'default' }, tags: [],
    styles: [{ style_name: 'default', template: '\\foo', mode: 'formula_inline', tags: [] }]
  });
  const context = (description: string) => ({
    type: 'context', mode: 'edit', file: 'pkg.json', packageName: 'pkg', existingNames: ['foo'],
    macroCandidates: [], macroKinds: [], entries: [], existing: macro(description), macroRevision: description
  });

  it('does not mark an unchanged draft dirty for an arbitrary click', () => {
    render(<CreateMacroApp />);
    send(context('first'));
    expect((document.getElementById('m-desc') as HTMLInputElement).value).toBe('first');
    fireEvent.click(screen.getByRole('heading', { level: 1 }));
    send(context('fresh from disk'));
    expect((document.getElementById('m-desc') as HTMLInputElement).value).toBe('fresh from disk');
  });
});

describe('graph keyboard accessibility', () => {
  it('labels and keyboard-activates graph nodes and edges', () => {
    render(<SnlGraphApp />);
    send({
      type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [], entryOptions: [], macros: {}, macroKinds: [],
      nodes: [
        { id: 'a', packageId: 'logic', title: 'Alpha', kind: 'Theorem', kindId: 'theorem', color: '#fff', background: '#000' },
        { id: 'b', packageId: 'logic', title: 'Beta', kind: 'Lemma', kindId: 'lemma', color: '#fff', background: '#000' }
      ],
      edges: [{ id: 'r', from: 'a', to: 'b', label: 'uses', isDependency: false, isAtomic: null }]
    });
    const node = screen.getByRole('button', { name: 'Entry Alpha (a)' });
    const edge = screen.getByRole('button', { name: 'Relationship uses: a to b' });
    send({ type: 'graph', nodes: null });
    expect(screen.getByRole('button', { name: 'Entry Alpha (a)' })).toBeTruthy();
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(edge.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(screen.getByText(/selected: Alpha/)).toBeTruthy();
    fireEvent.keyDown(edge, { key: ' ' });
    expect(posted).toContainEqual({ type: 'editRelationship', id: 'r' });
    posted.length = 0;
    fireEvent.keyDown(node, { key: 'Enter', ctrlKey: true });
    expect(posted).toContainEqual({ type: 'openEntryInfoview', entryId: 'a' });
  });

  it('forwards host package identities into lazy Graph popover requests', async () => {
    render(<SnlGraphApp />);
    send({
      type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [],
      entryOptions: [{ id: 'a', title: 'Alpha', hasContent: false }],
      entryPackages: { a: 'logic' }, macros: {}, macroKinds: [],
      nodes: [
        { id: 'a', packageId: 'logic', title: 'Alpha', kind: 'Theorem', kindId: 'theorem', color: '#fff', background: '#000' },
        { id: 'b', packageId: 'logic', title: 'Beta', kind: 'Lemma', kindId: 'lemma', color: '#fff', background: '#000' }
      ],
      edges: [{ id: 'r', from: 'a', to: 'b', label: 'uses', isDependency: false, isAtomic: null }]
    });
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Entry Alpha (a)' }), {
      clientX: 100, clientY: 100
    });
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'requestEntryDetails', entryId: 'a', entryPackage: 'logic'
    })), { timeout: 1600 });
  });

  it('creates deterministic accessible package lanes containing every node and a cross-package edge', () => {
    render(<SnlGraphApp />);
    const graph = (nodes: Array<Record<string, unknown>>) => ({
      type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [], entryOptions: [], macros: {}, macroKinds: [],
      nodes,
      edges: [{ id: 'cross', from: 'a', to: 'z', label: 'uses', isDependency: false, isAtomic: null }]
    });
    const alpha = { id: 'a', packageId: 'alpha', title: 'Alpha', kind: 'Theorem', kindId: 'theorem', color: '#fff', background: '#000' };
    const zeta = { id: 'z', packageId: 'zeta', title: 'Zeta', kind: 'Lemma', kindId: 'lemma', color: '#fff', background: '#000' };
    send(graph([zeta, alpha]));

    const alphaLane = screen.getByRole('group', { name: 'Package alpha: 1 entry' });
    const zetaLane = screen.getByRole('group', { name: 'Package zeta: 1 entry' });
    const firstBounds = [alphaLane.getAttribute('data-cluster-bounds'), zetaLane.getAttribute('data-cluster-bounds')];
    expect(Number(firstBounds[0]?.split(',')[0])).toBeLessThan(Number(firstBounds[1]?.split(',')[0]));
    for (const [lane, nodeName] of [[alphaLane, 'Entry Alpha (a)'], [zetaLane, 'Entry Zeta (z)']] as const) {
      const [x, , width] = (lane.getAttribute('data-cluster-bounds') ?? '').split(',').map(Number);
      const node = screen.getByRole('button', { name: nodeName });
      const nodeX = Number(node.getAttribute('transform')?.match(/translate\(([^ ]+)/)?.[1]);
      expect(nodeX).toBeGreaterThan(x);
      expect(nodeX).toBeLessThan(x + width);
      expect(node.getAttribute('data-package-id')).toBe(lane.getAttribute('data-package-id'));
    }
    expect(screen.getByRole('button', { name: 'Relationship uses: a to z' }).querySelector('path')?.getAttribute('d')).toMatch(/^M /);

    send(graph([alpha, zeta]));
    expect([
      screen.getByRole('group', { name: 'Package alpha: 1 entry' }).getAttribute('data-cluster-bounds'),
      screen.getByRole('group', { name: 'Package zeta: 1 entry' }).getAttribute('data-cluster-bounds')
    ]).toEqual(firstBounds);
  });

  it('localizes the Unpackaged cluster label', () => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = 'zh-CN';
    try {
      render(<SnlGraphApp />);
      send({
        type: 'graph', scope: { mode: 'pool' }, title: 'Graph', warnings: [], entryOptions: [], macros: {}, macroKinds: [],
        nodes: [
          { id: 'a', packageId: '_unpackaged', title: 'Alpha', kind: 'Theorem', kindId: 'theorem', color: '#fff', background: '#000' },
          { id: 'b', packageId: '_unpackaged', title: 'Beta', kind: 'Lemma', kindId: 'lemma', color: '#fff', background: '#000' }
        ],
        edges: [{ id: 'r', from: 'a', to: 'b', label: 'uses', isDependency: false, isAtomic: null }]
      });
      expect(screen.getByText('未分包')).toBeTruthy();
    } finally {
      document.documentElement.lang = previous;
    }
  });
});
