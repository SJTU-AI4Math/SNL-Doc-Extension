import { HoverPopoverProvider } from '../render/HoverPopoverProvider';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { EntryInfoviewApp } from '../EntryInfoviewApp';
vi.mock('../vscodeApi', async (original) => ({ ...(await original<typeof import('../vscodeApi')>()), useVsCodeApiRef: () => ({ current: { postMessage() {} } }) }));
import { LibraryOutline, type RenderCtx } from './LibraryReader';
import { EntryReader, type EntryReaderState } from './EntryReader';

afterEach(cleanup);
const entry = { id: 'target', kind: 'definition', title: 'Target', content: { snl: 'free' }, pointer: null };
const cachedEntryMetrics = { scope: 'workspace', status: 'ready', entries: { target: {
  kind: 'ok', metrics: { structuralIndex: 0.75, strongSemanticFreedom: 1,
    weakSemanticFreedom: 0, weightedTotal: 4, weightedStrongSemanticFreedom: 1, weightedWeakSemanticFreedom: 0 }
} } };
it('Library occurrences consume supplied workspace SSI rather than recomputing from local content', () => {
  const ctx = { postMessage() {}, goBack() {}, entryPool: [], entryPackages: {}, userMacros: undefined,
    kindPalette: undefined, exportHtml() {}, outlineRef: { current: null }, cachedEntryMetrics } as RenderCtx;
  const node = { nodeId: 'one', entry, kind: null, counterLabel: null, children: [] };
  const view = render(<HoverPopoverProvider entries={[]} postMessage={() => {}}><LibraryOutline nodes={[node, { ...node, nodeId: 'two' }]} ctx={ctx} /></HoverPopoverProvider>);
  expect(view.getAllByText('SSI 0.75')).toHaveLength(2);
});
it('Entry reader consumes workspace SSI and marks absent frozen analysis unavailable, never zero', () => {
  const state = { entry, kind: null, entries: [], entryPackages: {}, relationshipSections: [],
    relatedEntries: [], relationshipsError: null, returnRoute: { kind: 'root' }, cachedEntryMetrics } as EntryReaderState;
  const view = render(<EntryReader state={state} loaded loadError={null} macroKinds={[]} postMessage={() => {}} />);
  expect(view.getByText('SSI 0.75')).toBeTruthy();
  view.rerender(<EntryReader state={{ ...state, cachedEntryMetrics: undefined } as EntryReaderState} loaded loadError={null} macroKinds={[]} postMessage={() => {}} />);
  expect(view.queryByText('SSI 0.00')).toBeNull();
  expect(view.getByText('Global SSI unavailable')).toBeTruthy();
});
it.each(['entry', 'library'])('%s adapter carries cached metrics through messages and clears stale/malformed values', (surface) => {
  const view = render(surface === 'entry' ? <EntryInfoviewApp /> : <App />);
  const payload = surface === 'entry'
    ? { type: 'entryDetails', entry, kind: null, entries: [], macros: {} }
    : { type: 'libraryEntries', slug: 'lib', title: 'Library', entries: [], macros: {}, outline: [
      { nodeId: 'one', entry, kind: null, counterLabel: null, children: [] }
    ] };
  const push = (cache: unknown) => act(() => window.dispatchEvent(new MessageEvent('message', { data: { ...payload, cachedEntryMetrics: cache } })));
  push(cachedEntryMetrics);
  expect(view.getByText('SSI 0.75')).toBeTruthy();
  push({ scope: 'workspace', status: 'ready', entries: { target: { kind: 'ok', metrics: {} } } });
  expect(view.queryByText('SSI 0.75')).toBeNull();
  expect(view.getByText('Global SSI unavailable')).toBeTruthy();
  push(cachedEntryMetrics);
  push(undefined);
  expect(view.queryByText('SSI 0.75')).toBeNull();
  expect(view.getByText('Global SSI unavailable')).toBeTruthy();
});
