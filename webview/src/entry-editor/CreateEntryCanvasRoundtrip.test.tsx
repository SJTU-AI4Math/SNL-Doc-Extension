import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { CreateEntryApp } from '../CreateEntryApp';

vi.mock('../render/HoverPopoverProvider', () => ({
  HoverPopoverProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>
}));
vi.mock('../render/EntrySurface', () => ({ EntrySurface: () => null }));

vi.mock('@sjtu-ai4math/snl-basics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sjtu-ai4math/snl-basics')>();
  const ReactModule = await import('react');
  const renderNode = (tree: SnlSyntaxTree, path: number[] = []): React.ReactElement =>
    ReactModule.createElement(
      'div',
      { key: path.join('.') || 'root', 'data-tree-path': path.join('.'), 'data-kind': tree.kind },
      tree.macro_name,
      tree.children.map((child, index) => renderNode(child, [...path, index]))
    );
  return {
    ...actual,
    SnlSyntaxTreeView: ({ tree }: { tree: SnlSyntaxTree }) => renderNode(tree)
  };
});

beforeAll(() => {
  if (typeof PointerEvent === 'undefined') {
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: class PointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, init: PointerEventInit = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      }
    });
  }
  for (const method of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const) {
    if (!(method in HTMLElement.prototype)) {
      Object.defineProperty(HTMLElement.prototype, method, {
        configurable: true,
        value: method === 'hasPointerCapture' ? () => false : () => undefined
      });
    }
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CreateEntryApp Canvas update round-trip', () => {
  it('keeps the Canvas visible, positioned and serialized across Update/context refresh', async () => {
    const postMessage = vi.fn();
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage }));
    const existing = {
      id: 'entry-1',
      title: 'Entry One',
      kind: 'definition',
      content: { snl: 'root(child)' }
    };
    const view = render(<CreateEntryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context',
        mode: 'edit',
        id: existing.id,
        kinds: [{
          id: 'definition',
          name: 'Definition',
          coloring: { stroke: '#888888', background: '#222222' },
          numbering: '1',
          style: 'default'
        }],
        macros: {},
        macroKinds: [],
        macroOrigin: {},
        existing,
        existingIds: [{ id: existing.id, title: existing.title, hasContent: true }]
      }
    }));

    const canvasTab = await waitFor(() => view.getByRole('button', { name: 'GUI Editor (Canvas)' }));
    fireEvent.click(canvasTab);
    let block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    fireEvent.pointerDown(block, { pointerId: 20, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { pointerId: 20, clientX: 70, clientY: 50 });
    fireEvent.pointerUp(block, { pointerId: 20, clientX: 70, clientY: 50 });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(block.style.left).toBe('84px');
    expect(block.style.top).toBe('64px');

    fireEvent.click(block.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'changed(grandchild)' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(block.textContent).toContain('changed');
    expect(block.style.left).toBe('84px');
    expect(block.style.top).toBe('64px');

    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    const update = postMessage.mock.calls.map(([message]) => message)
      .findLast((message: any) => message?.type === 'update') as any;
    expect(update.entry.content.snl).toBe('changed(grandchild)');

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'updated', id: existing.id } }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context',
        mode: 'edit',
        id: existing.id,
        kinds: [{
          id: 'definition',
          name: 'Definition',
          coloring: { stroke: '#888888', background: '#222222' },
          numbering: '1',
          style: 'default'
        }],
        macros: {},
        macroKinds: [],
        macroOrigin: {},
        existing: { ...existing, content: update.entry.content },
        existingIds: [{ id: existing.id, title: existing.title, hasContent: true }]
      }
    }));

    block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(block.textContent).toContain('changed');
    expect(block.style.left).toBe('84px');
    expect(block.style.top).toBe('64px');

    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    const updates = postMessage.mock.calls.map(([message]) => message)
      .filter((message: any) => message?.type === 'update') as any[];
    expect(updates.at(-1).entry.content.snl).toBe('changed(grandchild)');
  });
});
