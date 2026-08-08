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
  it('clears undo when retargeting to a different Entry with identical SNL', () => {
    let latest = 'root(a,b,c)';
    const renderProps = (editorIdentity: string, snl: string) => (
      <GuiInductiveEditor
        editorIdentity={editorIdentity}
        snl={snl}
        macroDataDriver={driver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={(next) => { latest = next; }}
      />
    );
    const view = render(renderProps('edit:entry-a', latest));
    const input = view.getAllByRole('textbox')[2] as HTMLInputElement;
    input.focus();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.moveUp' }
    }));
    expect(latest).toBe('root(b,a,c)');
    view.rerender(renderProps('edit:entry-b', latest));
    (view.getAllByRole('textbox')[1] as HTMLInputElement).focus();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.undo' }
    }));
    expect(latest).toBe('root(b,a,c)');
  });

  it('undoes the latest Inductive tree mutation through the routed VS Code command', async () => {
    const { view, latest } = renderEditor('root(a,b,c)');
    const input = view.getAllByRole('textbox')[2] as HTMLInputElement;
    input.focus();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.moveUp' } }));
    expect(latest()).toBe('root(b,a,c)');
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.undo' }
    }));
    expect(latest()).toBe('root(a,b,c)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect((view.getAllByRole('textbox')[2] as HTMLInputElement).value).toBe('b');
  });

  it('moves the active node with a routed Alt+Arrow command and keeps its editor focused', async () => {
    const { view, latest } = renderEditor('root(a,b,c)');
    const input = view.getAllByRole('textbox')[2] as HTMLInputElement;
    input.focus();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.moveUp' } }));
    expect(latest()).toBe('root(b,a,c)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const moved = view.getAllByRole('textbox').find(
      (candidate: HTMLElement) => (candidate as HTMLInputElement).value === 'b'
    );
    expect(document.activeElement).toBe(moved);
  });

  it('extracts the selected delimited text into the next placeholder with a routed Alt+X command', () => {
    const { view, latest } = renderEditor('$#0 + b$(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLInputElement;
    input.focus();
    input.setSelectionRange(6, 7);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.extractSelection' } }));
    expect(latest()).toBe('$#0 + #1$(a,$b$)');
  });

  it('adds an empty child without carving selected text when Alt+X has no delimiter', () => {
    const { view, latest } = renderEditor('root(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLInputElement;
    input.focus();
    input.setSelectionRange(1, 3);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));

    expect(latest()).toBe('root(a,)');
    expect(input.value).toBe('root');
  });

  it('adds a parent through the routed Alt+P semantic action', () => {
    const { view, latest } = renderEditor('root(a,b)');
    const input = view.getAllByRole('textbox')[1] as HTMLInputElement;
    input.focus();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.addParent' }
    }));

    expect(latest()).toBe('root((a),b)');
  });

  it('adds a sibling through the routed Alt+S semantic action', () => {
    const { view, latest } = renderEditor('root(a,b)');
    const input = view.getAllByRole('textbox')[1] as HTMLInputElement;
    input.focus();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.addSibling' }
    }));

    expect(latest()).toBe('root(a,,b)');
  });

  it('allocates after the maximum real placeholder and ignores escaped placeholders', () => {
    const { view, latest } = renderEditor('%#0 \\#9 tail%(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLInputElement;
    input.focus();
    const start = input.value.indexOf('tail');
    input.setSelectionRange(start, start + 4);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.extractSelection' } }));
    expect(latest()).toBe('%#0 \\#9 #1%(a,%tail%)');
  });

  it('allocates a placeholder that points at the appended child when prior children have no placeholders', () => {
    const { view, latest } = renderEditor('%tail%(a,b)');
    const input = view.getAllByRole('textbox')[0] as HTMLInputElement;
    input.focus();
    input.setSelectionRange(1, 5);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));
    expect(latest()).toBe('%#2%(a,b,%tail%)');
  });

  it('preserves an authored binder and delimiter when extracting selection', () => {
    const { view, latest } = renderEditor('@$x+y$');
    const input = view.getAllByRole('textbox')[0] as HTMLInputElement;
    input.focus();
    input.setSelectionRange(4, 5);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));
    expect(latest()).toBe('@$x+#0$($y$)');
  });

  it('Tab skips a disabled Style and edits the next node instead of toolbar actions', () => {
    const { view } = renderEditor('root(a,b)');
    const first = view.getAllByRole('textbox')[1] as HTMLInputElement;
    first.focus();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.openStyle' } }));
    expect(document.activeElement).toBe(view.getAllByRole('textbox')[2]);
    expect((document.activeElement as HTMLElement).closest('.snl-tree-row-toolbar')).toBeNull();
  });

  it('routes Macro Tab to Style and Style Enter to the next visible Macro editor', async () => {
    const styledDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'a'
            ? ({ name: 'a', dynamic_arity: true, styles: [
                { style_name: 'default', mode: 'formula_inline', template: '#*', tags: [] },
                { style_name: 'compact', mode: 'formula_inline', template: '#*', tags: [] }
              ] } as never)
            : null
      }
    });
    let latest = 'root(a,b)';
    const view = render(
      <GuiInductiveEditor
        snl={latest}
        macroDataDriver={styledDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={(next) => { latest = next; }}
      />
    );
    const first = view.getAllByRole('textbox')[1] as HTMLInputElement;
    first.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.openStyle' } }));
    const style = rowForInput(first).querySelector('select') as HTMLSelectElement;
    expect(document.activeElement).toBe(style);
    style.value = 'compact';
    fireEvent.change(style);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.nextNode' } }));
    expect(document.activeElement).toBe(view.getAllByRole('textbox')[2]);
    expect(latest).toContain('a[compact]');
  });

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
      .toBe('无法上移');
    expect(within(childRow).getByRole('button', { name: '减少缩进' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '增加缩进' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '下移' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '删除子树' }).getAttribute('title'))
      .toBe('删除子树');

    fireEvent.click(within(childRow).getByRole('button', { name: '选择添加位置' }));
    const menu = within(childRow).getByRole('menu', { name: '添加节点位置' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '添加父节点',
      '添加子节点',
      '添加同级节点'
    ]);
    expect(within(menu).getByRole('menuitem', { name: '添加父节点' }).getAttribute('title'))
      .toBe('添加父节点');
  });

  it('uses a compact directional dial and keeps the Macro and delete actions', () => {
    const { view, onOpenMacroEditor } = renderEditor();
    const rootRow = rowForInput(view.getAllByRole('textbox')[0]);
    const childRow = rowForInput(view.getAllByRole('textbox')[1]);
    const dial = childRow.querySelector<HTMLElement>('.snl-tree-operation-dial');

    expect(dial).not.toBeNull();
    expect(childRow.querySelector('[data-snl-shared-tree-dashboard]')).not.toBeNull();
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
    expect(responsiveCss).toContain('@media (hover: none), (pointer: coarse)');
    expect(responsiveCss).toContain('padding-bottom: 4.9rem');
    expect(responsiveCss).toContain('padding-bottom: 0.3rem');
    expect(responsiveCss).toContain('position: static');
    expect(responsiveCss).toContain('flex: 1 0 100%');
    const styleSelect = within(childRow).getByRole('combobox') as HTMLSelectElement;
    expect(styleSelect.style.flexShrink).toBe('1');
    expect(styleSelect.style.minWidth).toBe('4rem');

    const canvasCss = readFileSync(
      'webview/src/components/TreeNodeActionDashboard.css',
      'utf8'
    );
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
    expect((within(rootRow).getByRole('menuitem', { name: 'Add sibling node' }) as HTMLButtonElement).disabled).toBe(true);
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
      'Add parent node',
      'Add child node',
      'Add sibling node'
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
    const lastChoice = within(reopened).getByRole('menuitem', { name: 'Add sibling node' });
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
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add parent node' }));
    expect(rendered.latest()).toBe('root((a),b)');

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    const rowsBeforeChild = rendered.view.container.querySelectorAll('.snl-tree-row').length;
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add child node' }));
    expect(rendered.latest()).toBe('root(a,b)');
    expect(rendered.view.container.querySelectorAll('.snl-tree-row')).toHaveLength(rowsBeforeChild + 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Choose add position');
    expect(within(firstChild).queryByRole('menu')).toBeNull();

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Choose add position' }));
    fireEvent.click(within(firstChild).getByRole('menuitem', { name: 'Add sibling node' }));
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
