// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import type { VsCodeApi } from './vscodeApi';

const api = { postMessage: vi.fn<(message: unknown) => void>() };

beforeEach(() => {
  // Use the real cached API/ref lifecycle. A mock returning { current: api }
  // on every render invalidates useLibraryEntryLookup's effect dependency;
  // its setResult then rerenders forever even when the query is empty.
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = api;
  api.postMessage.mockImplementation(() => {
    // Fail synchronously rather than letting an effect loop exhaust the heap.
    // Exact per-action message counts below are the behavior oracle.
    if (api.postMessage.mock.calls.length > 16) {
      throw new Error('Library lifecycle exceeded the bounded message budget');
    }
  });
});

afterEach(() => {
  cleanup();
  api.postMessage.mockReset();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

function send(data: unknown): void {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data })); });
}

function messages(type: string): Array<Record<string, unknown>> {
  return api.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>)
    .filter((message) => message.type === type);
}

describe('Library counter errors', () => {
  it('surfaces a failed counter mutation while preserving the existing tree', () => {
    render(<CreateLibraryApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'context',
          mode: 'edit',
          slug: 'algebra',
          existing: { title: 'Algebra' }
        }
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'countersLoaded',
          counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }]
        }
      }));
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'countersError', message: 'revision conflict' }
      }));
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Counter update failed: revision conflict'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    expect(screen.getByDisplayValue('theorem')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Counters (1)' })).toBeDefined();
    expect(messages('ready')).toEqual([{ type: 'ready' }]);
    expect(messages('lookupEntry')).toEqual([
      { type: 'lookupEntry', entryId: '', requestId: expect.any(Number) }
    ]);
    expect(api.postMessage).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['countersLoaded', 'countersPushed'] as const)(
    'recovers on %s without losing counter identity, readiness or bounded lookup cost',
    (replyType) => {
      const mounted = render(<CreateLibraryApp />);
      send({ type: 'context', mode: 'edit', slug: 'algebra', libraryRevision: 'meta-1', existing: { slug: 'algebra', title: 'Algebra' } });
      send({ type: 'countersLoaded', countersRevision: 'counters-1', counters: [{ id: 'counter-1', name: 'theorem', numbering: '1', children: [] }] });
      send({ type: 'countersError', message: 'revision conflict' });
      expect(screen.getByRole('alert').textContent).toContain('Counter update failed: revision conflict');
      expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      expect(messages('saveLibraryDraft')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
      expect(screen.getByDisplayValue('theorem')).toBeDefined();

      const recovered = [
        { id: 'counter-1', name: 'theorem', numbering: '1', children: [] },
        { id: 'counter-2', name: 'lemma', numbering: 'a', children: [] }
      ];
      send({ type: replyType, countersRevision: 'counters-2', counters: recovered });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Counters (2)' })).toBeDefined();
      expect(screen.getByDisplayValue('theorem')).toBeDefined();
      expect(screen.getByDisplayValue('lemma')).toBeDefined();
      expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true);
      send({ type: 'graph', graphRevision: 'graph-1', nodes: [], relationships: [], entries: [], kinds: [], metricMacroSources: {}, warnings: [] });
      expect((screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(false);

      const lookup = messages('lookupEntry')[0]!;
      send({ type: 'entryLookup', requestId: lookup.requestId, entryId: '', entry: null });
      mounted.rerender(<CreateLibraryApp />);
      const edited = screen.getByDisplayValue('lemma');
      fireEvent.change(edited, { target: { value: 'local-lemma' } });
      expect(messages('counterOp')).toHaveLength(0);
      expect(messages('saveLibraryDraft')).toHaveLength(0);
      fireEvent.keyDown(edited, { key: 's', ctrlKey: true });
      const expected = {
        type: 'saveLibraryDraft', requestId: expect.any(String), slug: 'algebra', title: 'Algebra',
        graph: { nodes: [], relationships: [] },
        counters: [recovered[0], { ...recovered[1], name: 'local-lemma' }],
        expectedRevisions: { meta: 'meta-1', graph: 'graph-1', counters: 'counters-2' }
      };
      expect(messages('saveLibraryDraft')).toEqual([expected]);
      const first = messages('saveLibraryDraft')[0]!;
      send({ type: 'libraryDraftSaveError', requestId: first.requestId, message: 'save conflict' });
      expect(screen.getByText('❌ Error: save conflict')).toBeDefined();
      expect(screen.getByDisplayValue('local-lemma')).toBeDefined();
      expect(screen.getByRole('heading', { name: 'Counters (2)' })).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(messages('saveLibraryDraft')).toEqual([expected, expected]);
      const retry = messages('saveLibraryDraft')[1]!;
      expect(retry.requestId).not.toBe(first.requestId);
      send({ type: 'libraryDraftSaved', requestId: retry.requestId, slug: 'algebra', title: 'Algebra', revisions: { meta: 'meta-2', graph: 'graph-2', counters: 'counters-3' } });
      expect(screen.getByText('✅ Updated library "Algebra" (slug: algebra).')).toBeDefined();
      expect(screen.getByDisplayValue('local-lemma')).toBeDefined();
      expect(messages('ready')).toHaveLength(1);
      expect(messages('lookupEntry')).toEqual([lookup]);
      expect(api.postMessage).toHaveBeenCalledTimes(4);
      expect(api.postMessage.mock.contexts.every((context) => context === api)).toBe(true);
      mounted.unmount();
      send({ type: 'countersError', message: 'late unmounted error' });
      expect(api.postMessage).toHaveBeenCalledTimes(4);
    }
  );
});
