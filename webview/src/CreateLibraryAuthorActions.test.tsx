// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      { id: 'root', label: 'Entry', props: { entryId: 'algebra/definitions/0123456789abcdef-root' } },
      { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } }
    ],
    relationships: [{ from: 'root', to: 'child', label: 'branch' }],
    entries: [
      { id: 'algebra/definitions/0123456789abcdef-root', title: 'Root', kind: 'definition', content: { snl: 'root' } },
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

describe('Library author keyboard and exact-ID actions', () => {
  it.each(['success', 'reject', 'unavailable'] as const)('copies the resolved full ID without committing a typed target (%s)', async (mode) => {
    setup(); render(<CreateLibraryApp />); hydrate();
    const input = screen.getByDisplayValue('algebra/definitions/0123456789abcdef-root');
    const row = input.closest<HTMLElement>('.snl-outline-row')!;
    const writeText = vi.fn(async () => { if (mode === 'reject') throw new Error('denied'); });
    const clipboardBefore = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const commandBefore = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : { writeText } });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn((command: string) => {
      expect(command).toBe('copy');
      const area = document.activeElement as HTMLTextAreaElement;
      expect(area.tagName).toBe('TEXTAREA');
      expect(area.selectionStart).toBe(0); expect(area.selectionEnd).toBe(area.value.length);
      copied.push(area.value); return true;
    }) });
    try {
      fireEvent.change(input, { target: { value: 'entry-child' } });
      postMessage.mockClear();
      fireEvent.click(within(row).getByRole('button', { name: 'Copy Entry ID' }));
      await waitFor(() => expect(mode === 'success' ? writeText.mock.calls.length : copied.length).toBe(1));
      if (mode !== 'unavailable') expect(writeText).toHaveBeenCalledExactlyOnceWith('algebra/definitions/0123456789abcdef-root');
      expect(copied).toEqual(mode === 'success' ? [] : ['algebra/definitions/0123456789abcdef-root']);
      expect(document.querySelector('textarea')).toBeNull();
      expect(postMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      const saved = postMessage.mock.calls.find(([m]) => m.type === 'saveLibraryDraft')![0];
      expect(saved.graph.nodes).toEqual([
        { id: 'root', label: 'Entry', props: { entryId: 'algebra/definitions/0123456789abcdef-root' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } }
      ]);
    } finally {
      if (clipboardBefore) Object.defineProperty(navigator, 'clipboard', clipboardBefore);
      else Reflect.deleteProperty(navigator, 'clipboard');
      if (commandBefore) Object.defineProperty(document, 'execCommand', commandBefore);
      else Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('Enter uses the same whole-draft Save with hydration, blank-title, IME and in-flight guards', () => {
    setup(); render(<CreateLibraryApp />);
    send({ type: 'context', mode: 'edit', requestId: 'load-1', slug: 'algebra', targetState: 'found', libraryRevision: 'meta-r1', existing: { slug: 'algebra', title: 'Algebra' } });
    postMessage.mockClear();
    fireEvent.keyDown(screen.getByLabelText('Library title'), { key: 'Enter' });
    expect(postMessage).not.toHaveBeenCalled();
    hydrate(); postMessage.mockClear();
    const title = screen.getByLabelText('Library title');
    fireEvent.change(title, { target: { value: '  ' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(postMessage).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: 'Whole draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand counters' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Counter name' }), { target: { value: 'local-counter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Expand root' }));
    const child = screen.getByDisplayValue('entry-child').closest<HTMLElement>('.snl-outline-row')!;
    fireEvent.click(within(child).getByRole('button', { name: 'Outdent' }));
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true });
    expect(postMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(postMessage.mock.calls.map(([m]) => m)).toEqual([{
      type: 'saveLibraryDraft', requestId: expect.any(String), slug: 'algebra', title: 'Whole draft',
      graph: { nodes: [
        { id: 'root', label: 'Entry', props: { entryId: 'algebra/definitions/0123456789abcdef-root' } },
        { id: 'child', label: 'Entry', props: { entryId: 'entry-child' } }
      ], relationships: [] },
      counters: [{ id: 'counter-1', name: 'local-counter', numbering: '1', children: [] }],
      expectedRevisions: { meta: 'meta-r1', graph: 'graph-r1', counters: 'counter-r1' }
    }]);
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
