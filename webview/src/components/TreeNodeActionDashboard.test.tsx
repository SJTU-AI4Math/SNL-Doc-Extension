import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TreeNodeActionDashboard } from './TreeNodeActionDashboard';

const ALL_CAPABILITIES = {
  canMoveUp: true,
  canMoveDown: true,
  canIndent: true,
  canOutdent: true,
  canAddParent: true,
  canAddChild: true,
  canAddSibling: true,
  canDelete: true
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TreeNodeActionDashboard', () => {
  it('emits every structural operation directly from its fixed nine-cell grid', () => {
    const onAction = vi.fn();
    const view = render(
      <TreeNodeActionDashboard
        capabilities={ALL_CAPABILITIES}
        bottomLeftAction={<button type="button">Macro action</button>}
        onAction={onAction}
      />
    );
    const grid = view.container.querySelector<HTMLElement>('.snl-tree-operation-dial')!;

    const expected = [
      ['Add parent node', 'add-parent', 'snl-tree-dial-action--add-parent'],
      ['Move up', 'move-up', 'snl-tree-dial-action--up'],
      ['Delete subtree', 'delete', 'snl-tree-dial-action--delete'],
      ['Outdent', 'outdent', 'snl-tree-dial-action--outdent'],
      ['Add sibling node', 'add-sibling', 'snl-tree-dial-action--add-sibling'],
      ['Indent', 'indent', 'snl-tree-dial-action--indent'],
      ['Move down', 'move-down', 'snl-tree-dial-action--down'],
      ['Add child node', 'add-child', 'snl-tree-dial-action--add-child']
    ] as const;
    for (const [label, icon, className] of expected) {
      const button = within(grid).getByRole('button', { name: label });
      expect(button.classList.contains(className)).toBe(true);
      expect(button.querySelector(`svg[data-snl-icon="${icon}"]`)).toBeTruthy();
    }
    expect(within(grid).getByRole('button', { name: 'Macro action' })
      .closest('[data-snl-dashboard-bottom-left]')).toBeTruthy();
    expect(within(grid).getByRole('button', { name: 'Outdent' })
      .querySelector('path')?.getAttribute('d')).toBe('M3 3v10M12.5 8h-7M8 5.5 5.5 8 8 10.5');
    expect(within(grid).getByRole('button', { name: 'Indent' })
      .querySelector('path')?.getAttribute('d')).toBe('M3 3v10M5.5 8h7M10 5.5 12.5 8 10 10.5');
    expect(view.queryByRole('menu')).toBeNull();
    expect(view.queryByRole('button', { name: 'Choose add position' })).toBeNull();

    fireEvent.click(within(grid).getByRole('button', { name: 'Move up' }), { ctrlKey: true });
    fireEvent.click(within(grid).getByRole('button', { name: 'Outdent' }));
    fireEvent.click(within(grid).getByRole('button', { name: 'Add parent node' }));
    fireEvent.click(within(grid).getByRole('button', { name: 'Add sibling node' }));
    fireEvent.click(within(grid).getByRole('button', { name: 'Indent' }));
    fireEvent.click(within(grid).getByRole('button', { name: 'Move down' }));
    fireEvent.click(within(grid).getByRole('button', { name: 'Add child node' }));
    fireEvent.click(within(grid).getByRole('button', { name: 'Delete subtree' }));

    expect(onAction.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { kind: 'moveUp', toEdge: true },
      { kind: 'outdent', toEdge: false },
      { kind: 'addParent' },
      { kind: 'addSibling' },
      { kind: 'indent', toEdge: false },
      { kind: 'moveDown', toEdge: false },
      { kind: 'addChild' },
      { kind: 'delete' }
    ]);
  });

  it('keeps all unavailable grid cells present and disabled', () => {
    const view = render(
      <TreeNodeActionDashboard
        capabilities={{
          canMoveUp: false,
          canMoveDown: false,
          canIndent: false,
          canOutdent: false,
          canAddParent: false,
          canAddChild: false,
          canAddSibling: false,
          canDelete: false
        }}
        onAction={() => undefined}
      />
    );

    for (const label of [
      'Move up', 'Move down', 'Outdent', 'Indent',
      'Add parent node', 'Add child node', 'Add sibling node', 'Delete subtree'
    ]) {
      expect((view.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('keeps non-grid domain content outside the fixed nine cells', () => {
    const view = render(
      <TreeNodeActionDashboard
        capabilities={ALL_CAPABILITIES}
        leadingActions={<span>Metric</span>}
        onAction={() => undefined}
      />
    );
    expect(view.getByText('Metric').closest('.snl-tree-operation-dial')).toBeNull();
  });

  it('locks every action to the requested three-by-three coordinate', () => {
    const css = readFileSync('webview/src/components/TreeNodeActionDashboard.css', 'utf8');
    const gridArea = (className: string): string | undefined => {
      const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return css.match(new RegExp(`\\.${escaped}\\s*\\{[^}]*grid-area:\\s*([^;}]+)`))?.[1]?.trim();
    };
    expect({
      parent: gridArea('snl-tree-dial-action--add-parent'),
      up: gridArea('snl-tree-dial-action--up'),
      delete: gridArea('snl-tree-dial-action--delete'),
      left: gridArea('snl-tree-dial-action--outdent'),
      sibling: gridArea('snl-tree-dial-action--add-sibling'),
      right: gridArea('snl-tree-dial-action--indent'),
      macro: gridArea('snl-tree-dial-action--domain'),
      down: gridArea('snl-tree-dial-action--down'),
      child: gridArea('snl-tree-dial-action--add-child')
    }).toEqual({
      parent: '1 / 1', up: '1 / 2', delete: '1 / 3',
      left: '2 / 1', sibling: '2 / 2', right: '2 / 3',
      macro: '3 / 1', down: '3 / 2', child: '3 / 3'
    });
  });

  it('computes an opaque theme-correct board without a cluster plate or shadow', () => {
    const css = readFileSync('webview/src/components/TreeNodeActionDashboard.css', 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.documentElement.style.setProperty('--vscode-editorWidget-background', 'transparent');
    document.documentElement.style.setProperty('--vscode-editor-background', 'transparent');

    try {
      for (const [scheme, expectedBase] of [
        ['light', '#ffffff'],
        ['dark', '#313131'],
        ['high-contrast-light', '#ffffff'],
        ['high-contrast', '#313131']
      ] as const) {
        document.documentElement.dataset.snlColorScheme = scheme;
        const view = render(
          <TreeNodeActionDashboard
            capabilities={ALL_CAPABILITIES}
            onAction={() => undefined}
          />
        );
        const dial = view.container.querySelector<HTMLElement>('.snl-tree-operation-dial')!;
        const cluster = view.container.querySelector<HTMLElement>('.snl-tree-operation-cluster')!;
        const dialStyle = getComputedStyle(dial);
        const clusterStyle = getComputedStyle(cluster);

        expect(dialStyle.getPropertyValue('--snl-tree-board-opaque-background').trim(), scheme)
          .toBe(expectedBase);
        expect(dialStyle.backgroundColor, scheme)
          .toBe('var(--snl-tree-board-opaque-background)');
        expect(dialStyle.backgroundImage, scheme)
          .toContain('var(--vscode-editorWidget-background, transparent)');
        expect(dialStyle.gridTemplateColumns, scheme).toBe('repeat(3, 1.5rem)');
        expect(dialStyle.gridTemplateRows, scheme).toBe('repeat(3, 1.5rem)');
        expect(clusterStyle.backgroundColor, scheme).toBe('rgba(0, 0, 0, 0)');
        expect(clusterStyle.boxShadow, scheme).toBe('');
        view.unmount();
      }
    } finally {
      style.remove();
      document.documentElement.removeAttribute('data-snl-color-scheme');
      document.documentElement.style.removeProperty('--vscode-editorWidget-background');
      document.documentElement.style.removeProperty('--vscode-editor-background');
    }
  });

  it('joins the parent and child plus signs to their dual elbow strokes', () => {
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
        onAction={vi.fn()}
      />
    );
    const parentIcon = view.getByRole('button', { name: 'Add parent node' }).querySelector('svg');
    const childIcon = view.getByRole('button', { name: 'Add child node' }).querySelector('svg');
    expect(parentIcon?.querySelectorAll('path')).toHaveLength(1);
    expect(childIcon?.querySelectorAll('path')).toHaveLength(1);
    expect(parentIcon?.querySelector('path')?.getAttribute('d')).toBe('M8 2v8h5M5 5h6');
    expect(childIcon?.querySelector('path')?.getAttribute('d')).toBe('M4 4v6h10M11 7v6');
  });
});
