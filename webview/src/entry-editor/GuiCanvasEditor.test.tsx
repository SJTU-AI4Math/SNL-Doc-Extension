import React from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MacroDataDriver, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { GuiCanvasEditor, canvasInitialPosition, resolveCanvasPointerTarget } from '../CreateEntryApp';
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
  it('adds fixed-arity placeholders when a Macro is inserted as a new root', async () => {
    const pairDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'pair'
            ? ({
                name: 'pair',
                description: '',
                source: { entries: [], urls: [] },
                tags: [],
                dynamic_arity: false,
                styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0 + #1', tags: [] }]
              } as never)
            : null
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={pairDriver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const canvas = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
    );
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'pair' } });

    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-kind="argPlaceholder"]')).toHaveLength(2)
    );
  });

  it('does not insert a root after Escape cancels a slow arity lookup', async () => {
    const slowDriver = new MacroDataDriver({
      queries: {
        query_macro: async () => {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return {
            name: 'pair',
            description: '',
            source: { entries: [], urls: [] },
            tags: [],
            dynamic_arity: false,
            styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0 + #1', tags: [] }]
          } as never;
        }
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState<SnlSyntaxTree[]>([]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={slowDriver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }

    const view = render(<Harness />);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'pair' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(view.getByTestId('root-count').textContent).toBe('0');
  });

  it('does not publish a delayed root after the Canvas unmounts', async () => {
    let resolveMacro!: (value: unknown) => void;
    const delayed = new Promise((resolve) => { resolveMacro = resolve; });
    const delayedDriver = new MacroDataDriver({
      queries: { query_macro: async () => await delayed as never }
    });
    const onForestChange = vi.fn();
    const view = render(
      <GuiCanvasEditor
        forest={[]}
        macroDataDriver={delayedDriver}
        kindPalette={undefined}
        onForestChange={onForestChange}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    canvas.focus();
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Insert Canvas root Macro' }) as HTMLInputElement
    );
    fireEvent.change(input, { target: { value: 'pair' } });
    view.unmount();
    resolveMacro({
      name: 'pair',
      description: '',
      source: { entries: [], urls: [] },
      tags: [],
      dynamic_arity: false,
      styles: [{ style_name: 'default', mode: 'formula_inline', template: '#0 + #1', tags: [] }]
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onForestChange).not.toHaveBeenCalled();
  });

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
    fireEvent.keyDown(canvas, { key: 'Enter' });
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
    expect(block.style.userSelect).toBe('none');

    expect(fireEvent.pointerDown(block, {
      pointerId: 2,
      button: 0,
      clientX: 10,
      clientY: 10
    })).toBe(false);
    fireEvent.pointerMove(block, { pointerId: 2, clientX: 30, clientY: 40 });
    await waitFor(() => expect(block.style.cursor).toBe('grabbing'));
    expect(block.style.zIndex).toBe('1000');
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
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    hole.getBoundingClientRect = () => new DOMRect(500, 300, 30, 20);
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 500);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: (x: number) => x >= 300 ? [hole] : []
    });

    fireEvent.pointerDown(blocks[1], { pointerId: 3, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-drop-target')).toBe(true));
    expect(blocks[1].style.left).toBe('500px');
    expect(blocks[1].style.top).toBe('300px');

    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 100, clientY: 100 });
    await waitFor(() => expect(hole.classList.contains('snl-canvas-drop-target')).toBe(false));
    expect(blocks[1].style.left).toBe('154px');
    expect(blocks[1].style.top).toBe('-76px');

    fireEvent.pointerMove(blocks[1], { pointerId: 3, clientX: 320, clientY: 220 });
    await waitFor(() => expect(blocks[1].style.left).toBe('500px'));
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

  it('clears Focus when an external forest replacement removes its path', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [node('branch', [node('leaf')])])
      ]);
      return (
        <>
          <button onClick={() => setForest([node('replacement')])}>replace forest</button>
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
    const leaf = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!);
    fireEvent.click(leaf);
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    fireEvent.click(view.getByRole('button', { name: 'replace forest' }));
    await waitFor(() => expect(view.container.querySelector('.snl-canvas-focused')).toBeNull());
  });

  it('edits any focused subtree, cancels on outside click, and commits only on Enter', async () => {
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
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((input as HTMLTextAreaElement).value).toBe('branch(leaf)');
    fireEvent.click(input);
    expect(branch.classList.contains('snl-canvas-focused')).toBe(true);

    fireEvent.change(input, { target: { value: '(' } });
    fireEvent.pointerDown(canvas);
    fireEvent.click(canvas);
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(branch.textContent).toContain('branch');

    fireEvent.click(branch);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const outsideCancelled = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(outsideCancelled, { target: { value: 'outside(child)' } });
    fireEvent.pointerDown(canvas);
    fireEvent.click(canvas);
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('branch');

    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const enterCommitted = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(enterCommitted, { target: { value: 'new(child)' } });
    fireEvent.keyDown(enterCommitted, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());
    const newTarget = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    expect(newTarget.textContent).toContain('new');
    expect(newTarget.classList.contains('snl-canvas-focused')).toBe(true);

    const replaced = view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!;
    fireEvent.click(replaced);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const cancelled = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(cancelled, { target: { value: 'discarded' } });
    fireEvent.keyDown(cancelled, { key: 'Escape' });
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('new');
  });

  it('lets Ctrl+F2 subtree editing keep and display newline input', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const editor = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement
    );

    // Plain Enter belongs to the multiline textarea; it must not submit.
    expect(fireEvent.keyDown(editor, { key: 'Enter' })).toBe(true);
    fireEvent.change(editor, { target: { value: 'root(\n  branch\n)' } });
    expect(view.getByRole('textbox', { name: 'Edit focused SNL' })).toBe(editor);
    expect(editor.value).toBe('root(\n  branch\n)');
  });

  it('keeps Canvas editing active while embedded SNoogL fills the focused editor', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          macroCandidates={[{ id: 'FOL.forall', labels: [] }, { id: 'Add.add', labels: [] }]}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }
    const view = render(<Harness />);
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(root);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'F2' });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.click(view.getByRole('option', { name: 'FOL.forall' }));
    fireEvent.keyDown(search, { key: 'Tab' });
    expect((view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement).value)
      .toBe('FOL.forall');
    expect(root.classList.contains('snl-canvas-focused')).toBe(true);
  });

  it('opens Macro search with Ctrl+F when no node is focused and Tab inserts a root', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          macroCandidates={[{ id: 'FOL.forall', labels: [] }, { id: 'Add.add', labels: [] }]}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const view = render(<Harness />);
    const canvas = await waitFor(() =>
      view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
    );
    fireEvent.click(canvas);
    fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });

    const search = await waitFor(() =>
      view.getByRole('textbox', { name: 'Search macros in SNoogL' })
    );
    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });

    await waitFor(() => {
      const roots = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
      expect(roots).toHaveLength(2);
      expect(roots[1].textContent).toContain('Add.add');
      expect(
        roots[1].querySelector<HTMLElement>('[data-tree-path=""]')
          ?.classList.contains('snl-canvas-focused')
      ).toBe(true);
    });
  });

  it('keeps a root block in place after editing its SNL', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('child')])]);
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
    let block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    fireEvent.pointerDown(block, { pointerId: 12, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(block, { pointerId: 12, clientX: 50, clientY: 40 });
    fireEvent.pointerUp(block, { pointerId: 12, clientX: 50, clientY: 40 });
    expect(block.style.left).toBe('64px');
    expect(block.style.top).toBe('54px');
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    const root = block.querySelector<HTMLElement>('[data-tree-path=""]')!;
    fireEvent.click(root);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(editor, { target: { value: 'changed(grandchild)' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });

    block = await waitFor(() => view.container.querySelector<HTMLElement>('[data-canvas-root]')!);
    expect(block.textContent).toContain('changed');
    expect(block.style.left).toBe('64px');
    expect(block.style.top).toBe('54px');
  });

  it('selects targets with Tab and edits a selected placeholder with F2/Ctrl+Enter', async () => {
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
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

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

  it('centres the first root block and keeps later blocks on the fallback grid', () => {
    expect(canvasInitialPosition(0, { clientWidth: 800, clientHeight: 500 }, { offsetWidth: 200, offsetHeight: 100 }))
      .toEqual({ x: 300, y: 200 });
    expect(canvasInitialPosition(0, null, null)).toEqual({ x: 24, y: 24 });
    expect(canvasInitialPosition(1, { clientWidth: 800, clientHeight: 500 }, null))
      .toEqual({ x: 354, y: 24 });
  });

  it('edits only the focused Macro with F2 and keeps its children', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch', [node('leaf')])])]);
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
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    // Macro scope shows only the head, never the serialized subtree.
    expect((input as HTMLTextAreaElement).value).toBe('branch');

    fireEvent.change(input, { target: { value: 'renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent)
        .toContain('renamed')
    );
    // The child survives the Macro-only rewrite.
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')?.textContent)
      .toContain('leaf');
  });

  it('rejects a subtree expression typed into the Macro-scope editor', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(input, { target: { value: 'foo(bar)' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(view.getByRole('textbox', { name: 'Edit focused SNL' }).getAttribute('title'))
        .toContain('Ctrl+F2')
    );
  });

  it('double click edits the clicked node exactly like click + F2', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch', [node('leaf')])])]);
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
    const leaf = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!);
    fireEvent.doubleClick(leaf);
    const input = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((input as HTMLTextAreaElement).value).toBe('leaf');
    expect(leaf.classList.contains('snl-canvas-focused')).toBe(true);
  });

  it('focuses the subtree a drag would carry away, not the whole root', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch', [node('leaf')])])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const leaf = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0.0"]')!);
    const block = view.container.querySelector<HTMLElement>('[data-canvas-root]')!;
    // Pointer-down resolves the drag payload; the click must agree with it.
    fireEvent.pointerDown(leaf, { pointerId: 30, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(leaf, { pointerId: 30, clientX: 10, clientY: 10 });
    fireEvent.click(leaf);
    await waitFor(() => expect(leaf.classList.contains('snl-canvas-focused')).toBe(true));
    expect(block.querySelector<HTMLElement>('[data-tree-path=""]')?.classList
      .contains('snl-canvas-focused')).toBe(false);
  });

  it('opens a Canvas-owned menu on right click and can detach from it', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch')])]);
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
    const branch = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.contextMenu(branch);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    expect(menu).toBeTruthy();
    expect(branch.classList.contains('snl-canvas-focused')).toBe(true);

    fireEvent.click(view.getByRole('menuitem', { name: /Detach into its own block/ }));
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    expect(view.queryByRole('menu', { name: 'Canvas block actions' })).toBeNull();
  });

  it('Ctrl+F2 SNoogL Tab inserts the Macro id instead of replacing the expression', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        macroCandidates={[{ id: 'FOL.forall', labels: [] }, { id: 'Add.add', labels: [] }]}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2', ctrlKey: true });
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((editor as HTMLTextAreaElement).value).toBe('root(branch)');

    (editor as HTMLTextAreaElement).setSelectionRange(5, 5);
    fireEvent.keyDown(editor, { key: 'f', ctrlKey: true });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });

    await waitFor(() =>
      expect((view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement).value)
        .toBe('root(Add.addbranch)')
    );
  });

  it('does not let a previous click hijack a later gesture on another node', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([
        node('root', [node('alpha'), node('beta'), createCanvasHole(2)])
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
    const alpha = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    const beta = view.container.querySelector<HTMLElement>('[data-tree-path="1"]')!;
    const hole = view.container.querySelector<HTMLElement>('[data-kind="argPlaceholder"]')!;

    // Left click alpha first — this is what used to poison every later gesture.
    fireEvent.pointerDown(alpha, { pointerId: 40, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(alpha, { pointerId: 40, clientX: 5, clientY: 5 });
    fireEvent.click(alpha);
    await waitFor(() => expect(alpha.classList.contains('snl-canvas-focused')).toBe(true));

    // Right click on a sibling must target the sibling, not alpha.
    fireEvent.contextMenu(beta);
    await waitFor(() => expect(beta.classList.contains('snl-canvas-focused')).toBe(true));
    expect(alpha.classList.contains('snl-canvas-focused')).toBe(false);
    fireEvent.keyDown(view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!, { key: 'Escape' });

    // Double click on a sibling must edit the sibling, not alpha.
    fireEvent.click(alpha);
    fireEvent.doubleClick(beta);
    const editor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((editor as HTMLTextAreaElement).value).toBe('beta');
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull());

    // Clicking an empty slot after clicking a macro must still open its editor.
    fireEvent.click(alpha);
    fireEvent.pointerDown(hole, { pointerId: 41, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(hole, { pointerId: 41, clientX: 5, clientY: 5 });
    fireEvent.click(hole);
    const slotEditor = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    expect((slotEditor as HTMLTextAreaElement).value).toBe('');
  });

  it('selects the whole value when F2 opens the Macro editor', async () => {
    const view = render(
      <GuiCanvasEditor
        forest={[node('root', [node('branch')])]}
        macroDataDriver={driver}
        kindPalette={undefined}
        onForestChange={() => undefined}
        onResetFromSnl={() => undefined}
      />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const input = await waitFor(() =>
      view.getByRole('textbox', { name: 'Edit focused SNL' }) as HTMLTextAreaElement
    );
    // F2 alone now behaves like the old F2 + Ctrl+A.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.value).toBe('branch');
  });

  it('deletes the focused node with Delete and restores it with Ctrl+Z', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('a'), node('b')])]);
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
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'Delete' });
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.dataset.kind)
        .toBe('argPlaceholder')
    );

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() =>
      expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('a')
    );
  });

  it('undoes a root insertion made from the blank-space menu', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={driver}
            macroCandidates={[{ id: 'Add.add', labels: [] }]}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);

    // Right click on blank canvas space offers exactly one action: add a root.
    fireEvent.contextMenu(canvas);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual([expect.stringContaining('Add root Macro')]);

    // The menu must actually be clickable — this used to be swallowed.
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Add root Macro/ }));
    const search = await waitFor(() => view.getByRole('textbox', { name: 'Search macros in SNoogL' }));
    fireEvent.change(search, { target: { value: 'Add' } });
    fireEvent.keyDown(search, { key: 'Tab' });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
  });

  it('focuses the deepest node under the pointer even when it has its own wrapper', () => {
    const tree = node('root', [node('branch', [node('leaf')])]);
    const block = document.createElement('div');
    block.dataset.treePath = '';
    block.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    const branch = document.createElement('span');
    branch.dataset.treePath = '0';
    branch.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    const leaf = document.createElement('span');
    leaf.dataset.treePath = '0.0';
    leaf.getBoundingClientRect = () => new DOMRect(100, 100, 40, 20);
    // Sibling in the DOM, overlapping in geometry: `closest()` alone would
    // resolve to the shallow branch and focus the wrong subtree.
    block.appendChild(branch);
    block.appendChild(leaf);

    expect(resolveCanvasPointerTarget(branch, block, tree, 110, 110)?.path).toEqual([0, 0]);
    expect(resolveCanvasPointerTarget(branch, block, tree, 350, 20)?.path).toEqual([0]);
  });

  it('pops surplus children out as roots when a Macro loses arity, and does not resurrect them', async () => {
    // A driver with a real arity signal: binary#2 takes two args, unary#1 one.
    const arityDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) => {
          if (macro_name === 'binary') {
            return { macro_name, dynamic_arity: false, styles: [{ template: '#0 + #1' }] } as never;
          }
          if (macro_name === 'unary') {
            return { macro_name, dynamic_arity: false, styles: [{ template: '-#0' }] } as never;
          }
          return null;
        }
      }
    });
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('binary', [node('x'), node('y')])]);
      return (
        <>
          <output data-testid="root-count">{forest.length}</output>
          <GuiCanvasEditor
            forest={forest}
            macroDataDriver={arityDriver}
            kindPalette={undefined}
            onForestChange={setForest}
            onResetFromSnl={() => undefined}
          />
        </>
      );
    }
    const view = render(<Harness />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);

    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const shrink = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(shrink, { target: { value: 'unary' } });
    fireEvent.keyDown(shrink, { key: 'Enter' });

    // 'y' must survive as its own root block rather than silently vanishing.
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    const blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
    expect(blocks[0].textContent).toContain('x');
    expect(blocks[1].textContent).toContain('y');

    // Changing back must leave an EMPTY slot, not conjure 'y' back.
    fireEvent.click(blocks[0].querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.keyDown(canvas, { key: 'F2' });
    const grow = await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
    fireEvent.change(grow, { target: { value: 'binary' } });
    fireEvent.keyDown(grow, { key: 'Enter' });

    await waitFor(() => {
      const slot = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"] [data-tree-path="1"]');
      expect(slot?.dataset.kind).toBe('argPlaceholder');
    });
    expect(view.getByTestId('root-count').textContent).toBe('2');
  });

  it('keeps the context menu alive and actionable through a real pointer interaction', async () => {
    function Harness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root', [node('branch')])]);
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
    const branch = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.contextMenu(branch);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    const item = within(menu).getByRole('menuitem', { name: /Detach into its own block/ });

    // A real click is pointerdown -> pointerup -> click. Both the block's
    // pointer capture and the canvas click handler used to eat these, which
    // is what made the menu feel dead. The menu must survive pointerdown and
    // still run its action on click.
    fireEvent.pointerDown(item, { pointerId: 70, button: 0, clientX: 5, clientY: 5 });
    expect(view.getByRole('menu', { name: 'Canvas block actions' })).toBeTruthy();
    fireEvent.pointerUp(item, { pointerId: 70, clientX: 5, clientY: 5 });
    fireEvent.click(item);

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    expect(view.queryByRole('menu', { name: 'Canvas block actions' })).toBeNull();
    // The canvas click handler must not have stolen the gesture and cleared
    // the focus the menu action just set on the detached block.
    await waitFor(() => {
      const blocks = view.container.querySelectorAll<HTMLElement>('[data-canvas-root]');
      expect(blocks[1].querySelector('[data-tree-path=""]')?.classList
        .contains('snl-canvas-focused')).toBe(true);
    });
  });

  it('undoes a drag-detach so one drag is one undo step', async () => {
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
    const child = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    const canvas = view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!;

    fireEvent.pointerDown(child, { pointerId: 80, button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(child, { pointerId: 80, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(child, { pointerId: 80, clientX: 60, clientY: 60 });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));

    // Detaching is a 6px-slip away; it must be undoable.
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toContain('child');
  });

  const variadicDriver = new MacroDataDriver({
    queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        if (macro_name === 'list') {
          return {
            macro_name, dynamic_arity: true,
            styles: [{ template: '#*', separator: ', ' }]
          } as never;
        }
        if (macro_name === 'pair') {
          return {
            macro_name, dynamic_arity: false,
            styles: [{ template: '#0 + #1' }]
          } as never;
        }
        return null;
      }
    }
  });

  function VariadicHarness({ initial }: { initial: SnlSyntaxTree[] }): React.ReactElement {
    const [forest, setForest] = React.useState(initial);
    return (
      <>
        <output data-testid="root-count">{forest.length}</output>
        <output data-testid="arity">{forest[0]?.children.length ?? 0}</output>
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={variadicDriver}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      </>
    );
  }

  it('grows and shrinks a variadic Macro with + and -', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    // Wait for the async dynamic_arity lookup to land.
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    fireEvent.keyDown(canvas, { key: '-', code: 'NumpadSubtract' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));

    // The main row works too.
    fireEvent.keyDown(canvas, { key: '+', code: 'Equal' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
  });

  it('leaves a fixed-arity Macro alone, since its template owns the count', async () => {
    const view = render(<VariadicHarness initial={[node('pair', [node('a'), node('b')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.container.querySelector('[data-tree-path=""]')?.classList
      .contains('snl-canvas-focused')).toBe(true));

    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.getByTestId('arity').textContent).toBe('2');
    expect(view.queryByLabelText('Argument count')).toBeNull();
  });

  it('undoes an arity change', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));
  });

  it('drives the same change from the inline [- n +] control', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    const control = await waitFor(() => view.getByLabelText('Argument count'));
    expect(within(control).getByLabelText('Argument count value').textContent).toBe('1');

    fireEvent.click(within(control).getByLabelText('Add argument'));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    // The control must survive its own click — clicking it used to clear the
    // focus, so it vanished after a single use.
    fireEvent.click(within(view.getByLabelText('Argument count')).getByLabelText('Remove an argument'));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));
  });

  it('offers argument actions in the menu only for a variadic Macro', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(root);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());
    fireEvent.contextMenu(root);
    const menu = await waitFor(() => view.getByRole('menu', { name: 'Canvas block actions' }));
    expect(within(menu).getByRole('menuitem', { name: /Add argument/ })).toBeTruthy();

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Add argument/ }));
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
  });

  it('removes the slot outright when deleting a variadic child', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a'), node('b')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    fireEvent.keyDown(canvas, { key: 'Delete' });
    // Arity shrinks rather than leaving a blank the author cannot clear.
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('1'));
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('b');
  });

  it('leaves Ctrl/Cmd and Alt +/- to the browser and the OS', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a')])]} />);
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    // Ctrl/Cmd +/- is browser zoom; Alt +/- belongs to the OS.
    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd', ctrlKey: true });
    fireEvent.keyDown(canvas, { key: '-', code: 'NumpadSubtract', metaKey: true });
    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd', altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.getByTestId('arity').textContent).toBe('1');

    // Unmodified still works.
    fireEvent.keyDown(canvas, { key: '+', code: 'NumpadAdd' });
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
  });

  it('sheds an empty slot before evicting real content when shrinking', async () => {
    const view = render(
      <VariadicHarness initial={[node('list', [node('a'), createCanvasHole(1), node('b')])]} />
    );
    const canvas = await waitFor(() => view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!);
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.keyDown(canvas, { key: '-', code: 'NumpadSubtract' });
    // The blank goes; 'b' stays put and nothing is evicted to a new block.
    await waitFor(() => expect(view.getByTestId('arity').textContent).toBe('2'));
    expect(view.getByTestId('root-count').textContent).toBe('1');
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="1"]')?.textContent).toBe('b');
  });

  it('shrinks a variadic parent when a child is dragged out', async () => {
    const view = render(<VariadicHarness initial={[node('list', [node('a'), node('b')])]} />);
    const child = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!);
    // Let the dynamic_arity lookup land before the gesture starts.
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    fireEvent.pointerDown(child, { pointerId: 90, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(child, { pointerId: 90, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(child, { pointerId: 90, clientX: 60, clientY: 60 });

    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('2'));
    // No blank left behind: the variadic parent simply has one argument now.
    expect(view.getByTestId('arity').textContent).toBe('1');
    expect(view.container.querySelector<HTMLElement>('[data-tree-path="0"]')?.textContent).toBe('b');
  });

  it('highlights the variadic parent that a drop would grow', async () => {
    // The append target points one past the last child and so has no element
    // of its own; without the parent fallback there is no drop feedback.
    const view = render(
      <VariadicHarness initial={[node('list', [node('a')]), node('dragged')]} />
    );
    const parent = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(parent);
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());

    const listBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="0"]')!;
    const dragBlock = view.container.querySelector<HTMLElement>('[data-canvas-root-index="1"]')!;
    const dragRoot = dragBlock.querySelector<HTMLElement>('[data-tree-path=""]')!;
    const listRoot = listBlock.querySelector<HTMLElement>('[data-tree-path=""]')!;
    document.elementsFromPoint = () => [listRoot];

    fireEvent.pointerDown(dragRoot, { pointerId: 91, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(dragRoot, { pointerId: 91, clientX: 70, clientY: 70 });
    await waitFor(() => expect(listRoot.classList.contains('snl-canvas-drop-target')).toBe(true));

    fireEvent.pointerUp(dragRoot, { pointerId: 91, clientX: 70, clientY: 70 });
    await waitFor(() => expect(view.getByTestId('root-count').textContent).toBe('1'));
    expect(view.getByTestId('arity').textContent).toBe('2');
  });

  // Cat 2026-07-26: the Canvas hosts two floating inputs. Only the node editor
  // had teardown paths; the "add a root" input leaked in every other exit.
  describe('floating input teardown', () => {
    function AddRootHarness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('root')]);
      return (
        <GuiCanvasEditor
          forest={forest}
          macroDataDriver={driver}
          macroCandidates={[{ id: 'Add.add', labels: [] }]}
          kindPalette={undefined}
          onForestChange={setForest}
          onResetFromSnl={() => undefined}
        />
      );
    }

    const openAddRoot = async (view: ReturnType<typeof render>): Promise<HTMLElement> => {
      const canvas = await waitFor(() =>
        view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
      );
      fireEvent.click(canvas);
      fireEvent.keyDown(canvas, { key: 'f', ctrlKey: true });
      await waitFor(() => view.getByRole('textbox', { name: 'Insert Canvas root Macro' }));
      return canvas;
    };

    it('destroys the add-root input when the user clicks elsewhere on the Canvas', async () => {
      const view = render(<AddRootHarness />);
      const canvas = await openAddRoot(view);
      fireEvent.pointerDown(canvas, { pointerId: 1, button: 0 });
      fireEvent.click(canvas);
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull()
      );
    });

    it('destroys the add-root input when the user right-clicks the Canvas', async () => {
      const view = render(<AddRootHarness />);
      const canvas = await openAddRoot(view);
      fireEvent.contextMenu(canvas);
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull()
      );
    });

    it('destroys the add-root input when the user clicks outside the Canvas', async () => {
      const view = render(<AddRootHarness />);
      await openAddRoot(view);
      fireEvent.pointerDown(document.body, { pointerId: 2, button: 0 });
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull()
      );
    });

    it('never shows the add-root input and the node editor at the same time', async () => {
      const view = render(<AddRootHarness />);
      await openAddRoot(view);
      const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
      fireEvent.doubleClick(root);
      await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
      expect(view.queryByRole('textbox', { name: 'Insert Canvas root Macro' })).toBeNull();
    });

    it('destroys the node editor when the context menu opens a root insert', async () => {
      const view = render(<AddRootHarness />);
      const canvas = await waitFor(() =>
        view.container.querySelector<HTMLElement>('[data-entry-gui-canvas]')!
      );
      const root = view.container.querySelector<HTMLElement>('[data-tree-path=""]')!;
      fireEvent.doubleClick(root);
      await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
      fireEvent.contextMenu(canvas);
      fireEvent.click(view.getByRole('menuitem', { name: /Add root/i }));
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull()
      );
    });

    it('destroys the node editor when the edited node disappears from the forest', async () => {
      function ShrinkHarness(): React.ReactElement {
        const [forest, setForest] = React.useState([node('root', [node('child')])]);
        return (
          <>
            <button type="button" onClick={() => setForest([node('root')])}>drop child</button>
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
      const view = render(<ShrinkHarness />);
      const child = await waitFor(() =>
        view.container.querySelector<HTMLElement>('[data-tree-path="0"]')!
      );
      fireEvent.doubleClick(child);
      await waitFor(() => view.getByRole('textbox', { name: 'Edit focused SNL' }));
      fireEvent.click(view.getByText('drop child'));
      await waitFor(() =>
        expect(view.queryByRole('textbox', { name: 'Edit focused SNL' })).toBeNull()
      );
    });
  });

  it('re-reads dynamic_arity when the Macro source changes', async () => {
    function SwappableHarness(): React.ReactElement {
      const [forest, setForest] = React.useState([node('list', [node('a')])]);
      const [variadic, setVariadic] = React.useState(false);
      // A fresh driver stands in for the Macro being edited mid-session.
      const driver = React.useMemo(() => new MacroDataDriver({
        queries: {
          query_macro: async ({ macro_name }: { macro_name: string }) =>
            macro_name === 'list'
              ? ({ macro_name, dynamic_arity: variadic, styles: [{ template: '#*' }] } as never)
              : null
        }
      }), [variadic]);
      return (
        <>
          <button type="button" onClick={() => setVariadic(true)}>make variadic</button>
          <output data-testid="arity">{forest[0]?.children.length ?? 0}</output>
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
    const view = render(<SwappableHarness />);
    const root = await waitFor(() => view.container.querySelector<HTMLElement>('[data-tree-path=""]')!);
    fireEvent.click(root);
    // Initially fixed: no control, and the cached answer says "not dynamic".
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.queryByLabelText('Argument count')).toBeNull();

    fireEvent.click(view.getByText('make variadic'));
    // A stale cache would keep the control hidden forever.
    await waitFor(() => expect(view.getByLabelText('Argument count')).toBeTruthy());
  });
});
