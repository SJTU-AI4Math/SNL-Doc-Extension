// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import type { VsCodeApi } from './vscodeApi';
import { editorDraftKey, loadDraft } from './components/draftState';
import { set_content_language } from './runtime/preferencesRuntime';

const postMessage = vi.fn();
let persistedState: unknown = {};
const testApi: VsCodeApi = {
  postMessage,
  getState: () => persistedState,
  setState: (next) => { persistedState = next; }
};

afterEach(() => {
  cleanup();
  postMessage.mockReset();
  persistedState = {};
  set_content_language('en');
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

function sendGraph(overrides: Record<string, unknown> = {}): void {
  send({
    type: 'graph', nodes: [], relationships: [], entries: [], kinds: [],
    metricMacroSources: {}, metricThresholds: {}, warnings: [], ...overrides
  });
}

function setupApi(): void {
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = testApi;
}

describe('Create Library feedback', () => {
  it('projects Entry Kind badges through the live content language', async () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', content: { snl: 'foo' } }],
      kinds: [{
        id: 'definition',
        name: { type: 'i18n', default_language: 'en', values: { en: 'Definition', 'zh-CN': '定义' } },
        description: { type: 'i18n', default_language: 'en', values: { en: 'Term', 'zh-CN': '术语' } },
        defaultCounterName: 'definition',
        coloring: {
          light: { stroke: '#111111', background: '#eeeeee' },
          dark: { stroke: '#dddddd', background: '#222222' }
        }
      }]
    });
    const badge = screen.getByText('Definition');
    expect(badge.getAttribute('title')).toBe('Term');
    act(() => set_content_language('zh-CN'));
    await waitFor(() => expect(screen.getByText('定义')).toBeTruthy());
    expect(screen.getByText('定义').getAttribute('title')).toBe('术语');
  });

  it('routes the shared add-parent action to counter mutation and the outline add form', async () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', existing: { slug: 'demo', title: 'Demo' } });
    send({
      type: 'countersLoaded',
      counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }]
    });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', content: { snl: 'foo' } }]
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    const counterRow = screen.getByDisplayValue('theorem').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(counterRow).getByRole('button', { name: 'Add parent node' }));
    await waitFor(() => expect(screen.getByDisplayValue('counter')).toBeTruthy());
    expect(postMessage.mock.calls.some(([message]) => message?.type === 'counterOp')).toBe(false);

    const entryInput = screen.getByRole('combobox', { name: 'Entry id' });
    const entryRow = entryInput.closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(entryRow).getByRole('button', { name: 'Add parent node' }));
    expect(screen.getByText('Entry id')).toBeTruthy();
  });

  it('renders Add root entry as a full-width row action', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph();

    const addRoot = screen.getByRole('button', { name: '+ Add root entry' });
    expect(addRoot.style.width).toBe('100%');
    expect(addRoot.style.display).toBe('block');
  });

  it('defaults both structural trees closed and keeps all controls transient', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    send({ type: 'countersLoaded', counters: [
      { id: 'counter-root', name: 'root-counter', numbering: '1', children: [
        { id: 'counter-child', name: 'child-counter', numbering: 'a', children: [] }
      ] }
    ] });
    sendGraph({
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-root' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } }
      ],
      relationships: [{ from: 'root', to: 'child', label: 'branch' }],
      entries: [
        { id: 'entry-root', title: 'Root', kind: 'definition', hasContent: true },
        { id: 'entry-child', title: 'Child', kind: 'definition', hasContent: true }
      ]
    });
    expect(screen.getByRole('button', { name: 'Expand root' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    expect(screen.getByRole('button', { name: 'Expand counter-root' })).toBeTruthy();
    postMessage.mockClear();
    for (const button of screen.getAllByRole('button', { name: 'Expand all' })) fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Collapse root' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse counter-root' })).toBeTruthy();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('starts the Counters section collapsed in edit mode', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    send({ type: 'countersLoaded', counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }] });

    expect(screen.getByRole('button', { name: 'Expand counters' })).toBeTruthy();
    expect(screen.queryByDisplayValue('theorem')).toBeNull();
  });

  it('transitions the same create surface to edit mode after creation', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'create' });

    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Real Analysis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Library' }));
    send({ type: 'created', slug: 'real-analysis', title: 'Real Analysis' });

    expect(screen.getByRole('heading', { name: 'Edit Library' })).toBeTruthy();
    expect(screen.getByDisplayValue('real-analysis')).toBeTruthy();
    expect(screen.getByDisplayValue('Real Analysis')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update Title' })).toBeNull();
  });

  it('clears both the completed create draft and the destination edit draft', async () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'create' });
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Real Analysis' } });
    await waitFor(() => expect(loadDraft(testApi, editorDraftKey('library', 'create', ''))).toBeTruthy());

    send({ type: 'created', slug: 'real-analysis', title: 'Real Analysis' });

    await waitFor(() => {
      expect(loadDraft(testApi, editorDraftKey('library', 'create', ''))).toBeUndefined();
      expect(loadDraft(testApi, editorDraftKey('library', 'edit', 'real-analysis'))).toBeUndefined();
    });
  });

  it('keeps Entry suggestions opaque and in flow above the Create action', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({ entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', hasContent: true }] });

    fireEvent.click(screen.getByRole('button', { name: '+ Add root entry' }));
    const input = screen.getByLabelText('Entry id');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'entry' } });

    const menu = screen.getByRole('listbox');
    expect(menu.style.position).toBe('static');
    expect(menu.style.background).not.toContain('transparent');
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('changes which Entry an outline node indexes without changing graph-local identity', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      relationships: [],
      entries: [
        {
          id: 'entry-one',
          title: 'Entry One',
          kind: 'definition',
          hasContent: true,
          content: { snl: 'entry_one' }
        },
        { id: 'entry-two', title: 'Entry Two', kind: 'definition', hasContent: true }
      ]
    });

    expect(screen.queryByRole('button', { name: /copy entry id/i })).toBeNull();
    expect(screen.queryByText('Entry ID indexed by node n_1')).toBeNull();
    const entryId = screen.getByRole('combobox', { name: 'Entry id' }) as HTMLInputElement;
    const entryIdEditor = entryId.closest('[data-testid="outline-entry-id-slot"]');
    const ssi = screen.getByText(/^SSI /);
    const title = screen.getByRole('button', { name: 'Entry One' });
    expect(entryIdEditor?.nextElementSibling).toBe(title);
    expect(entryIdEditor?.closest('.snl-outline-row')
      ?.querySelector('.snl-outline-row-toolbar')?.contains(ssi)).toBe(true);
    expect(title.nextElementSibling).toBeNull();
    expect(entryId.value).toBe('entry-one');
    entryId.focus();
    fireEvent.change(entryId, { target: { value: 'entry-t' } });
    expect(screen.getByRole('option', { name: /entry-two.*Entry Two/ })).toBeTruthy();
    expect(postMessage.mock.calls.some(([message]) =>
      message?.type === 'graphOp' && message?.op?.op === 'setNodeEntryId'
    )).toBe(false);
    fireEvent.keyDown(entryId, { key: 'Enter' });

    expect(entryId.value).toBe('entry-two');
    expect(postMessage.mock.calls.filter(([message]) => message?.type === 'graphOp')).toHaveLength(0);
    expect(postMessage.mock.calls.some(([message]) =>
      message?.type === 'graphOp' && message?.op?.op === 'renameNode'
    )).toBe(false);
  });

  it('opens an indexed Entry on a real primary pointer sequence', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', hasContent: true }]
    });

    const title = screen.getByRole('button', { name: 'Entry One' });
    expect(title).toBeInstanceOf(HTMLButtonElement);
    fireEvent.pointerDown(title, { button: 0, clientX: 40, clientY: 30 });
    fireEvent.pointerUp(title, { button: 0, clientX: 40, clientY: 30 });
    fireEvent.click(title, { button: 0, clientX: 40, clientY: 30 });

    expect(postMessage).toHaveBeenCalledWith({ type: 'openEditEntry', entryId: 'entry-one' });
  });

  it('keeps the counter at the left and uses distinct Kind stroke/background roles', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    send({
      type: 'countersLoaded',
      counters: [
        { id: 'counter-main', name: 'theorem', numbering: '1.2.3', children: [] },
        { id: 'counter-alt', name: 'lemma', numbering: 'I', children: [] }
      ]
    });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', hasContent: true }],
      kinds: [{
        id: 'definition', name: 'Definition', defaultCounterName: 'theorem',
        coloring: { light: { stroke: '#00ff00', background: '#ff0000' }, dark: { stroke: '#00ff00', background: '#ff0000' } }
      }]
    });

    const row = screen.getByRole('combobox', { name: 'Entry id' }).closest<HTMLElement>('.snl-outline-row')!;
    const main = row.querySelector<HTMLElement>('[data-snl-library-row-main]')!;
    const counter = within(row).getByTestId('outline-counter-control');
    const entryIdSlot = within(row).getByTestId('outline-entry-id-slot');
    const kind = within(row).getByText('Definition');

    expect(within(counter).getByText('【1.2.3】')).toBeTruthy();
    expect(within(counter).queryByRole('combobox', { name: 'Counter' })).toBeNull();
    expect(main.firstElementChild).toBe(counter);
    expect(entryIdSlot.parentElement).toBe(main);
    expect(getComputedStyle(row).alignItems).toBe('flex-start');
    expect(row.style.paddingRight).toBe('0px');
    expect(getComputedStyle(main).gridTemplateColumns).not.toBe('');
    expect(kind.style.borderColor).toBe('rgb(0, 255, 0)');
    expect(kind.style.background).toBe('rgb(255, 0, 0)');
    expect(kind.style.color).toBe('rgb(0, 255, 0)');
    expect(kind.getAttribute('title')).toBe('Definition');
    expect(kind.style.overflow).toBe('hidden');
    expect(kind.style.textOverflow).toBe('ellipsis');
    expect(kind.classList.contains('snl-library-outline-kind')).toBe(true);

    fireEvent.mouseEnter(counter);
    const counterSelect = within(counter).getByRole('combobox', { name: 'Counter' });
    fireEvent.change(counterSelect, { target: { value: 'counter-alt' } });
    expect(postMessage.mock.calls.some(([message]) => message?.type === 'graphOp')).toBe(false);
    fireEvent.mouseLeave(counter);
    expect(within(counter).getByText('【I】')).not.toBeNull();

    expect(counter.tabIndex).toBe(0);
    fireEvent.focus(counter);
    const keyboardSelect = within(counter).getByRole('combobox', { name: 'Counter' });
    fireEvent.mouseLeave(counter);
    expect(within(counter).getByRole('combobox', { name: 'Counter' })).toBe(keyboardSelect);
    fireEvent.blur(keyboardSelect, { relatedTarget: null });
    expect(within(counter).getByText('【I】')).not.toBeNull();

    fireEvent.pointerDown(counter, { pointerType: 'touch' });
    fireEvent.click(counter);
    const touchSelect = within(counter).getByRole('combobox', { name: 'Counter' });
    expect(document.activeElement).toBe(touchSelect);
  });

  it('publishes the tree depth offset without moving the Kind, Entry id, and Title grid', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-root' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } },
        { id: 'grand', label: 'Entry', props: { entryId: 'entry-grand' } },
        { id: 'great', label: 'Entry', props: { entryId: 'entry-great' } }
      ],
      relationships: [
        { from: 'root', to: 'child', label: 'branch' },
        { from: 'child', to: 'grand', label: 'branch' },
        { from: 'grand', to: 'great', label: 'branch' }
      ],
      entries: [
        { id: 'entry-root', title: 'Root title', kind: 'definition', hasContent: true },
        { id: 'entry-child', title: 'Child title', kind: 'definition', hasContent: true },
        { id: 'entry-grand', title: 'Grand title', kind: 'definition', hasContent: true },
        { id: 'entry-great', title: 'Great title', kind: 'definition', hasContent: true }
      ],
      kinds: [{
        id: 'definition', name: 'Definition', defaultCounterName: '',
        coloring: { light: { stroke: '#00ff00', background: '#ff0000' }, dark: { stroke: '#00ff00', background: '#ff0000' } }
      }]
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const rootMain = screen.getByDisplayValue('entry-root')
      .closest<HTMLElement>('[data-snl-library-row-main]');
    const childMain = screen.getByDisplayValue('entry-child')
      .closest<HTMLElement>('[data-snl-library-row-main]');
    const greatMain = screen.getByDisplayValue('entry-great')
      .closest<HTMLElement>('[data-snl-library-row-main]');
    expect(rootMain?.style.getPropertyValue('--snl-library-outline-depth-offset')).toBe('0rem');
    expect(childMain?.style.getPropertyValue('--snl-library-outline-depth-offset')).toBe('1.5rem');
    expect(greatMain?.className).toBe('snl-library-outline-row-main');
    const rootCounter = rootMain?.querySelector<HTMLElement>('.snl-library-outline-counter');
    const childCounter = childMain?.querySelector<HTMLElement>('.snl-library-outline-counter');
    expect(rootCounter).not.toBeNull();
    expect(childCounter).not.toBeNull();
    const childMetric = childMain?.closest('.snl-outline-row')
      ?.querySelector<HTMLElement>('.snl-library-outline-metric');
    expect(childMetric?.closest('.snl-outline-row-toolbar')).not.toBeNull();
    expect(
      childMain?.closest('.snl-outline-row')
        ?.querySelector<HTMLElement>('.snl-outline-disclosure-spacer, button[aria-label^="Collapse "]')?.style.width
    ).toBe('1.5rem');
  });

  it('cancels an indexed Entry id edit with Escape', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', hasContent: true }]
    });

    const entryId = screen.getByRole('combobox', { name: 'Entry id' }) as HTMLInputElement;
    entryId.focus();
    fireEvent.change(entryId, { target: { value: 'discard-me' } });
    fireEvent.keyDown(entryId, { key: 'Escape' });
    fireEvent.blur(entryId);

    expect(entryId.value).toBe('entry-one');
    expect(postMessage.mock.calls.some(([message]) =>
      message?.type === 'graphOp' && message?.op?.op === 'setNodeEntryId'
    )).toBe(false);
  });
});
