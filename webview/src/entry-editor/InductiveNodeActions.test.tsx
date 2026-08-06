import { readFileSync } from 'node:fs';
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

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('Inductive node action dial', () => {
  it('numbers visible child nodes from #0 at every depth', () => {
    const { view } = renderEditor('root(a,b(c,d))');
    const labels = Array.from(view.container.querySelectorAll('.snl-tree-row'))
      .map((row) => row.querySelector('[data-snl-node-number]')?.textContent ?? '');

    expect(labels).toEqual(['', '#0', '#1', '#1.0', '#1.1']);
  });

  it('localizes Inductive actions, tooltips, accessibility, and add-position menus in Simplified Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const { view } = renderEditor();
    expect(view.getByText(/归纳式编辑器/)).toBeTruthy();
    const childRow = rowForInput(view.getAllByRole('textbox')[1]);
    expect(within(childRow).getByRole('button', { name: '上移' }).getAttribute('title'))
      .toBe('无法上移——已是第一个');
    expect(within(childRow).getByRole('button', { name: '减少缩进' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '增加缩进' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '下移' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '删除子树' }).getAttribute('title'))
      .toBe('删除此子树');

    fireEvent.click(within(childRow).getByRole('button', { name: '选择添加位置' }));
    const menu = within(childRow).getByRole('menu', { name: '添加节点位置' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '父节点',
      '子节点',
      '同级节点'
    ]);
    expect(within(menu).getByRole('menuitem', { name: '添加父节点' }).getAttribute('title'))
      .toBe('在此节点外添加父节点');
  });

  it('uses a compact directional dial and keeps the Macro and delete actions', () => {
    const { view, onOpenMacroEditor } = renderEditor();
    const rootRow = rowForInput(view.getAllByRole('textbox')[0]);
    const childRow = rowForInput(view.getAllByRole('textbox')[1]);
    const dial = childRow.querySelector<HTMLElement>('.snl-tree-operation-dial');

    expect(dial).not.toBeNull();
    expect(getComputedStyle(childRow).position).toBe('relative');
    const toolbar = childRow.querySelector<HTMLElement>('.snl-tree-row-toolbar')!;
    expect(getComputedStyle(toolbar).position).toBe('absolute');
    expect(getComputedStyle(toolbar).pointerEvents).toBe('none');
    expect(getComputedStyle(toolbar).left).toBe('auto');
    expect(getComputedStyle(toolbar).right).toBe('0.3rem');
    const toolbarRevealRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.includes('.snl-tree-row:hover .snl-tree-row-toolbar')
      ) as CSSStyleRule | undefined;
    expect(toolbarRevealRule?.style.pointerEvents).toBe('auto');
    const hoverRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.includes('.snl-tree-row:hover') &&
        rule.style.paddingRight !== ''
      ) as CSSStyleRule | undefined;
    expect(hoverRule?.style.paddingRight).toBe('8.4rem');
    const responsiveCss = Array.from(view.container.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(responsiveCss).toContain('@container snl-inductive (max-width: 30rem)');
    expect(responsiveCss).toContain('padding-bottom: 4.9rem');
    expect(responsiveCss).toContain('padding-bottom: 6.9rem');
    expect(responsiveCss).toContain('bottom: 2.15rem');
    const styleSelect = within(childRow).getByRole('combobox') as HTMLSelectElement;
    expect(styleSelect.style.flexShrink).toBe('1');
    expect(styleSelect.style.minWidth).toBe('4rem');

    const canvasCss = readFileSync('webview/src/entry-editor/canvas.css', 'utf8');
    const compactWidth = Number(
      canvasCss.match(/\.snl-tree-compact-action[\s\S]*?width:\s*([\d.]+)rem/)?.[1]
    );
    const actionGap = Number(
      canvasCss.match(/\.snl-tree-operation-cluster[\s\S]*?gap:\s*([\d.]+)rem/)?.[1]
    );
    expect(Number.isFinite(compactWidth)).toBe(true);
    expect(compactWidth).toBeGreaterThanOrEqual(1.5);
    expect(Number.isFinite(actionGap)).toBe(true);
    const authoredToolbarWidth =
      compactWidth + actionGap + 3 * compactWidth + actionGap + compactWidth;
    const visibleRowReserve = parseFloat(hoverRule!.style.paddingRight);
    const toolbarRight = parseFloat(getComputedStyle(toolbar).right);
    expect(visibleRowReserve - toolbarRight - authoredToolbarWidth).toBeGreaterThanOrEqual(0.25);
    for (const [label, icon] of [
      ['Move up', 'move-up'],
      ['Move down', 'move-down'],
      ['Outdent', 'outdent'],
      ['Indent', 'indent'],
      ['Choose add position', 'add']
    ] as const) {
      const action = within(dial!).getByRole('button', { name: label });
      expect(action.querySelector(`svg[data-snl-icon="${icon}"]`)).toBeTruthy();
      expect(action.classList.contains('snl-btn--icon')).toBe(true);
    }
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
    const childRow = rowForInput(view.getAllByRole('textbox')[1]);
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
    let firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add parent' }));
    expect(rendered.latest()).toBe('root((a),b)');

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
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
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add sibling' }));
    expect(rendered.latest()).toBe('root(a,,b)');
  });

  it('preserves directional disabled conditions and operations', () => {
    const rendered = renderEditor('root(a,b(c))');
    const inputs = rendered.view.getAllByRole('textbox');
    const rootRow = rowForInput(inputs[0]);
    const firstRow = rowForInput(inputs[1]);
    const secondRow = rowForInput(inputs[2]);
    const nestedRow = rowForInput(inputs[3]);

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

  it('Ctrl+click moves a subtree to the furthest valid sibling above', () => {
    const rendered = renderEditor('root(a,b(c),d,e(f))');
    const row = rowForInput(
      rendered.view.getAllByRole('textbox').find((input) => (input as HTMLInputElement).value === 'e')!
    );

    fireEvent.click(within(row).getByRole('button', { name: 'Move up' }), { ctrlKey: true });

    expect(rendered.latest()).toBe('root(e(f),a,b(c),d)');
  });

  it('Ctrl+click moves a subtree to the furthest valid sibling below', () => {
    const rendered = renderEditor('root(a(x),b(c),d,e)');
    const row = rowForInput(
      rendered.view.getAllByRole('textbox').find((input) => (input as HTMLInputElement).value === 'a')!
    );

    fireEvent.click(within(row).getByRole('button', { name: 'Move down' }), { ctrlKey: true });

    expect(rendered.latest()).toBe('root(b(c),d,e,a(x))');
  });

  it('Ctrl+click outdents a subtree to the furthest valid ancestor level', () => {
    const rendered = renderEditor('root(a(b(c(d(e)))),z)');
    const row = rowForInput(
      rendered.view.getAllByRole('textbox').find((input) => (input as HTMLInputElement).value === 'd')!
    );

    fireEvent.click(within(row).getByRole('button', { name: 'Outdent' }), { ctrlKey: true });

    expect(rendered.latest()).toBe('root(a(b(c)),d(e),z)');
  });

  it('Ctrl+click indents a subtree to the furthest valid descendant position', () => {
    const rendered = renderEditor('root(a(x,y),b(c),d(e))');
    const row = rowForInput(
      rendered.view.getAllByRole('textbox').find((input) => (input as HTMLInputElement).value === 'd')!
    );

    fireEvent.click(within(row).getByRole('button', { name: 'Indent' }), { ctrlKey: true });

    expect(rendered.latest()).toBe('root(a(x,y),b(c(d(e))))');
  });

  it('keeps deletion independent from the dial', () => {
    const rendered = renderEditor('root(a,b)');
    const firstRow = rowForInput(rendered.view.getAllByRole('textbox')[1]);

    fireEvent.click(within(firstRow).getByRole('button', { name: 'Delete subtree' }));
    expect(rendered.latest()).toBe('root(b)');
  });
});
