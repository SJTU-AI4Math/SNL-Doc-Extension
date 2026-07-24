import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MacroDataDriver, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { GuiCanvasEditor, resolveCanvasPointerTarget } from '../CreateEntryApp';

vi.mock('@sjtu-ai4math/snl-basics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sjtu-ai4math/snl-basics')>();
  const ReactModule = await import('react');
  const renderNode = (tree: SnlSyntaxTree, path: number[] = []): React.ReactElement =>
    ReactModule.createElement(
      'div',
      { key: path.join('.') || 'root', 'data-tree-path': path.join('.') },
      tree.macro_name,
      tree.children.map((child, index) => renderNode(child, [...path, index]))
    );
  return {
    ...actual,
    SnlSyntaxTreeView: ({ tree }: { tree: SnlSyntaxTree }) => renderNode(tree)
  };
});

const node = (macro_name: string, children: SnlSyntaxTree[] = []): SnlSyntaxTree => ({
  macro_name,
  kind: '',
  mdata: null,
  children
});

const driver = new MacroDataDriver({
  queries: { query_macro: async () => null }
});

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => true }
  });
});

afterAll(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
});

describe('GuiCanvasEditor', () => {
  it('infers a missing dynamic-macro wrapper from descendant geometry', () => {
    const tree = node('root', [node('matrix', [node('cell')])]);
    const block = document.createElement('div');
    block.dataset.treePath = '';
    const shell = document.createElement('span');
    const cell = document.createElement('span');
    cell.dataset.treePath = '0.0';
    cell.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    shell.appendChild(cell);
    block.appendChild(shell);

    const shellTarget = resolveCanvasPointerTarget(shell, block, tree, 92, 110);
    expect(shellTarget?.path).toEqual([0]);

    const cellTarget = resolveCanvasPointerTarget(cell, block, tree, 110, 110);
    expect(cellTarget?.path).toEqual([0, 0]);
  });

  it('moves the whole block from blank card space with grab cursor', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const block = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-canvas-root]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(block.style.cursor).toBe('grab');

    fireEvent.pointerDown(block, { pointerId: 2, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { pointerId: 2, clientX: 30, clientY: 40 });
    await waitFor(() => expect(block.style.cursor).toBe('grabbing'));
    expect(block.style.left).toBe('44px');
    expect(block.style.top).toBe('54px');

    fireEvent.pointerUp(block, { pointerId: 2, clientX: 30, clientY: 40 });
    await waitFor(() => expect(block.style.cursor).toBe('grab'));
    expect(view.container.querySelectorAll('[data-canvas-root]')).toHaveLength(1);
  });

  it('detaches a dragged nested macro into a second root block', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }

    const view = render(<Harness />);
    const child = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('[data-tree-path="0"]');
      expect(found).not.toBeNull();
      return found!;
    });
    child.getBoundingClientRect = () => new DOMRect(120, 80, 30, 20);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.getBoundingClientRect = () => new DOMRect(10, 10, 800, 500);

    fireEvent.pointerDown(child, {
      pointerId: 1,
      button: 0,
      clientX: 20,
      clientY: 20
    });
    fireEvent.pointerMove(child, {
      pointerId: 1,
      clientX: 40,
      clientY: 40
    });
    fireEvent.pointerUp(child, { pointerId: 1, clientX: 40, clientY: 40 });

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    const blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].style.left).toBe('130px');
    expect(blocks[1].style.top).toBe('90px');
  });
});
