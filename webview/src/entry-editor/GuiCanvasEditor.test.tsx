import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MacroDataDriver, type SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { GuiCanvasEditor } from '../CreateEntryApp';

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
    expect(view.container.querySelectorAll('[data-canvas-root]')).toHaveLength(2);
  });
});
