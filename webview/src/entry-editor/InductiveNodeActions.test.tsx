import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
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

  it('extracts selected delimited text, then focuses and selects the new child', async () => {
    const { view, latest } = renderEditor('$#0 + b$(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(6, 7);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shortcutAction', action: 'inductive.extractSelection' } }));
    expect(latest()).toBe('$#0 + #1$(a,$b$)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const child = view.getAllByRole('textbox').find(
      (candidate) => (candidate as HTMLTextAreaElement).value === '$b$'
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(child);
    expect([child.selectionStart, child.selectionEnd]).toEqual([0, 3]);
  });

  it('extracts a plain selected range into a child and focuses its complete text', async () => {
    const { view, latest } = renderEditor('root(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    const existingIds = Array.from(view.container.querySelectorAll<HTMLElement>('[data-snl-tree-node-id]'))
      .map((row) => row.dataset.snlTreeNodeId);
    input.focus();
    input.setSelectionRange(1, 3);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));

    expect(latest()).toBe('root(a,oo)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const child = view.getAllByRole('textbox').find(
      (candidate) => (candidate as HTMLTextAreaElement).value === 'oo'
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(child);
    expect([child.selectionStart, child.selectionEnd]).toEqual([0, 2]);
    expect(existingIds).not.toContain(rowForInput(child).dataset.snlTreeNodeId);
  });

  it.each([
    ['$x$(a)', '$x$', '$x$(a,$x$)'],
    ['$$x$$(a)', '$$x$$', '$$x$$(a,$$x$$)'],
    ['%x%(a)', '%x%', '%x%(a,%x%)']
  ])('keeps the parent delimiter exactly once when Alt+X selects the whole %s surface', async (
    initial,
    childValue,
    expected
  ) => {
    const { view, latest } = renderEditor(initial);
    const input = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(0, input.value.length);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));

    expect(latest()).toBe(expected);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const child = view.getAllByRole('textbox').find(
      (candidate) => candidate !== input && (candidate as HTMLTextAreaElement).value === childValue
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(child);
    expect([child.selectionStart, child.selectionEnd]).toEqual([0, childValue.length]);
  });

  it.each([
    [0, 1],
    [2, 3]
  ])('creates an empty inline-formula child when Alt+X selects only delimiter characters (%i,%i)', async (
    start,
    end
  ) => {
    const { view, latest } = renderEditor('$x$(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(start, end);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));
    expect(latest()).toBe('$x$(a,$$)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('$$');
  });

  it('creates and focuses an empty child with the same delimiter when Alt+X selection is empty', async () => {
    const { view, latest } = renderEditor('$x$(a)');
    const input = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(2, 2);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.extractSelection' }
    }));

    expect(latest()).toBe('$x$(a,$$)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const child = view.getAllByRole('textbox').find(
      (candidate) => (candidate as HTMLTextAreaElement).value === '$$'
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(child);
    expect([child.selectionStart, child.selectionEnd]).toEqual([0, 2]);
  });

  it('adds a parent through Alt+P, focuses it, and selects its complete text', async () => {
    const { view, latest } = renderEditor('root(a,b)');
    const input = view.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    const originalId = rowForInput(input).dataset.snlTreeNodeId;
    input.focus();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.addParent' }
    }));

    expect(latest()).toBe('root((a),b)');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const parent = document.activeElement as HTMLTextAreaElement;
    expect(parent).not.toBe(input);
    expect(parent.matches('[data-snl-macro-input]')).toBe(true);
    expect(parent.value).toBe('');
    expect([parent.selectionStart, parent.selectionEnd]).toEqual([0, 0]);
    expect(rowForInput(parent).dataset.snlTreeNodeId).not.toBe(originalId);
    const wrapped = view.getAllByRole('textbox').find(
      (candidate) => (candidate as HTMLTextAreaElement).value === 'a'
    ) as HTMLTextAreaElement;
    expect(rowForInput(wrapped).dataset.snlTreeNodeId).toBe(originalId);
  });

  it('wraps the root with a fresh parent identity and focuses that parent', async () => {
    const { view, latest } = renderEditor('root(a)');
    const root = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    const rootId = rowForInput(root).dataset.snlTreeNodeId;
    root.focus();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.addParent' }
    }));
    expect(latest()).toBe('(root(a))');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const parent = document.activeElement as HTMLTextAreaElement;
    expect(parent.value).toBe('');
    expect(rowForInput(parent).dataset.snlTreeNodeId).not.toBe(rootId);
    const wrappedRoot = view.getAllByRole('textbox').find(
      (candidate) => (candidate as HTMLTextAreaElement).value === 'root'
    ) as HTMLTextAreaElement;
    expect(rowForInput(wrappedRoot).dataset.snlTreeNodeId).toBe(rootId);
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

  it('makes Tab and Shift+Tab exact inverses across only alternative Style fields', async () => {
    const styledDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) => ({
          name: macro_name,
          dynamic_arity: true,
          styles: macro_name === 'a'
            ? [
                { style_name: 'default', template: { mode: 'formula_inline', body: '#*' }, tags: [] },
                { style_name: 'compact', template: { mode: 'formula_inline', body: '#*' }, tags: [] }
              ]
            : macro_name === 'b'
              ? [{ style_name: 'default', template: { mode: 'formula_inline', body: '#*' }, tags: [] }]
              : []
        } as never)
      }
    });
    const view = render(
      <GuiInductiveEditor
        snl="root(a,b,c)"
        macroDataDriver={styledDriver}
        macroCandidates={['a', 'b', 'c'].map((id) => ({ id, labels: [] }))}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );
    const inputByValue = (value: string): HTMLTextAreaElement => view.getAllByRole('textbox').find(
      (candidate) => (candidate as HTMLTextAreaElement).value === value
    ) as HTMLTextAreaElement;
    const a = inputByValue('a');
    const b = inputByValue('b');
    const c = inputByValue('c');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const styleA = rowForInput(a).querySelector('.snl-tree-style-select') as HTMLSelectElement;

    a.focus();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.openStyle' }
    }));
    expect(document.activeElement).toBe(styleA);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.openStyle' }
    }));
    expect(document.activeElement).toBe(b);
    expect([b.selectionStart, b.selectionEnd]).toEqual([0, 1]);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.openStyle' }
    }));
    expect(document.activeElement).toBe(c);
    expect([c.selectionStart, c.selectionEnd]).toEqual([0, 1]);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.previousField' }
    }));
    expect(document.activeElement).toBe(b);
    expect([b.selectionStart, b.selectionEnd]).toEqual([0, 1]);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.previousField' }
    }));
    expect(document.activeElement).toBe(styleA);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.previousField' }
    }));
    expect(document.activeElement).toBe(a);
    expect([a.selectionStart, a.selectionEnd]).toEqual([0, 1]);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
  });

  it('preserves the middle caret when a legacy inline context is split into its own field', () => {
    const { view, latest } = renderEditor('foo@entry');
    const input = view.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(2, 2);

    fireEvent.input(input, {
      target: { value: 'foXo@entry', selectionStart: 3, selectionEnd: 3 }
    });

    expect(view.getAllByRole('textbox')[0]).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('foXo');
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe(3);
    expect(latest()).toBe('foXo@entry');
  });

  it('uses an auto-sized multiline Macro editor and keeps Shift+Enter in the current row', () => {
    const { view, latest } = renderEditor('root(%first line%,b)');
    const editor = view.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    const next = view.getAllByRole('textbox')[2] as HTMLTextAreaElement;

    expect(editor.tagName).toBe('TEXTAREA');
    expect(editor.closest<HTMLElement>('[data-macro-id-control]')?.style.flex).toBe('1 1 auto');
    editor.focus();
    expect(fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(editor);

    fireEvent.change(editor, { target: { value: '%first line\nsecond line%' } });
    expect(latest()).toBe('root(%first line\nsecond line%,b)');
    expect(editor.rows).toBe(2);
    expect(document.activeElement).not.toBe(next);
  });

  it('commits the first native Style input before an ancestor dirty render can restore the old value', async () => {
    const styledDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => macro_name === 'a'
        ? ({ name: 'a', dynamic_arity: true, styles: [
            { style_name: 'default', template: { mode: 'formula_inline', body: '#*' }, tags: [] },
            { style_name: 'compact', template: { mode: 'formula_inline', body: '#*' }, tags: [] }
          ] } as never)
        : null
    } });
    let latest = 'root(a)';
    function Harness(): React.ReactElement {
      const [dirty, setDirty] = useState(false);
      return <div data-dirty={String(dirty)} onInputCapture={() => setDirty(true)}>
        <GuiInductiveEditor snl={latest} macroDataDriver={styledDriver}
          macroCandidates={[]} macroOrigin={{}} onOpenMacroEditor={() => undefined}
          onChange={(next) => { latest = next; }} />
      </div>;
    }
    const view = render(<Harness />);
    const style = await waitFor(() => {
      const candidate = rowForInput(view.getAllByRole('textbox')[1])
        .querySelector<HTMLSelectElement>('.snl-tree-style-select');
      expect(candidate?.disabled).toBe(false);
      return candidate!;
    });

    fireEvent.input(style, { target: { value: 'compact' } });
    fireEvent.change(style);

    expect(style.value).toBe('compact');
    expect(latest).toBe('root(a[compact])');
  });

  it('routes Macro Tab to Style and Style Enter to the next visible Macro editor', async () => {
    const styledDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'a'
            ? ({ name: 'a', dynamic_arity: true, styles: [
                { style_name: 'default',  template: { mode: 'formula_inline', body: '#*' }, tags: [] },
                { style_name: 'compact',  template: { mode: 'formula_inline', body: '#*' }, tags: [] }
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

  it('routes Shift+Tab as the exact reverse of Macro to Style to next Macro', async () => {
    const styledDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) =>
          macro_name === 'a'
            ? ({ name: 'a', dynamic_arity: true, styles: [
                { style_name: 'default', template: { mode: 'formula_inline', body: '#*' }, tags: [] },
                { style_name: 'compact', template: { mode: 'formula_inline', body: '#*' }, tags: [] }
              ] } as never)
            : null
      }
    });
    const view = render(
      <GuiInductiveEditor
        snl="root(a,b)"
        macroDataDriver={styledDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );
    const macroA = view.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    const macroB = view.getAllByRole('textbox')[2] as HTMLTextAreaElement;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const styleA = rowForInput(macroA).querySelector('select') as HTMLSelectElement;

    macroB.focus();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.previousField' }
    }));
    expect(document.activeElement).toBe(styleA);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.previousField' }
    }));
    expect(document.activeElement).toBe(macroA);
  });

  it('reverses across disabled Styles and skips collapsed descendants', () => {
    const { view } = renderEditor('root(a,b(c),d)');
    const inputByValue = (value: string): HTMLTextAreaElement => {
      const input = view.getAllByRole('textbox').find(
        (candidate) => (candidate as HTMLTextAreaElement).value === value
      ) as HTMLTextAreaElement | undefined;
      if (!input) throw new Error(`Missing Inductive editor for ${value}`);
      return input;
    };
    const macroB = inputByValue('b');
    fireEvent.click(within(rowForInput(macroB)).getByLabelText('Collapse'));
    expect(view.queryByDisplayValue('c')).toBeNull();

    const macroD = inputByValue('d');
    macroD.focus();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.previousField' }
    }));

    expect(document.activeElement).toBe(macroB);
    expect(rowForInput(macroB).querySelector<HTMLSelectElement>('.snl-tree-style-select')?.disabled)
      .toBe(true);
  });

  it('explains that formula delimiters inside percent text stay literal', () => {
    const { view } = renderEditor('%$\\texcommand$ is text%');
    expect(view.getByText(/Inside %…%, \$…\$ stays literal text/)).toBeTruthy();
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

    expect(within(childRow).getByRole('button', { name: '添加父节点' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '添加同级节点' })).toBeTruthy();
    expect(within(childRow).getByRole('button', { name: '添加子节点' })).toBeTruthy();
    expect(within(childRow).queryByRole('menu')).toBeNull();
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
        rule.selectorText.includes('.snl-tree-row:hover > .snl-tree-row-toolbar')
      ) as CSSStyleRule | undefined;
    expect(toolbarRevealRule?.style.pointerEvents).toBe('auto');
    const hoverRule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .find((rule) =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.includes('.snl-tree-row:hover') &&
        rule.style.paddingRight !== ''
      ) as CSSStyleRule | undefined;
    expect(hoverRule?.style.paddingRight).toBe('5.1rem');
    const responsiveCss = Array.from(view.container.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(responsiveCss).toContain('@container snl-inductive (max-width: 30rem)');
    expect(responsiveCss).toContain('@media (hover: none), (pointer: coarse)');
    expect(responsiveCss).toContain('padding-bottom: 4.9rem');
    expect(responsiveCss).not.toContain('.snl-tree-row:focus-within .snl-tree-row-toolbar');
    expect(responsiveCss).not.toContain('.snl-tree-row:focus-within {');
    expect(responsiveCss).toContain('.snl-tree-row:has(> .snl-tree-row-toolbar:focus-within)');
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
    expect(Number.isFinite(compactWidth)).toBe(true);
    expect(compactWidth).toBeGreaterThanOrEqual(1.5);
    const authoredToolbarWidth = 3 * compactWidth;
    const visibleRowReserve = parseFloat(hoverRule!.style.paddingRight);
    const toolbarRight = parseFloat(getComputedStyle(toolbar).right);
    expect(visibleRowReserve - toolbarRight - authoredToolbarWidth).toBeGreaterThanOrEqual(0.25);
    for (const [label, icon] of [
      ['Move up', 'move-up'],
      ['Move down', 'move-down'],
      ['Outdent', 'outdent'],
      ['Indent', 'indent'],
      ['Add parent node', 'add-parent'],
      ['Add sibling node', 'add-sibling'],
      ['Add child node', 'add-child'],
      ['Delete subtree', 'delete']
    ] as const) {
      const action = within(dial!).getByRole('button', { name: label });
      expect(action.querySelector(`svg[data-snl-icon="${icon}"]`)).toBeTruthy();
      expect(action.classList.contains('snl-btn--icon')).toBe(true);
    }
    expect(childRow.querySelector('.snl-tree-delete-action')).not.toBeNull();
    expect(within(childRow).getByRole('button', { name: 'Delete subtree' })).toBeTruthy();
    expect(childRow.querySelector('.snl-tree-row-toolbar')?.textContent).not.toContain('+ child');
    expect(childRow.querySelector('.snl-tree-row-toolbar')?.textContent).not.toContain('+ parent');
    expect((within(rootRow).getByRole('button', { name: 'Delete subtree' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rootRow).getByRole('button', { name: 'Add sibling node' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(rootRow).getByRole('button', { name: 'Edit macro' }));
    expect(onOpenMacroEditor).toHaveBeenCalledWith({
      name: 'root',
      env_mode: undefined,
      style_name: undefined
    });
  });

  it('places Macro edit/create in the lower-left cell and never opens an add menu', () => {
    const known = renderEditor();
    const knownRow = rowForInput(known.view.getAllByRole('textbox')[0]);
    const edit = within(knownRow).getByRole('button', { name: 'Edit macro' });
    expect(edit.closest('[data-snl-dashboard-bottom-left]')).toBeTruthy();
    expect(edit.querySelector('svg[data-snl-icon="edit"]')).toBeTruthy();
    expect(edit.getAttribute('style')).toContain('--vscode-textLink-foreground');
    expect(within(knownRow).queryByRole('menu')).toBeNull();

    cleanup();
    const missing = renderEditor('unknown');
    const missingRow = rowForInput(missing.view.getAllByRole('textbox')[0]);
    const create = within(missingRow).getByRole('button', { name: 'Create macro' });
    expect(create.closest('[data-snl-dashboard-bottom-left]')).toBeTruthy();
    expect(create.querySelector('svg[data-snl-icon="add"]')).toBeTruthy();
    expect(create.getAttribute('style')).toContain('--vscode-testing-iconPassed');
  });

  it('dispatches parent, child, and sibling additions without changing their tree semantics', async () => {
    let rendered = renderEditor('root(a,b)');
    let firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Add parent node' }));
    expect(rendered.latest()).toBe('root((a),b)');

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    const rowsBeforeChild = rendered.view.container.querySelectorAll('.snl-tree-row').length;
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Add child node' }));
    expect(rendered.latest()).toBe('root(a,b)');
    expect(rendered.view.container.querySelectorAll('.snl-tree-row')).toHaveLength(rowsBeforeChild + 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Add child node');

    cleanup();
    rendered = renderEditor('root(a,b)');
    firstChild = rowForInput(rendered.view.getAllByRole('textbox')[1]);
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Add sibling node' }));
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
