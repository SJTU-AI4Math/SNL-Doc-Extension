// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import type { VsCodeApi } from './vscodeApi';
import { editorDraftKey, loadDraft } from './components/draftState';

const postMessage = vi.fn();
let persistedState: unknown = {};
const api: VsCodeApi = {
  postMessage,
  getState: () => persistedState,
  setState: (next) => { persistedState = next; }
};

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

function hydrate(): void {
  send({
    type: 'context', mode: 'edit', requestId: 'load-1', slug: 'algebra',
    targetState: 'found', libraryRevision: 'meta-r1',
    existing: { slug: 'algebra', title: 'Algebra' }
  });
  send({
    type: 'graph', requestId: 'load-1', graphRevision: 'graph-r1',
    nodes: [
      { id: 'root', label: 'Entry', props: { entryId: 'entry-root' } },
      { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } }
    ],
    relationships: [{ from: 'root', to: 'child', label: 'branch' }],
    entries: [
      { id: 'entry-root', title: 'Root', kind: 'definition', content: { snl: 'root' } },
      { id: 'entry-child', title: 'Child', kind: 'definition', content: { snl: 'child' } }
    ],
    kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: 'theorem' }],
    metricMacroSources: {}, metricThresholds: {}, warnings: []
  });
  send({
    type: 'countersLoaded', requestId: 'load-1', countersRevision: 'counter-r1',
    counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }]
  });
}

function setup(): void {
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = api;
}

afterEach(() => {
  cleanup();
  postMessage.mockReset();
  persistedState = {};
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Library edit whole-draft save', () => {
  it('keeps title, graph, and counter edits local until the single bottom save', async () => {
    setup();
    render(<CreateLibraryApp />);
    hydrate();
    postMessage.mockClear();

    const titleInput = screen.getByLabelText('Library title');
    fireEvent.change(titleInput, { target: { value: 'Local Algebra' } });
    fireEvent.keyDown(titleInput, { key: 'Enter' });
    expect(postMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    const counterName = screen.getByRole('textbox', { name: 'Counter name' });
    fireEvent.change(counterName, { target: { value: 'local-theorem' } });
    fireEvent.blur(counterName);

    fireEvent.click(screen.getByRole('button', { name: 'Expand root' }));
    const childRow = screen.getByDisplayValue('entry-child').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(childRow).getByRole('button', { name: 'Outdent' }));

    expect(screen.getByDisplayValue('Local Algebra')).toBeTruthy();
    expect(screen.getByDisplayValue('local-theorem')).toBeTruthy();
    expect(postMessage.mock.calls.some(([message]) =>
      ['update', 'graphOp', 'counterOp', 'saveLibraryDraft'].includes(message?.type)
    )).toBe(false);
    expect(screen.queryByRole('button', { name: 'Update Title' })).toBeNull();

    const outlineHeading = screen.getByRole('heading', { name: 'Outline' });
    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(outlineHeading.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(save);

    const mutations = postMessage.mock.calls.map(([message]) => message)
      .filter((message) => ['update', 'graphOp', 'counterOp', 'saveLibraryDraft'].includes(message?.type));
    expect(mutations).toEqual([{
      type: 'saveLibraryDraft', requestId: expect.any(String), slug: 'algebra',
      title: 'Local Algebra',
      graph: {
        nodes: [
          { id: 'root', label: 'Entry', props: { entryId: 'entry-root' } },
          { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } }
        ],
        relationships: []
      },
      counters: [{ id: 'counter-1', name: 'local-theorem', numbering: '1', children: [] }],
      expectedRevisions: { meta: 'meta-r1', graph: 'graph-r1', counters: 'counter-r1' }
    }]);
  });

  it('keeps outline deletion local but requires confirmation before changing the draft', () => {
    setup();
    render(<CreateLibraryApp />);
    hydrate();
    postMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Expand root' }));
    const childRow = screen.getByDisplayValue('entry-child').closest<HTMLElement>('.snl-outline-row')!;

    fireEvent.click(within(childRow).getByRole('button', { name: 'Delete subtree' }));

    expect(screen.getByRole('dialog', { name: 'Remove outline entry?' })).toBeTruthy();
    expect(screen.getByDisplayValue('entry-child')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from outline' }));
    expect(screen.queryByDisplayValue('entry-child')).toBeNull();
    expect(postMessage.mock.calls.some(([message]) => message?.type === 'graphOp')).toBe(false);
  });

  it('includes the active Counter input draft when Ctrl+S is pressed without blur', () => {
    setup();
    render(<CreateLibraryApp />);
    hydrate();
    postMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    const counterName = screen.getByRole('textbox', { name: 'Counter name' });
    fireEvent.change(counterName, { target: { value: 'typed-without-blur' } });

    fireEvent.keyDown(counterName, { key: 's', code: 'KeyS', ctrlKey: true });

    expect(postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0])
      .toMatchObject({ counters: [{ id: 'counter-1', name: 'typed-without-blur' }] });
  });

  it('finishes the initial Graph and Counter hydration after an early title edit', () => {
    setup();
    render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', requestId: 'load-race', slug: 'algebra',
      targetState: 'found', libraryRevision: 'meta-r1',
      existing: { slug: 'algebra', title: 'Algebra' }
    });
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Early title' } });
    send({
      type: 'graph', requestId: 'load-race', graphRevision: 'graph-r1',
      nodes: [{ id: 'root', label: 'Entry', props: { entryId: 'entry-root' } }],
      relationships: [], entries: [{ id: 'entry-root', title: 'Root', kind: 'definition' }],
      kinds: [{ id: 'definition', name: 'Definition', defaultCounterName: 'theorem' }],
      metricMacroSources: {}, metricThresholds: {}, warnings: []
    });
    send({
      type: 'countersLoaded', requestId: 'load-race', countersRevision: 'counter-r1',
      counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }]
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    expect(screen.getByDisplayValue('theorem')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0])
      .toMatchObject({
        title: 'Early title',
        graph: { nodes: [{ id: 'root' }] },
        counters: [{ id: 'counter-1' }],
        expectedRevisions: { meta: 'meta-r1', graph: 'graph-r1', counters: 'counter-r1' }
      });
  });

  it('preserves a dirty whole draft across watcher pushes and remount', async () => {
    setup();
    const first = render(<CreateLibraryApp />);
    hydrate();
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Draft title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    const counterName = screen.getByRole('textbox', { name: 'Counter name' });
    fireEvent.change(counterName, { target: { value: 'draft-counter' } });
    fireEvent.blur(counterName);
    fireEvent.click(screen.getByRole('button', { name: 'Expand root' }));
    const childRow = screen.getByDisplayValue('entry-child').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(childRow).getByRole('button', { name: 'Outdent' }));

    send({ type: 'context', mode: 'edit', requestId: 'watch-2', slug: 'algebra', libraryRevision: 'meta-r2', existing: { slug: 'algebra', title: 'External title' } });
    send({ type: 'graph', requestId: 'watch-2', graphRevision: 'graph-r2', nodes: [], relationships: [], entries: [], kinds: [], metricMacroSources: {}, metricThresholds: {}, warnings: [] });
    send({ type: 'countersPushed', requestId: 'watch-2', countersRevision: 'counter-r2', counters: [] });

    expect(screen.getByDisplayValue('Draft title')).toBeTruthy();
    expect(screen.getByDisplayValue('draft-counter')).toBeTruthy();
    expect(screen.getByDisplayValue('entry-child')).toBeTruthy();
    await waitFor(() => expect(loadDraft<any>(api, editorDraftKey('library', 'edit', 'algebra'))).toMatchObject({
      title: 'Draft title',
      expectedRevisions: { meta: 'meta-r1', graph: 'graph-r1', counters: 'counter-r1' }
    }));

    first.unmount();
    render(<CreateLibraryApp />);
    hydrate();
    expect(screen.getByDisplayValue('Draft title')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    expect(screen.getByDisplayValue('draft-counter')).toBeTruthy();
    expect(screen.getByDisplayValue('entry-child')).toBeTruthy();
  });

  it('clears the whole draft only after a correlated successful save', async () => {
    setup();
    render(<CreateLibraryApp />);
    hydrate();
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Saved title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const requestId = postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0].requestId;

    send({ type: 'libraryDraftSaveError', requestId, message: 'conflict' });
    await waitFor(() => expect(loadDraft(api, editorDraftKey('library', 'edit', 'algebra'))).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const retryRequestId = postMessage.mock.calls.filter(([message]) =>
      message?.type === 'saveLibraryDraft'
    ).at(-1)?.[0].requestId;
    send({
      type: 'libraryDraftSaved', requestId: retryRequestId, slug: 'algebra', title: 'Saved title',
      revisions: { meta: 'meta-r2', graph: 'graph-r2', counters: 'counter-r2' }
    });
    await waitFor(() => expect(loadDraft(api, editorDraftKey('library', 'edit', 'algebra'))).toBeUndefined());
  });

  it('rebases relationship draft identities after save before a second edit', () => {
    setup();
    render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', requestId: 'load-1', slug: 'algebra',
      targetState: 'found', libraryRevision: 'meta-r1',
      existing: { slug: 'algebra', title: 'Algebra' }
    });
    send({
      type: 'graph', requestId: 'load-1', graphRevision: 'graph-r1',
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-root' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } },
        { id: 'grandchild', label: 'Entry', props: { entryId: 'entry-grandchild' } }
      ],
      relationships: [
        { from: 'root', to: 'child', label: 'branch', _draftKey: '0' },
        { from: 'child', to: 'grandchild', label: 'branch', _draftKey: '1' }
      ],
      entries: [
        { id: 'entry-root', title: 'Root', kind: 'definition' },
        { id: 'entry-child', title: 'Child', kind: 'definition' },
        { id: 'entry-grandchild', title: 'Grandchild', kind: 'definition' }
      ],
      kinds: [], metricMacroSources: {}, metricThresholds: {}, warnings: []
    });
    send({
      type: 'countersLoaded', requestId: 'load-1', countersRevision: 'counter-r1', counters: []
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expand root' }));
    const childRow = screen.getByDisplayValue('entry-child').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(childRow).getByRole('button', { name: 'Outdent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const firstSave = postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0];
    send({
      type: 'libraryDraftSaved', requestId: firstSave.requestId, slug: 'algebra', title: 'First save',
      revisions: { meta: 'meta-r2', graph: 'graph-r2', counters: 'counter-r2' }
    });

    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Second save' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const secondSave = postMessage.mock.calls.filter(([message]) =>
      message?.type === 'saveLibraryDraft'
    ).at(-1)?.[0];
    expect(secondSave.graph.relationships).toEqual([
      { from: 'child', to: 'grandchild', label: 'branch', _draftKey: '0' }
    ]);
  });

  it('rebases relationship identities when the graph changes while a save is in flight', () => {
    setup();
    render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', requestId: 'load-1', slug: 'algebra',
      targetState: 'found', libraryRevision: 'meta-r1',
      existing: { slug: 'algebra', title: 'Algebra' }
    });
    send({
      type: 'graph', requestId: 'load-1', graphRevision: 'graph-r1',
      nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'entry-root' } },
        { id: 'child-1', label: 'Entry', props: { entryId: 'entry-child-1' } },
        { id: 'child-2', label: 'Entry', props: { entryId: 'entry-child-2' } }
      ],
      relationships: [
        { from: 'root', to: 'child-1', label: 'branch', _draftKey: '0' },
        { from: 'root', to: 'child-2', label: 'branch', _draftKey: '1' }
      ],
      entries: [
        { id: 'entry-root', title: 'Root', kind: 'definition' },
        { id: 'entry-child-1', title: 'Child 1', kind: 'definition' },
        { id: 'entry-child-2', title: 'Child 2', kind: 'definition' }
      ],
      kinds: [], metricMacroSources: {}, metricThresholds: {}, warnings: []
    });
    send({ type: 'countersLoaded', requestId: 'load-1', countersRevision: 'counter-r1', counters: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Expand root' }));
    let childOneRow = screen.getByDisplayValue('entry-child-1').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(childOneRow).getByRole('button', { name: 'Move down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const firstSave = postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0];

    childOneRow = screen.getByDisplayValue('entry-child-1').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(childOneRow).getByRole('button', { name: 'Move up' }));
    send({
      type: 'libraryDraftSaved', requestId: firstSave.requestId, slug: 'algebra', title: 'Algebra',
      revisions: { meta: 'meta-r2', graph: 'graph-r2', counters: 'counter-r2' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const secondSave = postMessage.mock.calls.filter(([message]) =>
      message?.type === 'saveLibraryDraft'
    ).at(-1)?.[0];
    expect(secondSave.graph.relationships).toEqual([
      { from: 'root', to: 'child-1', label: 'branch', _draftKey: '1' },
      { from: 'root', to: 'child-2', label: 'branch', _draftKey: '0' }
    ]);
  });

  it('keeps edits made after submission when the older save is acknowledged', async () => {
    setup();
    render(<CreateLibraryApp />);
    hydrate();
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Submitted title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const firstSave = postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0];

    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Newer local title' } });
    const pendingSaveButton = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
    expect(pendingSaveButton.disabled).toBe(true);
    fireEvent.click(pendingSaveButton);
    expect(postMessage.mock.calls.filter(([message]) => message?.type === 'saveLibraryDraft')).toHaveLength(1);
    send({
      type: 'libraryDraftSaved', requestId: firstSave.requestId, slug: 'algebra', title: 'Submitted title',
      revisions: { meta: 'meta-r2', graph: 'graph-r2', counters: 'counter-r2' }
    });

    expect(screen.getByDisplayValue('Newer local title')).toBeTruthy();
    await waitFor(() => expect(loadDraft<any>(api, editorDraftKey('library', 'edit', 'algebra')))
      .toMatchObject({ title: 'Newer local title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(postMessage.mock.calls.filter(([message]) => message?.type === 'saveLibraryDraft').at(-1)?.[0])
      .toMatchObject({
        title: 'Newer local title',
        expectedRevisions: { meta: 'meta-r2', graph: 'graph-r2', counters: 'counter-r2' }
      });
  });

  it('ignores an old save acknowledgement after retargeting to another Library', () => {
    setup();
    render(<CreateLibraryApp />);
    hydrate();
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Pending A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    const saveA = postMessage.mock.calls.find(([message]) => message?.type === 'saveLibraryDraft')?.[0];

    send({
      type: 'context', mode: 'edit', requestId: 'load-b', slug: 'topology',
      targetState: 'found', libraryRevision: 'meta-b1',
      existing: { slug: 'topology', title: 'Topology' }
    });
    send({
      type: 'graph', requestId: 'load-b', graphRevision: 'graph-b1',
      nodes: [], relationships: [], entries: [], kinds: [], metricMacroSources: {},
      metricThresholds: {}, warnings: []
    });
    send({
      type: 'countersLoaded', requestId: 'load-b', countersRevision: 'counter-b1', counters: []
    });
    send({
      type: 'libraryDraftSaved', requestId: saveA.requestId, slug: 'algebra', title: 'Pending A',
      revisions: { meta: 'meta-a2', graph: 'graph-a2', counters: 'counter-a2' }
    });

    expect(screen.getByDisplayValue('Topology')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Local B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(postMessage.mock.calls.filter(([message]) => message?.type === 'saveLibraryDraft').at(-1)?.[0])
      .toMatchObject({
        slug: 'topology', title: 'Local B',
        expectedRevisions: { meta: 'meta-b1', graph: 'graph-b1', counters: 'counter-b1' }
      });
  });
});
