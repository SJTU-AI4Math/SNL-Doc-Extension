import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MacroDataDriver, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { GuiCanvasEditor, resolveCanvasPointerTarget } from '../CreateEntryApp';
import { createCanvasHole } from './canvasForest';

vi.mock('@sjtu-ai4math/snl-basics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sjtu-ai4math/snl-basics')>();
  const ReactModule = await import('react');
  const renderNode = (tree: SnlSyntaxTree, path: number[] = []): React.ReactElement => {
    if (tree.macro_name === 'matrix') {
      return ReactModule.createElement(
        'section',
        { key: path.join('.') || 'matrix-root', className: 'dynamic-shell' },
        tree.children.map((child, index) => renderNode(child, [...path, index]))
      );
    }
    return ReactModule.createElement(
      'div',
      {
        key: path.join('.') || 'root',
        'data-tree-path': path.join('.'),
        'data-kind': tree.kind,
        className: tree.kind === 'argPlaceholder' ? 'snlArgPlaceholder' : undefined
      },
      tree.macro_name,
      tree.children.map((child, index) => renderNode(child, [...path, index]))
    );
  };
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

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'elementsFromPoint');
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

  it('shows Tab selection feedback for a dynamic macro without its own wrapper', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('matrix', [node('cell')])])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Tab' });
    fireEvent.keyDown(canvas, { key: 'Tab' });
    const shell = view.container.querySelector<HTMLElement>('.dynamic-shell')!;
    await waitFor(() => expect(shell.classList.contains('snl-canvas-focused')).toBe(true));
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

  it('uses adaptive compact blocks and lightens them on hover', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root')]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(block.style.width).toBe('max-content');
    expect(block.style.minWidth).toBe('');
    expect(block.style.maxWidth).toBe('calc(100% - 32px)');
    expect(block.style.padding).toBe('0.3rem');
    const resting = block.style.background;
    fireEvent.pointerEnter(block);
    await waitFor(() => expect(block.style.background).not.toBe(resting));
  });

  it('absorbs a dragged root into a numbered placeholder', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [createCanvasHole(0)]),
        node('detached')
      ]);
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
    const blocks = await waitFor(() => {
      const found = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
      expect(found).toHaveLength(2);
      return found;
    });
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number) => x >= 300 ? [hole] : []
    });

    fireEvent.pointerDown(blocks[1], { pointerId: 3, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-drop-target')).toBe(true));
    fireEvent.pointerUp(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('detached');
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });

  it('does not absorb from a stale hover target or pointercancel', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [createCanvasHole(0)]),
        node('detached')
      ]);
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
    let blocks = await waitFor(() => view.container.querySelectorAll<HTMLElement>('[data-canvas-root]'));
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number) => x >= 300 ? [hole] : []
    });

    fireEvent.pointerDown(blocks[1], { pointerId: 4, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 4, clientX: 320, clientY: 220 });
    fireEvent.pointerUp(blocks[1], { pointerId: 4, clientX: 100, clientY: 100 });
    expect(view.getByTestId('root-count').textContent).toBe('2');

    blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
    fireEvent.pointerDown(blocks[1], { pointerId: 5, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 5, clientX: 320, clientY: 220 });
    fireEvent.pointerCancel(blocks[1], { pointerId: 5, clientX: 320, clientY: 220 });
    expect(view.getByTestId('root-count').textContent).toBe('2');
  });

  it('navigates Focus with Enter, Shift+Enter, Tab and Escape', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch', [node('leaf')]), node('sibling')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    const branch = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    const leaf = view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!;
    fireEvent.click(branch);
    await waitFor(() => expect(branch.classList.contains('snl-canvas-focused')).toBe(true));

    fireEvent.keyDown(canvas, { key: 'Enter' });
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.keyDown(canvas, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(branch.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.keyDown(canvas, { key: 'Escape' });
    await waitFor(() => expect(view.container.querySelector('.snl-canvas-focused')).toBeNull());

    fireEvent.click(branch);
    fireEvent.click(canvas);
    await waitFor(() => expect(view.container.querySelector('.snl-canvas-focused')).toBeNull());
  });

  it('edits any focused subtree and commits on outside click', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [node('branch', [node('leaf')])])
      ]);
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
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    const branch = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    fireEvent.click(branch);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((input as HTMLTextAreaElement).value).toBe('branch(leaf)');
    fireEvent.change(input, { target: { value: 'new(child)' } });
    fireEvent.pointerDown(canvas);

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('new');

    const replaced = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    fireEvent.click(replaced);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const cancelled = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(cancelled, { target: { value: 'discarded' } });
    fireEvent.keyDown(cancelled, { key: 'Escape' });
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('new');
  });

  it('selects targets with Tab and edits a selected placeholder with F2/Enter', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [createCanvasHole(0), node('tail')])
      ]);
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
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;
    fireEvent.click(hole);
    const clickedInput = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    const editingBlock = view.container.querySelector<HTMLElement>('[data-canvas-root]')!;
    const leftBeforeEditDrag = editingBlock.style.left;
    fireEvent.pointerDown(editingBlock, { pointerId: 6, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(editingBlock, { pointerId: 6, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(editingBlock, { pointerId: 6, clientX: 40, clientY: 40 });
    expect(editingBlock.style.left).toBe(leftBeforeEditDrag);
    fireEvent.keyDown(clickedInput, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());

    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Tab' });
    const tail = view.container.querySelector<HTMLElement>('[data-tree-path="1"]')!;
    await waitFor(() => expect(tail.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.keyDown(canvas, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-focused')).toBe(true));

    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(input, { target: { value: 'foo(bar)' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('foo');
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
    fireEvent.click(child);
    await waitFor(() => expect(child.classList.contains('snl-canvas-focused')).toBe(true));

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
    const detachedRoot = blocks[1].querySelector<HTMLElement>('[data-tree-path=""]')!;
    await waitFor(() => expect(detachedRoot.classList.contains('snl-canvas-focused')).toBe(true));
  });
});
