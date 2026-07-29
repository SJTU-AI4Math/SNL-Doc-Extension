import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { COLLAPSE_TOGGLE_GEOMETRY } from '../../../src/collapseToggleContract';
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

  // Regression lock (found by rendering a real proof entry in a browser): a
  // block renderer walks `node.children` and never sees the style template, so
  // the template's `separator` does NOT apply. Without a block-level wrapper
  // per child the steps concatenate as inline text — the Rolle proof rendered
  // as "…exists there.hence F'(c) = 0…".
  it('wraps each body child in its own block so steps do not run together', () => {
    const { container } = mount(
      blockNode([node('summary'), node('body1'), node('body2')])
    );
    const parts = container.querySelectorAll('.snl-collapsible__body > .snl-collapsible__part');
    expect(parts.length).toBe(2);
    // Each wrapper holds exactly one rendered child.
    expect(parts[0].querySelector('[data-testid="child-body1"]')).toBeTruthy();
    expect(parts[1].querySelector('[data-testid="child-body2"]')).toBeTruthy();
  });

  // Regression lock (cat, 2026-07-29: "箭头会跑到左侧外面去"): the shared
  // COLLAPSE_TOGGLE_STYLE is `position:absolute; left:-20px`, i.e. the glyph
  // hangs in a gutter OUTSIDE the row's content box. That only lands correctly
  // if (a) the host reserves the gutter with padding-left, and (b) the
  // SUMMARY ROW is the positioning context — if `position:relative` sits on
  // the host instead, the offset is measured from the padding box's outer edge
  // and the arrow escapes past the left border again.
  //
  // jsdom does not do layout, so the geometry itself is asserted in the
  // browser harness. What is checkable here is the DOM contract the CSS keys
  // off: the toggle must be a direct child of `.snl-collapsible__summary`,
  // which must be a direct child of `.snl-collapsible`.
  it('nests the toggle inside the summary row so the gutter offset resolves', () => {
    const { container } = mount(blockNode([node('summary'), node('body1')]));
    const host = container.querySelector('.snl-collapsible');
    expect(host).toBeTruthy();
    const row = host!.querySelector(':scope > .snl-collapsible__summary');
    expect(row).toBeTruthy();
    const btn = row!.querySelector(':scope > button');
    expect(btn).toBeTruthy();
    // The absolute offset comes from the shared contract, not a local literal.
    expect((btn as HTMLElement).style.position).toBe('absolute');
    expect((btn as HTMLElement).style.left).toBe(`${COLLAPSE_TOGGLE_GEOMETRY.left}px`);
    // Presentation lives in ui.css; the renderer must not re-inline it.
    expect((host as HTMLElement).getAttribute('style')).toBeNull();
    expect((row as HTMLElement).getAttribute('style')).toBeNull();
  });
});
