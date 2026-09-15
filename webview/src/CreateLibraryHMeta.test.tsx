// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import type { VsCodeApi } from './vscodeApi';


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


it('recovers the first context error without a prior hydration and keeps unrelated write failures', () => {
  setup(); render(<CreateLibraryApp />);
  send({ type: 'error', scope: 'context', slug: 'algebra', message: 'Broken initial metadata' });
  expect(screen.getByText(/Broken initial metadata/)).toBeTruthy();
  hydrate();
  expect(screen.queryByText(/Broken initial metadata/)).toBeNull();
  expect(screen.getByDisplayValue('Algebra')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  expect(postMessage.mock.calls.find(([m]) => m.type === 'saveLibraryDraft')![0]).toMatchObject({
    slug: 'algebra', title: 'Algebra', graph: { nodes: [{ id: 'root' }, { id: 'child' }] },
    counters: [{ id: 'counter-1' }], expectedRevisions: { meta: 'meta-r1', graph: 'graph-r1', counters: 'counter-r1' }
  });
  send({ type: 'error', message: 'Write failed' });
  hydrate();
  expect(screen.getByText(/Write failed/)).toBeTruthy();
});

it.each(['', '   '])('keeps an empty or whitespace metadata diagnostic fail-closed (%j)', (message) => {
  setup(); render(<CreateLibraryApp />); hydrate();
  send({ type: 'libraryMetadataError', slug: 'algebra', message });
  expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Could not refresh Library metadata\./)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  expect(postMessage.mock.calls.some(([m]) => m.type === 'saveLibraryDraft')).toBe(false);
  send({ type: 'libraryMetadata', slug: 'algebra', targetState: 'found', libraryRevision: 'a'.repeat(64), existing: { slug: 'algebra', title: 'Recovered' } });
  expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(false);
});

it('metadata refresh preserves hydrated graph/counters, dirty CAS and rejects foreign/malformed metadata', () => {
  setup(); render(<CreateLibraryApp />); hydrate();
  const metadata = { type: 'libraryMetadata', slug: 'algebra', targetState: 'found', existing: { slug: 'algebra', title: 'Remote' }, libraryRevision: 'a'.repeat(64) };
  for (const invalid of [
    { ...metadata, slug: 'other' }, { ...metadata, existing: { slug: 'other', title: 'Bad' } },
    { ...metadata, libraryRevision: 1 }, { ...metadata, libraryRevision: '' },
    { ...metadata, existing: null }, { ...metadata, existing: { slug: 'algebra', title: 1 } }
  ]) { send(invalid); expect(screen.getByDisplayValue('Algebra')).toBeTruthy(); }
  send({ type: 'libraryMetadataError', slug: 'algebra', message: 'Denied' });
  expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true);
  send(metadata);
  expect(screen.queryByText(/Denied/)).toBeNull();
  expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByDisplayValue('Remote')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Library title'), { target: { value: 'Local' } });
  send({ ...metadata, libraryRevision: 'b'.repeat(64), existing: { slug: 'algebra', title: 'Foreign' } });
  send({ type: 'updated', slug: 'algebra', title: 'Legacy', revision: 'c'.repeat(64) });
  send({ ...metadata, slug: 'other' });
  send({ ...metadata, libraryRevision: 5 });
  expect(screen.getByDisplayValue('Local')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  const saved = postMessage.mock.calls.find(([m]) => m.type === 'saveLibraryDraft')![0];
  expect(saved).toMatchObject({ title: 'Local', graph: { nodes: [{ id: 'root' }, { id: 'child' }] }, counters: [{ id: 'counter-1' }], expectedRevisions: { meta: 'a'.repeat(64), graph: 'graph-r1', counters: 'counter-r1' } });
});
