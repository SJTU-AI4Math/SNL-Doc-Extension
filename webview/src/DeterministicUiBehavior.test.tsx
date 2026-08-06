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
      kindsByMode: { entry: ['theorem'], macro: ['const'] }
    });
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('group');
    expect(screen.getByRole('tab', { name: 'Macro' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('const');
    const queryCount = posted.filter(
      (message) => (message as { type?: string }).type === 'query'
    ).length;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(posted.filter(
      (message) => (message as { type?: string }).type === 'query'
    )).toHaveLength(queryCount);
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
        { id: 'a', title: 'Alpha', kind: 'Theorem', kindId: 'theorem', color: '#fff', background: '#000' },
        { id: 'b', title: 'Beta', kind: 'Lemma', kindId: 'lemma', color: '#fff', background: '#000' }
      ],
      edges: [{ id: 'r', from: 'a', to: 'b', label: 'uses', isDependency: false, isAtomic: null }]
    });
    const node = screen.getByRole('button', { name: 'Entry Alpha (a)' });
    const edge = screen.getByRole('button', { name: 'Relationship uses: a to b' });
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
        { id: 'a', title: 'Alpha', kind: 'Theorem', kindId: 'theorem', color: '#fff', background: '#000' },
        { id: 'b', title: 'Beta', kind: 'Lemma', kindId: 'lemma', color: '#fff', background: '#000' }
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
});
