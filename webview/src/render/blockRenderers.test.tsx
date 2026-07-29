import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { CollapsibleRenderer, extensionRenderers } from './blockRenderers';

// This project does not enable vitest `globals`, so testing-library's automatic
// cleanup hook is not installed. Unmount explicitly or renders pile up in the
// same document and `getByRole` finds several toggles.
afterEach(cleanup);

function node(text: string, mdata: unknown = null): SnlSyntaxTree {
  return { macro_name: text, kind: '', mdata, children: [] } as unknown as SnlSyntaxTree;
}

function blockNode(children: SnlSyntaxTree[], mdata: unknown = null): SnlSyntaxTree {
  return { macro_name: 'demo', kind: '', mdata, children } as unknown as SnlSyntaxTree;
}

const renderChild = (child: SnlSyntaxTree) => (
  <span data-testid={`child-${child.macro_name}`}>{child.macro_name}</span>
);

function mount(tree: SnlSyntaxTree) {
  return render(
    <CollapsibleRenderer
      node={tree}
      macro_data_driver={{} as never}
      renderChild={renderChild}
    />
  );
}

describe('extensionRenderers', () => {
  // Regression lock: the view SHALLOW-merges hooks, so passing `renderers`
  // replaces the whole registry. If someone drops the `...defaultRenderers`
  // spread, every built-in block renderer silently disappears.
  it('keeps all four SNL-Basics built-ins alongside collapsible', () => {
    for (const key of ['list', 'enumerate', 'table', 'centered']) {
      expect(typeof extensionRenderers[key]).toBe('function');
    }
    expect(extensionRenderers.collapsible).toBe(CollapsibleRenderer);
  });
});

describe('CollapsibleRenderer', () => {
  it('toggles body visibility on click', () => {
    mount(blockNode([node('summary'), node('body1'), node('body2')]));
    expect(screen.getByTestId('child-summary')).toBeTruthy();
    expect(screen.queryByTestId('child-body1')).toBeTruthy();

    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(btn);
    expect(screen.queryByTestId('child-body1')).toBeNull();
    expect(screen.queryByTestId('child-body2')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
    // Summary always visible.
    expect(screen.getByTestId('child-summary')).toBeTruthy();

    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('child-body1')).toBeTruthy();
  });

  it('starts collapsed when mdata.collapsed === true', () => {
    mount(blockNode([node('summary'), node('body1')], { collapsed: true }));
    expect(screen.queryByTestId('child-body1')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  });

  it('starts expanded for other mdata shapes', () => {
    mount(blockNode([node('summary'), node('body1')], { collapsed: 'true' }));
    expect(screen.queryByTestId('child-body1')).toBeTruthy();
  });

  it('renders no toggle when there are fewer than two children', () => {
    mount(blockNode([node('only')]));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('child-only')).toBeTruthy();

    const empty = render(
      <CollapsibleRenderer
        node={blockNode([])}
        macro_data_driver={{} as never}
        renderChild={renderChild}
      />
    );
    expect(empty.container.querySelector('button')).toBeNull();
  });

  it('exposes an aria-label on the toggle', () => {
    mount(blockNode([node('summary'), node('body1')]));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Collapse');
  });
});
