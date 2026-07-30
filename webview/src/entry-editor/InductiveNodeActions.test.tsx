import React from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MacroDataDriver } from '@sjtu-ai4math/snl-basics';
import { GuiInductiveEditor } from '../CreateEntryApp';

const driver = new MacroDataDriver({
  queries: { query_macro: async () => null }
});

function renderEditor(initial = 'root(a,b(c))') {
  let latest = initial;
  const onOpenMacroEditor = vi.fn();
  const view = render(
    <GuiInductiveEditor
      snl={initial}
      macroDataDriver={driver}
      macroCandidates={[]}
      macroOrigin={{ root: 'macros.json' }}
      onOpenMacroEditor={onOpenMacroEditor}
      onChange={(next) => { latest = next; }}
    />
  );
  return { view, latest: () => latest, onOpenMacroEditor };
}

function rowForInput(input: HTMLElement): HTMLElement {
  const row = input.closest<HTMLElement>('.snl-tree-row');
  if (!row) throw new Error('Expected input inside an inductive row');
  return row;
}

afterEach(cleanup);

describe('Inductive node action dial', () => {
  it('uses a compact directional dial and keeps the Macro and delete actions', () => {
    const { view, onOpenMacroEditor } = renderEditor();
    const rootRow = rowForInput(view.getAllByRole('textbox')[0]);
    const childRow = rowForInput(view.getAllByRole('textbox')[2]);
    const dial = childRow.querySelector<HTMLElement>('.snl-tree-operation-dial');

    expect(dial).not.toBeNull();
    expect(within(dial!).getByRole('button', { name: 'Move up' }).textContent).toBe('↑');
    expect(within(dial!).getByRole('button', { name: 'Move down' }).textContent).toBe('↓');
    expect(within(dial!).getByRole('button', { name: 'Outdent' }).textContent).toBe('←');
    expect(within(dial!).getByRole('button', { name: 'Indent' }).textContent).toBe('→');
    expect(within(dial!).getByRole('button', { name: 'Choose add position' }).textContent).toBe('+');
    expect(parseFloat(getComputedStyle(within(dial!).getByRole('button', { name: 'Move up' })).padding)).toBe(0);
    expect(childRow.querySelector('.snl-tree-delete-action')).not.toBeNull();
    expect(within(childRow).getByRole('button', { name: 'Delete subtree' })).toBeTruthy();
    expect(childRow.querySelector('.snl-tree-row-toolbar')?.textContent).not.toContain('+ child');
    expect(childRow.querySelector('.snl-tree-row-toolbar')?.textContent).not.toContain('+ parent');
    expect(within(rootRow).queryByRole('button', { name: 'Delete subtree' })).toBeNull();
    fireEvent.click(within(rootRow).getByRole('button', { name: 'Choose add position' }));
    expect((within(rootRow).getByRole('menuitem', { name: 'Add sibling' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(within(rootRow).getByRole('menu'), { key: 'Escape' });

    fireEvent.click(within(rootRow).getByRole('button', { name: 'Edit macro' }));
    expect(onOpenMacroEditor).toHaveBeenCalledWith({
      name: 'root',
      env_mode: undefined,
      style_name: undefined
    });
  });

  it('opens all three add positions from the center and closes the choices', () => {
    const { view } = renderEditor();
    const childRow = rowForInput(view.getAllByRole('textbox')[2]);
    const add = within(childRow).getByRole('button', { name: 'Choose add position' });

    expect(add.getAttribute('aria-haspopup')).toBe('menu');
    expect(add.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(add);

    const menu = within(childRow).getByRole('menu', { name: 'Add node position' });
    expect(add.getAttribute('aria-expanded')).toBe('true');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'parent',
      'child',
      'sibling'
    ]);
    const choices = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(choices[0]);
    fireEvent.keyDown(choices[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(choices[1]);

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(within(childRow).queryByRole('menu', { name: 'Add node position' })).toBeNull();
    expect(document.activeElement).toBe(add);

    fireEvent.click(add);
    const reopened = within(childRow).getByRole('menu', { name: 'Add node position' });
    const lastChoice = within(reopened).getByRole('menuitem', { name: 'Add sibling' });
    const deleteButton = within(childRow).getByRole('button', { name: 'Delete subtree' });
    fireEvent.blur(lastChoice, { relatedTarget: deleteButton });
    expect(within(childRow).queryByRole('menu', { name: 'Add node position' })).toBeNull();

    fireEvent.click(add);
    fireEvent.mouseDown(document.body);
    expect(within(childRow).queryByRole('menu', { name: 'Add node position' })).toBeNull();
  });

  it('dispatches parent, child, and sibling additions without changing their tree semantics', async () => {
    let rendered = renderEditor('root(a,b)');
    let firstChild = rowForInput(rendered.view.getAllByRole('textbox')[2]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add parent' }));
    expect(rendered.latest()).toBe('root((a),b)');

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[2]);
    const rowsBeforeChild = rendered.view.container.querySelectorAll('.snl-tree-row').length;
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add child' }));
    expect(rendered.latest()).toBe('root(a,b)');
    expect(rendered.view.container.querySelectorAll('.snl-tree-row')).toHaveLength(rowsBeforeChild + 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Choose add position');
    expect(within(firstChild).queryByRole('menu')).toBeNull();

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[2]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add sibling' }));
    expect(rendered.latest()).toBe('root(a,,b)');
  });

  it('preserves directional disabled conditions and operations', () => {
    const rendered = renderEditor('root(a,b(c))');
    const inputs = rendered.view.getAllByRole('textbox');
    const rootRow = rowForInput(inputs[0]);
    const firstRow = rowForInput(inputs[2]);
    const secondRow = rowForInput(inputs[4]);
    const nestedRow = rowForInput(inputs[6]);

    expect((within(rootRow).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rootRow).getByRole('button', { name: 'Move down' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rootRow).getByRole('button', { name: 'Outdent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rootRow).getByRole('button', { name: 'Indent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(firstRow).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(firstRow).getByRole('button', { name: 'Indent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(firstRow).getByRole('button', { name: 'Outdent' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(secondRow).getByRole('button', { name: 'Move up' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(nestedRow).getByRole('button', { name: 'Outdent' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(secondRow).getByRole('button', { name: 'Move up' }));
    expect(rendered.latest()).toBe('root(b(c),a)');
  });

  it('keeps deletion independent from the dial', () => {
    const rendered = renderEditor('root(a,b)');
    const firstRow = rowForInput(rendered.view.getAllByRole('textbox')[2]);

    fireEvent.click(within(firstRow).getByRole('button', { name: 'Delete subtree' }));
    expect(rendered.latest()).toBe('root(b)');
  });
});
