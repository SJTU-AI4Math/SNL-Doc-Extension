import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeNodeActionDashboard } from './TreeNodeActionDashboard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TreeNodeActionDashboard', () => {
  it('emits the shared move, indentation, add-position and delete actions', () => {
    const onAction = vi.fn();
    const view = render(
      <TreeNodeActionDashboard
        capabilities={{
          canMoveUp: true,
          canMoveDown: true,
          canIndent: true,
          canOutdent: true,
          canAddParent: true,
          canAddChild: true,
          canAddSibling: true,
          canDelete: true
        }}
        onAction={onAction}
      />
    );

    fireEvent.click(view.getByRole('button', { name: 'Move up' }), { ctrlKey: true });
    fireEvent.click(view.getByRole('button', { name: 'Outdent' }));
    fireEvent.click(view.getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Add parent node' }));
    fireEvent.click(view.getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Add child node' }));
    fireEvent.click(view.getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Add sibling node' }));
    fireEvent.click(view.getByRole('button', { name: 'Indent' }));
    fireEvent.click(view.getByRole('button', { name: 'Move down' }));
    fireEvent.click(view.getByRole('button', { name: 'Delete subtree' }));

    expect(onAction.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { kind: 'moveUp', toEdge: true },
      { kind: 'outdent', toEdge: false },
      { kind: 'addParent' },
      { kind: 'addChild' },
      { kind: 'addSibling' },
      { kind: 'indent', toEdge: false },
      { kind: 'moveDown', toEdge: false },
      { kind: 'delete' }
    ]);
  });

  it('disables unavailable operations and accepts custom leading actions', () => {
    const view = render(
      <TreeNodeActionDashboard
        capabilities={{
          canMoveUp: false,
          canMoveDown: false,
          canIndent: false,
          canOutdent: false,
          canAddParent: false,
          canAddChild: true,
          canAddSibling: false,
          canDelete: false
        }}
        leadingActions={<button type="button">Domain action</button>}
        onAction={() => undefined}
      />
    );

    expect(view.getByRole('button', { name: 'Domain action' })).toBeTruthy();
    expect((view.getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Outdent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Indent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.queryByRole('button', { name: 'Delete subtree' })).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Choose add position' }));
    expect((view.getByRole('menuitem', { name: 'Add parent node' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('menuitem', { name: 'Add child node' }) as HTMLButtonElement).disabled).toBe(false);
    expect((view.getByRole('menuitem', { name: 'Add sibling node' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('owns menu navigation while preserving native Tab traversal', () => {
    const ancestorKeyDown = vi.fn();
    const raf: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      raf.push(callback);
      return raf.length;
    });
    const view = render(
      <div onKeyDown={ancestorKeyDown}>
        <button type="button">Before menu</button>
        <TreeNodeActionDashboard
          capabilities={{
            canMoveUp: true,
            canMoveDown: true,
            canIndent: true,
            canOutdent: true,
            canAddParent: true,
            canAddChild: true,
            canAddSibling: true,
            canDelete: false
          }}
          onAction={() => undefined}
        />
        <button type="button">After menu</button>
      </div>
    );
    const trigger = view.getByRole('button', { name: 'Choose add position' });
    fireEvent.click(trigger);
    const parent = view.getByRole('menuitem', { name: 'Add parent node' });
    const sibling = view.getByRole('menuitem', { name: 'Add sibling node' });
    expect((parent as HTMLButtonElement).tabIndex).toBe(0);
    expect((sibling as HTMLButtonElement).tabIndex).toBe(-1);

    fireEvent.keyDown(parent, { key: 'End' });
    expect(document.activeElement).toBe(sibling);
    expect((sibling as HTMLButtonElement).tabIndex).toBe(0);
    expect((parent as HTMLButtonElement).tabIndex).toBe(-1);
    fireEvent.keyDown(sibling, { key: 'Home' });
    expect(document.activeElement).toBe(parent);
    expect(ancestorKeyDown).not.toHaveBeenCalled();

    const tabAllowed = fireEvent.keyDown(parent, { key: 'Tab' });
    expect(tabAllowed).toBe(true);
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    const afterMenu = view.getByRole('button', { name: 'After menu' });
    act(() => { afterMenu.focus(); });
    act(() => { raf.shift()?.(0); });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(afterMenu);

    fireEvent.click(trigger);
    const last = view.getByRole('menuitem', { name: 'Add sibling node' });
    fireEvent.keyDown(last, { key: 'End' });
    const reverseTabAllowed = fireEvent.keyDown(last, { key: 'Tab', shiftKey: true });
    expect(reverseTabAllowed).toBe(true);
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    const moveDown = view.getByRole('button', { name: 'Move down' });
    act(() => { moveDown.focus(); });
    act(() => { raf.shift()?.(0); });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(moveDown);

    fireEvent.click(trigger);
    fireEvent.keyDown(view.getByRole('menuitem', { name: 'Add parent node' }), { key: 'Escape' });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
