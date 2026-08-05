import React from 'react';
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

    fireEvent.click(view.getAllByRole('button', {
      name: 'Move up (Ctrl/Cmd-click: move to first sibling)'
    })[0], {
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

    fireEvent.click(view.getAllByRole('button', {
      name: 'Move down (Ctrl/Cmd-click: move to last sibling)'
    })[1]);
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
    expect(view.getAllByRole('button', { name: '添加子条目' })).toHaveLength(3);
    expect(view.getAllByRole('button', {
      name: '上移（Ctrl/Cmd + 单击：移到同级首位）'
    })).toHaveLength(2);
    document.documentElement.lang = 'en';
  });
});
