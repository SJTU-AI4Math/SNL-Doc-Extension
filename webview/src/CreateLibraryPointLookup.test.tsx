// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockClear();
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
});

afterEach(() => {
  cleanup();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Library Entry identity lookup', () => {
  it('point-queries the host as the author types an exact Entry ID', async () => {
    render(<CreateLibraryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', mode: 'edit', slug: 'notes',
        libraryRevision: 'r1', existing: { slug: 'notes', title: 'Notes' }
      }
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'graph', nodes: [], relationships: [], entries: [], kinds: [],
        metricMacroSources: {}, metricThresholds: {
          structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80
        }, warnings: []
      }
    }));

    fireEvent.click(await screen.findByRole('button', { name: '+ Add root entry' }));
    const input = await screen.findByPlaceholderText(
      'Enter an exact Entry ID, or type a new ID and click Create'
    );
    fireEvent.change(input, { target: { value: 'Set.mem' } });

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'lookupEntry', requestId: 2, entryId: 'Set.mem'
      });
    });
  });

  it('commits an off-graph lookup hit as a real reference and blocks pending commits', async () => {
    render(<CreateLibraryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', mode: 'edit', slug: 'notes',
        libraryRevision: 'r1', existing: { slug: 'notes', title: 'Notes' }
      }
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'graph', nodes: [], relationships: [], entries: [], kinds: [],
        metricMacroSources: {}, metricThresholds: {
          structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80
        }, warnings: []
      }
    }));

    fireEvent.click(await screen.findByRole('button', { name: '+ Add root entry' }));
    const input = await screen.findByPlaceholderText(
      'Enter an exact Entry ID, or type a new ID and click Create'
    );
    fireEvent.change(input, { target: { value: 'Off.graph' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 2, entryId: 'Off.graph'
    }));

    // A non-empty query with no current response is pending, not missing.
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(postMessage.mock.calls.flat().some((message: unknown) =>
      (message as { type?: string }).type === 'graphOp'
    )).toBe(false);
    expect(postMessage.mock.calls.flat().some((message: unknown) =>
      (message as { type?: string }).type === 'openCreateEntry'
    )).toBe(false);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'entryLookup', requestId: 2, entryId: 'Off.graph',
        entry: { id: 'Off.graph', kind: 'theorem', title: 'Off graph', content: {} }
      }
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reference' }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'graphOp',
      op: {
        op: 'addNode', parentId: null, insertAfter: null,
        entryId: 'Off.graph', counterId: ''
      }
    }));
    expect(postMessage.mock.calls.flat().some((message: unknown) =>
      (message as { type?: string }).type === 'openCreateEntry'
    )).toBe(false);
  });

  it('invalidates a pending lookup when the add form is cancelled', async () => {
    render(<CreateLibraryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', mode: 'edit', slug: 'notes',
        libraryRevision: 'r1', existing: { slug: 'notes', title: 'Notes' }
      }
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'graph', nodes: [], relationships: [], entries: [], kinds: [],
        metricMacroSources: {}, metricThresholds: {
          structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80
        }, warnings: []
      }
    }));
    fireEvent.click(await screen.findByRole('button', { name: '+ Add root entry' }));
    const input = await screen.findByPlaceholderText(
      'Enter an exact Entry ID, or type a new ID and click Create'
    );
    fireEvent.change(input, { target: { value: 'Temp' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 2, entryId: 'Temp'
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 3, entryId: ''
    }));

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'entryLookup', requestId: 2, entryId: 'Temp',
          entry: { id: 'Temp', kind: 'theorem', title: 'Late cancelled result', content: {} }
        }
      }));
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add root entry' }));
    expect(screen.queryByText(/Late cancelled result/)).toBeNull();
  });

  it('uses the acknowledged revision on the next metadata save without rereading context', async () => {
    render(<CreateLibraryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', mode: 'edit', slug: 'notes',
        libraryRevision: 'r1', existing: { slug: 'notes', title: 'Notes' }
      }
    }));
    await screen.findByLabelText('Library title');
    fireEvent.click(screen.getByRole('button', { name: 'Update Title' }));
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update', expectedRevision: 'r1'
    })));

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'updated', slug: 'notes', title: 'First', revision: 'r2' }
    }));
    await screen.findByRole('button', { name: 'Update Title' });
    fireEvent.click(screen.getByRole('button', { name: 'Update Title' }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'update', expectedRevision: 'r2'
    })));
  });

  it('keeps point-lookup state query-scoped without replacing graph state', async () => {
    render(<CreateLibraryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', mode: 'edit', slug: 'notes',
        libraryRevision: 'r1', existing: { slug: 'notes', title: 'Notes' }
      }
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'graph', nodes: [], relationships: [], entries: [], kinds: [],
        metricMacroSources: {}, metricThresholds: {
          structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80
        }, warnings: []
      }
    }));
    fireEvent.click(await screen.findByRole('button', { name: '+ Add root entry' }));
    const input = await screen.findByPlaceholderText(
      'Enter an exact Entry ID, or type a new ID and click Create'
    );
    fireEvent.change(input, { target: { value: 'Set.mem' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 2, entryId: 'Set.mem'
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'entryLookup', requestId: 2, entryId: 'Set.mem',
        entry: { id: 'Set.mem', kind: 'theorem', title: 'Membership', content: {} }
      }
    }));
    expect(await screen.findByText(/Reference: "Membership"/)).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Missing' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 3, entryId: 'Missing'
    }));
    // A late response for the previous query must not repopulate its cache.
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'entryLookup', requestId: 2, entryId: 'Set.mem',
        entry: { id: 'Set.mem', kind: 'theorem', title: 'Stale', content: {} }
      }
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'entryLookup', requestId: 3, entryId: 'Missing', entry: null }
    }));

    expect(await screen.findByText(/No entry with id "Missing"/)).toBeTruthy();

    fireEvent.change(input, { target: { value: 'Set.mem' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 4, entryId: 'Set.mem'
    }));
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'entryLookup', requestId: 2, entryId: 'Set.mem',
          entry: { id: 'Set.mem', kind: 'theorem', title: 'Stale same-ID result', content: {} }
        }
      }));
    });
    expect(screen.queryByText(/Stale same-ID result/)).toBeNull();
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'entryLookup', requestId: 4, entryId: 'Set.mem',
        entry: { id: 'Set.mem', kind: 'theorem', title: 'Fresh result', content: {} }
      }
    }));
    expect(await screen.findByText(/Reference: "Fresh result"/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '   ' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'lookupEntry', requestId: 5, entryId: ''
    }));
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'entryLookup', requestId: 4, entryId: 'Set.mem',
          entry: { id: 'Set.mem', kind: 'theorem', title: 'Late after clear', content: {} }
        }
      }));
    });
    expect(screen.queryByText(/Late after clear/)).toBeNull();
  });
});
