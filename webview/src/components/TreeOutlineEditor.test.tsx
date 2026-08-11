import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeOutlineEditor } from './TreeOutlineEditor';

interface Item {
  id: string;
  children: Item[];
}

const roots: Item[] = [
  { id: 'a', children: [] },
  { id: 'b', children: [] },
  { id: 'c', children: [] }
];

afterEach(cleanup);

describe('TreeOutlineEditor move modifiers', () => {
  it('uses the shared node dashboard and emits add-parent for the current node', () => {
    const onOp = vi.fn();
    const view = render(
      <TreeOutlineEditor
        roots={[roots[0]]}
        getId={(node) => node.id}
        getChildren={(node) => node.children}
        renderRow={(node) => node.id}
        renderDashboardLeadingActions={() => <button type="button">Domain action</button>}
        onOp={onOp}
        emptyState={null}
      />
    );

    expect(view.container.querySelector('.snl-tree-operation-dial')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Domain action' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Add parent node' }));
    expect(onOp).toHaveBeenCalledWith({ kind: 'addParent', id: 'a' });
  });

  it('provides a wrapping narrow-panel layout for row content and toolbar', () => {
    const view = render(
      <TreeOutlineEditor
        roots={[roots[0]]}
        getId={(node) => node.id}
        getChildren={(node) => node.children}
        renderRow={(node) => <><span>{node.id}</span><input aria-label="Node ID" /></>}
        onOp={() => undefined}
        emptyState={null}
      />
    );
    const row = view.container.querySelector<HTMLElement>('.snl-outline-row');
    const content = view.container.querySelector<HTMLElement>('.snl-outline-row-content');
    const toolbar = view.container.querySelector<HTMLElement>('.snl-outline-row-toolbar');
    expect(row?.style.flexWrap).toBe('wrap');
    expect(content?.style.minWidth).toBe('0px');
    expect(content?.style.flexWrap).toBe('wrap');
    expect(getComputedStyle(toolbar!).position).toBe('absolute');
    expect(getComputedStyle(toolbar!).pointerEvents).toBe('none');
    const css = document.getElementById('snl-tree-outline-hover-style')?.textContent ?? '';
    expect(css).toContain('.snl-outline-row:hover > .snl-outline-row-toolbar');
    expect(css).not.toContain('.snl-outline-row:focus-within .snl-outline-row-toolbar');
    expect(css).toContain('.snl-outline-row:has(> .snl-outline-row-toolbar:focus-within)');
    expect(css).toContain('@container snl-outline (max-width: 30rem)');
  });

  it('marks Ctrl+move as a direct move to the sibling edge', () => {
    const onOp = vi.fn();
    const view = render(
      <TreeOutlineEditor
        roots={roots}
        getId={(node) => node.id}
        getChildren={(node) => node.children}
        renderRow={(node) => node.id}
        onOp={onOp}
        emptyState={null}
        moveToEdge
      />
    );

    const moveUp = view.getAllByRole('button', { name: 'Move up' })
      .find((button: HTMLElement) => !(button as HTMLButtonElement).disabled)!;
    fireEvent.click(moveUp, {
      ctrlKey: true
    });
    expect(onOp).toHaveBeenCalledWith({
      kind: 'move',
      id: 'b',
      direction: 'up',
      toEdge: true
    });
  });

  it('keeps a plain move as a one-step sibling swap', () => {
    const onOp = vi.fn();
    const view = render(
      <TreeOutlineEditor
        roots={roots}
        getId={(node) => node.id}
        getChildren={(node) => node.children}
        renderRow={(node) => node.id}
        onOp={onOp}
        emptyState={null}
        moveToEdge
      />
    );

    const moveDown = view.getAllByRole('button', { name: 'Move down' })
      .filter((button: HTMLElement) => !(button as HTMLButtonElement).disabled);
    fireEvent.click(moveDown[1]);
    expect(onOp).toHaveBeenCalledWith({
      kind: 'move',
      id: 'b',
      direction: 'down',
      toEdge: false
    });
  });

  it('localizes structural action names in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(
      <TreeOutlineEditor
        roots={roots}
        getId={(node) => node.id}
        getChildren={(node) => node.children}
        renderRow={(node) => node.id}
        onOp={() => undefined}
        emptyState={null}
        moveToEdge
      />
    );
    expect(view.getAllByRole('button', { name: '添加父节点' })).toHaveLength(3);
    expect(view.getAllByRole('button', { name: '添加同级节点' })).toHaveLength(3);
    expect(view.getAllByRole('button', { name: '添加子节点' })).toHaveLength(3);
    expect(view.getAllByRole('button', { name: '上移' })).toHaveLength(3);
    document.documentElement.lang = 'en';
  });
});
