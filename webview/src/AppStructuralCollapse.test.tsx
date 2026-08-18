// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./render/HoverPopoverProvider', () => ({
  HoverPopoverProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));
import React from 'react';
import { App, type OutlineNode } from './App';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();
const api: VsCodeApi = { postMessage, getState: () => undefined, setState: () => undefined };
const leaf = (nodeId: string): OutlineNode => ({ nodeId, entry: null, kind: null, counterLabel: null, children: [] });
const branch = (nodeId: string, children: OutlineNode[]): OutlineNode => ({ ...leaf(nodeId), children });

function mount(outline: OutlineNode[]) {
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = api;
  const view = render(<App />);
  act(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'libraryEntries', slug: 'demo', title: 'Demo', entries: [], outline
  } })));
  postMessage.mockClear();
  return view;
}

afterEach(() => {
  cleanup();
  postMessage.mockReset();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Library Infoview structural collapse controls', () => {
  it('defaults closed, supports all controls, and never posts a model mutation', () => {
    mount([branch('root', [leaf('child')])]);
    const disclosure = screen.getByRole('button', { name: 'Expand root' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.getAttribute('aria-controls')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Collapse all' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByRole('button', { name: 'Collapse root' })).toBeTruthy();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('uses Ctrl only for absolute-depth peers, including initially hidden branches', () => {
    mount([
      branch('a', [branch('a1', [leaf('ax')])]),
      branch('b', [branch('b1', [leaf('bx')])])
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse a1' }), { ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Expand a1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand b1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse a' }), { metaKey: true });
    expect(screen.getByRole('button', { name: 'Expand a' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse b' })).toBeTruthy();
  });
});
