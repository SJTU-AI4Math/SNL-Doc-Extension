// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();

afterEach(() => {
  cleanup();
  postMessage.mockReset();
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
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
}

describe('Create Library feedback', () => {
  it('renders Add root entry as a full-width row action', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph();

    const addRoot = screen.getByRole('button', { name: '+ Add root entry' });
    expect(addRoot.style.width).toBe('100%');
    expect(addRoot.style.display).toBe('block');
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
    expect(screen.getByRole('button', { name: 'Update Title' })).toBeTruthy();
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

  it('posts a graph-local node id rename without changing the Entry id', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', hasContent: true }]
    });

    const nodeId = screen.getByLabelText('Node ID n_1');
    nodeId.focus();
    expect(document.activeElement).toBe(nodeId);
    fireEvent.change(nodeId, { target: { value: 'intro' } });
    fireEvent.keyDown(nodeId, { key: 'Enter' });
    fireEvent.blur(nodeId);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'graphOp',
      op: { op: 'renameNode', nodeId: 'n_1', newNodeId: 'intro' }
    });
    expect(postMessage.mock.calls.filter(([message]) =>
      message?.type === 'graphOp' && message?.op?.op === 'renameNode'
    )).toHaveLength(1);

    // A later focus is a deliberate retry (for example after resolving a
    // duplicate-id error), not the duplicate blur from the first Enter.
    nodeId.focus();
    expect(document.activeElement).toBe(nodeId);
    fireEvent.keyDown(nodeId, { key: 'Enter' });
    fireEvent.blur(nodeId);
    expect(postMessage.mock.calls.filter(([message]) =>
      message?.type === 'graphOp' && message?.op?.op === 'renameNode'
    )).toHaveLength(2);
    expect(screen.getAllByTitle(/entry-one/).length).toBeGreaterThan(0);
  });

  it('cancels a graph-local node id edit with Escape', () => {
    setupApi();
    render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', slug: 'algebra', existing: { slug: 'algebra', title: 'Algebra' } });
    sendGraph({
      nodes: [{ id: 'n_1', label: 'Entry', props: { entryId: 'entry-one' } }],
      entries: [{ id: 'entry-one', title: 'Entry One', kind: 'definition', hasContent: true }]
    });

    const nodeId = screen.getByLabelText('Node ID n_1') as HTMLInputElement;
    nodeId.focus();
    expect(document.activeElement).toBe(nodeId);
    fireEvent.change(nodeId, { target: { value: 'discard-me' } });
    fireEvent.keyDown(nodeId, { key: 'Escape' });
    fireEvent.blur(nodeId);

    expect(nodeId.value).toBe('n_1');
    expect(postMessage.mock.calls.some(([message]) =>
      message?.type === 'graphOp' && message?.op?.op === 'renameNode'
    )).toBe(false);
  });
});
