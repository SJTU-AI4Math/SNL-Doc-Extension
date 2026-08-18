// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SnlSyntaxTree } from '@sjtu-ai4math/snl-basics';
import { CollapsibleRenderer } from './blockRenderers';
import { CollapsibleScope } from './CollapsibleScope';

afterEach(cleanup);

function leaf(name: string): SnlSyntaxTree {
  return { macro_name: name, kind: '', mdata: null, children: [] } as unknown as SnlSyntaxTree;
}

function fold(name: string, body: SnlSyntaxTree[], collapsed?: boolean): SnlSyntaxTree {
  return {
    macro_name: name,
    kind: '',
    mdata: collapsed === undefined ? null : { collapsed },
    children: [leaf(`${name} summary`), ...body]
  } as unknown as SnlSyntaxTree;
}

function Tree({ tree }: { tree: SnlSyntaxTree }): React.ReactElement {
  return (
    <CollapsibleRenderer
      node={tree}
      macro_data_driver={{} as never}
      renderChild={(child) => child.children.length > 0
        ? <Tree tree={child} />
        : <span>{child.macro_name}</span>}
    />
  );
}

function Fixture({ resetKey = 'scope-a' }: { resetKey?: string }): React.ReactElement {
  const tree = fold('left outer', [
    fold('left inner', [leaf('left hidden body')]),
    leaf('left outer body')
  ]);
  const right = fold('right outer', [
    fold('right inner', [leaf('right hidden body')]),
    leaf('right outer body')
  ], false);
  return (
    <CollapsibleScope resetKey={resetKey} label="Test preview">
      <Tree tree={tree} />
      <Tree tree={right} />
    </CollapsibleScope>
  );
}

function disclosure(summary: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-controls]'))
    .find((candidate) => candidate.getAttribute('aria-label')?.toLowerCase().includes(summary.toLowerCase()));
  if (!button) throw new Error(`Missing disclosure for ${summary}`);
  return button;
}

describe('CollapsibleScope', () => {
  it('toggles only the target on plain click and treats Meta alone as a single toggle', () => {
    render(<Fixture />);
    const left = disclosure('left inner');
    const right = disclosure('right inner');

    fireEvent.click(left);
    expect(left.getAttribute('aria-expanded')).toBe('true');
    expect(right.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(right, { metaKey: true });
    expect(left.getAttribute('aria-expanded')).toBe('true');
    expect(right.getAttribute('aria-expanded')).toBe('true');
  });

  it('Ctrl+Click applies the target next state across branches at the same absolute depth', () => {
    render(<Fixture />);
    const leftInner = disclosure('left inner');
    const rightInner = disclosure('right inner');
    const leftOuter = disclosure('left outer');
    const rightOuter = disclosure('right outer');

    expect(leftOuter.getAttribute('aria-expanded')).toBe('false');
    expect(rightOuter.getAttribute('aria-expanded')).toBe('true');
    expect(leftInner.getAttribute('aria-expanded')).toBe('false');
    expect(rightInner.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(leftInner, { ctrlKey: true });
    expect(leftInner.getAttribute('aria-expanded')).toBe('true');
    expect(rightInner.getAttribute('aria-expanded')).toBe('true');
    expect(leftOuter.getAttribute('aria-expanded')).toBe('false');
    expect(rightOuter.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders separate scoped bulk controls with no-op disabled states', () => {
    render(<Fixture />);
    const expand = screen.getByRole('button', { name: 'Expand all collapsible blocks in Test preview' });
    const collapse = screen.getByRole('button', { name: 'Collapse all collapsible blocks in Test preview' });

    expect(expand.disabled).toBe(false);
    expect(collapse.disabled).toBe(false);
    fireEvent.click(expand);
    for (const button of screen.getAllByRole('button').filter((item) =>
      item.hasAttribute('aria-controls'))) {
      expect(button.getAttribute('aria-expanded')).toBe('true');
    }
    expect(expand.disabled).toBe(true);
    expect(collapse.disabled).toBe(false);

    fireEvent.click(collapse);
    expect(collapse.disabled).toBe(true);
    expect(expand.disabled).toBe(false);
  });

  it('preserves state for the same logical scope and resets authored defaults on retarget', () => {
    const view = render(<Fixture resetKey="one" />);
    const leftOuter = disclosure('left outer');
    fireEvent.click(leftOuter);
    expect(leftOuter.getAttribute('aria-expanded')).toBe('true');

    view.rerender(<Fixture resetKey="one" />);
    expect(disclosure('left outer').getAttribute('aria-expanded')).toBe('true');

    view.rerender(<Fixture resetKey="two" />);
    expect(disclosure('left outer').getAttribute('aria-expanded')).toBe('false');
    expect(disclosure('right outer').getAttribute('aria-expanded')).toBe('true');
  });

  it('does not render duplicate controls for a nested scope', () => {
    render(
      <CollapsibleScope resetKey="outer" label="Outer preview">
        <CollapsibleScope resetKey="inner" label="Inner preview">
          <Tree tree={fold('only', [leaf('body')])} />
        </CollapsibleScope>
      </CollapsibleScope>
    );
    expect(document.querySelectorAll('[data-snl-collapsible-controls]')).toHaveLength(1);
  });

  it('renders no bulk controls when the scope has no foldable block', () => {
    render(
      <CollapsibleScope resetKey="flat" label="Flat preview">
        <Tree tree={fold('flat', [])} />
      </CollapsibleScope>
    );
    expect(screen.queryByRole('button', {
      name: 'Expand all collapsible blocks in Flat preview'
    })).toBeNull();
    expect(screen.queryByRole('button', {
      name: 'Collapse all collapsible blocks in Flat preview'
    })).toBeNull();
    expect(document.querySelector('[data-snl-collapsible-controls]')).toBeNull();
  });

});
