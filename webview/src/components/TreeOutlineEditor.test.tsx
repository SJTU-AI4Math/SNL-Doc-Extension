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

  it('defaults foldable nodes closed and provides no-op-aware all controls', () => {
    const tree: Item[] = [{ id: 'root', children: [{ id: 'child', children: [] }] }];
    const view = render(
      <TreeOutlineEditor roots={tree} getId={node => node.id} getChildren={node => node.children}
        renderRow={node => node.id} onOp={() => undefined} emptyState={null} />
    );
    const disclosure = view.getByRole('button', { name: 'Expand root' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.getAttribute('aria-controls')).toBeTruthy();
    expect((view.getByRole('button', { name: 'Expand all' }) as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByRole('button', { name: 'Collapse all' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Expand all' }));
    expect(view.getByRole('button', { name: 'Collapse root' })).toBeTruthy();
  });

  it('uses Ctrl only for absolute-depth toggling including hidden branches', () => {
    const tree: Item[] = [
      { id: 'a', children: [{ id: 'a1', children: [{ id: 'ax', children: [] }] }] },
      { id: 'b', children: [{ id: 'b1', children: [{ id: 'bx', children: [] }] }] }
    ];
    const view = render(
      <TreeOutlineEditor roots={tree} getId={node => node.id} getChildren={node => node.children}
        renderRow={node => node.id} onOp={() => undefined} emptyState={null} />
    );
    fireEvent.click(view.getByRole('button', { name: 'Expand all' }));
    fireEvent.click(view.getByRole('button', { name: 'Collapse a1' }), { ctrlKey: true });
    expect(view.getByRole('button', { name: 'Expand a1' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Expand b1' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Collapse a' }), { metaKey: true });
    expect(view.getByRole('button', { name: 'Expand a' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Collapse b' })).toBeTruthy();
  });

  it('disables both all controls for a leaf-only tree', () => {
    const view = render(
      <TreeOutlineEditor roots={roots} getId={node => node.id} getChildren={node => node.children}
        renderRow={node => node.id} onOp={() => undefined} emptyState={null} />
    );
    expect((view.getByRole('button', { name: 'Expand all' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Collapse all' }) as HTMLButtonElement).disabled).toBe(true);
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
