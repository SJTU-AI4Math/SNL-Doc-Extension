import React from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MacroDataDriver, createSnlSyntaxTreeNode } from '@sjtu-ai4math/snl-basics';
import {
  GuiInductiveEditor,
  isSemanticallyBlankInductiveNode,
  useQueriedMacro,
  withArityAtPath,
  withContextEntryId
} from '../CreateEntryApp';

const postMessage = vi.fn();
(globalThis as { __snlApi?: { postMessage: (message: unknown) => void } }).__snlApi = {
  postMessage
};

afterEach(() => {
  cleanup();
  postMessage.mockClear();
  document.documentElement.lang = 'en';
});

const macro = (name: string, dynamic: boolean, template: string): never => ({
  name,
  description: '',
  source: { entries: [], urls: [] },
  tags: [],
  dynamic_arity: dynamic,
  styles: [{
    style_name: 'default',
    template: { mode: 'formula_inline', body: template },
    tags: []
  }]
} as never);

const driver = new MacroDataDriver({
  queries: {
    query_macro: async ({ macro_name }: { macro_name: string }) => {
      if (macro_name === 'pair') return macro('pair', false, '#0 + #1');
      if (macro_name === 'triple') return macro('triple', false, '#0 #1 #2');
      if (macro_name === 'neg') return macro('neg', false, '-#0');
      // Variadic but with a leading fixed slot, so ignoring dynamic_arity
      // would wrongly open a row.
      if (macro_name === 'list') return macro('list', true, '#0: #*');
      if (macro_name === 'spread2') return macro('spread2', true, '#0 #1 #*');
      if (macro_name === 'atom') return macro('atom', false, 'A');
      if (macro_name === 'top') return macro('top', false, '#0 , #1');
      if (macro_name === 'top3') return macro('top3', false, '#0 #1 #2');
      if (macro_name === 'styled') {
        return {
          name: 'styled',
          description: '',
          source: { entries: [], urls: [] },
          tags: [],
          dynamic_arity: false,
          styles: [
            { style_name: 'default',  template: { mode: 'formula_inline', body: 'S' }, tags: [] },
            { style_name: 'compact',  template: { mode: 'formula_inline', body: 's' }, tags: [] }
          ]
        } as never;
      }
      return null;
    }
  }
});

function renderEditor(
  initial: string,
  entryCandidates: Array<{ id: string; title: string; hasContent: boolean }> = []
): { view: ReturnType<typeof render>; latest: () => string } {
  let latest = initial;
  const view = render(
    <GuiInductiveEditor
      snl={initial}
      entryCandidates={entryCandidates}
      macroDataDriver={driver}
      macroCandidates={[{ id: 'pair', labels: [] }]}
      macroOrigin={{}}
      onOpenMacroEditor={() => undefined}
      onChange={(next) => { latest = next; }}
    />
  );
  return { view, latest: () => latest };
}

describe('Inductive editor arity auto-fill', () => {
  it('does not expose the previous Macro result during the first render of a new name', async () => {
    const keyedDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'known' ? macro('known', true, 'K') : null
    }});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const Probe = ({ name }: { name: string }): React.ReactElement => {
      const result = useQueriedMacro(keyedDriver, name);
      return <output>{result?.name ?? 'none'}</output>;
    };

    flushSync(() => root.render(<Probe name="known" />));
    await waitFor(() => expect(host.textContent).toBe('known'));
    flushSync(() => root.render(<Probe name="missing" />));
    expect(host.textContent).toBe('none');
    flushSync(() => root.unmount());
    host.remove();
  });

  it('classifies a delimited temporary Macro as fvar without querying its internal placeholder', async () => {
    const queried: string[] = [];
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        queried.push(macro_name);
        return macro_name === '#'
          ? Object.assign({}, macro('#', false, 'registered hash'), { kind: 'const' })
          : null;
      }
    }});
    const common = {
      macroDataDriver: kindDriver,
      macroCandidates: [],
      macroOrigin: {},
      kindPalette: {
        fvar: { stroke: '#ff0000', background: '#440000' },
        const: { stroke: '#0000ff', background: '#000044' }
      },
      onOpenMacroEditor: () => undefined,
      onChange: () => undefined
    };
    const view = render(<GuiInductiveEditor {...common} snl="$ghost$" />);

    const input = view.getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect(input.title).toContain('fvar'));
    expect(input.value).toBe('$ghost$');
    expect(input.style.borderColor).toBe('rgb(255, 0, 0)');
    expect(input.closest<HTMLElement>('.snl-tree-row')!.style.background)
      .toBe('rgba(68, 0, 0, 0.18)');
    expect(queried).not.toContain('#');

    view.rerender(<GuiInductiveEditor {...common} snl="$warm$" />);
    await waitFor(() => expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('$warm$'));
    expect(queried).not.toContain('#');
  });

  it('preserves authored binder priority for a delimited temporary Macro', async () => {
    const queried: string[] = [];
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        queried.push(macro_name);
        return null;
      }
    }});
    const view = render(
      <GuiInductiveEditor
        snl="root(@$x$,$x$)"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        kindPalette={{
          fvar: { stroke: '#ff0000', background: '#440000' },
          binder: { stroke: '#8800ff', background: '#220044' },
          bvar: { stroke: '#00aa00', background: '#004400' }
        }}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const inputs = view.getAllByRole('textbox') as HTMLInputElement[];
    await waitFor(() => expect(inputs[1].title).toContain('binder'));
    expect(inputs[1].style.borderColor).toBe('rgb(136, 0, 255)');
    expect(inputs[2].title).toContain('fvar');
    expect(inputs[2].style.borderColor).toBe('rgb(255, 0, 0)');
    expect(queried).not.toContain('#');
  });

  it('still queries a registered bare Macro', async () => {
    const queried: string[] = [];
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        queried.push(macro_name);
        return macro_name === 'registered'
          ? Object.assign({}, macro('registered', false, 'R'), { kind: 'const' })
          : null;
      }
    }});
    const view = render(
      <GuiInductiveEditor
        snl="registered"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        kindPalette={{
          fvar: { stroke: '#ff0000', background: '#440000' },
          const: { stroke: '#0000ff', background: '#000044' }
        }}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const input = view.getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect(input.title).toContain('const'));
    expect(queried).toContain('registered');
    expect(input.style.borderColor).toBe('rgb(0, 0, 255)');
  });

  it('uses the queried Macro Kind and the editor Macro Kind palette for row coloring', async () => {
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'colored'
          ? Object.assign({}, macro('colored', false, 'C'), { kind: 'custom-kind' })
          : null
    }});
    const view = render(
      <GuiInductiveEditor
        snl="colored"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        kindPalette={{
          'custom-kind': { stroke: '#123456', background: '#abcdef' }
        }}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const input = view.getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect(input.title).toContain('custom-kind'));
    expect(input.style.borderColor).toBe('rgb(18, 52, 86)');
    const control = input.closest<HTMLElement>('[data-macro-id-control="true"]')!;
    expect(control.style.background).toBe('rgba(171, 205, 239, 0.18)');
  });

  it('does not misrepresent a resolved Macro whose Kind is absent from the palette as fvar', async () => {
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'colored'
          ? Object.assign({}, macro('colored', false, 'C'), { kind: 'missing-kind' })
          : null
    }});
    const view = render(
      <GuiInductiveEditor
        snl="colored"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        kindPalette={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const input = view.getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect(input.title).toContain('missing-kind'));
    expect(input.getAttribute('style'))
      .toContain('border-color: var(--vscode-input-border, var(--vscode-contrastBorder, #555))');
    const row = input.closest<HTMLElement>('.snl-tree-row')!;
    expect(row.getAttribute('style'))
      .toContain('border-color: var(--vscode-input-border, var(--vscode-contrastBorder, #555))');
  });

  it('resolves the themed SNL-Basics palette before painting a built-in Macro Kind', async () => {
    document.documentElement.dataset.snlColorScheme = 'dark';
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'constant'
          ? Object.assign({}, macro('constant', false, 'C'), { kind: 'const' })
          : null
    }});
    const view = render(
      <GuiInductiveEditor
        snl="constant"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const input = view.getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect(input.title).toContain('const'));
    expect(input.style.borderColor).toBe('rgb(0, 91, 156)');
    const row = input.closest<HTMLElement>('.snl-tree-row')!;
    expect(row.style.borderColor).toBe('rgb(0, 91, 156)');
    expect(row.style.background).toBe('rgba(218, 240, 255, 0.18)');
    delete document.documentElement.dataset.snlColorScheme;
  });

  it('preserves the built-in sub Kind transparent surface and one-pixel frame geometry', async () => {
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'subtree'
          ? Object.assign({}, macro('subtree', false, 'S'), { kind: 'sub' })
          : null
    }});
    const view = render(
      <GuiInductiveEditor
        snl="subtree"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const input = view.getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect(input.title).toContain('sub'));
    const row = input.closest<HTMLElement>('.snl-tree-row')!;
    expect(row.style.borderWidth).toBe('1px');
    expect(row.style.borderStyle).toBe('solid');
    expect(row.style.borderColor).toBe('inherit');
    expect(row.style.background).toBe('transparent');
  });

  it('propagates the Macro Kind palette to recursively rendered child rows', async () => {
    const kindDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) => {
        if (macro_name === 'container') return macro('container', false, '#0');
        if (macro_name === 'colored') {
          return Object.assign({}, macro('colored', false, 'C'), { kind: 'custom-kind' });
        }
        return null;
      }
    }});
    const view = render(
      <GuiInductiveEditor
        snl="container(colored)"
        macroDataDriver={kindDriver}
        macroCandidates={[]}
        macroOrigin={{}}
        kindPalette={{
          'custom-kind': { stroke: '#123456', background: '#abcdef' }
        }}
        onOpenMacroEditor={() => undefined}
        onChange={() => undefined}
      />
    );

    const inputs = view.getAllByRole('textbox') as HTMLInputElement[];
    const child = inputs[1];
    await waitFor(() => expect(child.title).toContain('custom-kind'));
    expect(child.style.borderColor).toBe('rgb(18, 52, 86)');
    expect(child.closest<HTMLElement>('[data-macro-id-control="true"]')!.style.background)
      .toBe('rgba(171, 205, 239, 0.18)');
  });

  it('localizes Inductive inputs, Style states, helper copy, and parse errors in Simplified Chinese', async () => {
    document.documentElement.lang = 'zh-CN';
    const localized = renderEditor('styled@missing-entry', [
      { id: 'entry-a', title: 'Entry A', hasContent: true }
    ]);
    expect(await localized.view.findByRole('combobox', { name: '上下文条目 ID' })).toBeTruthy();
    expect(localized.view.getByPlaceholderText('条目 ID')).toBeTruthy();
    expect(localized.view.getByRole('combobox', { name: 'styled 的宏样式' }).getAttribute('title'))
      .toBe('默认样式（隐式）：[default]');
    expect(localized.view.getByText('当前条目池中没有此 ID 对应的条目。')).toBeTruthy();

    cleanup();
    const invalid = renderEditor('root(');
    expect(invalid.view.getByText(/文本模式 SNL 无法解析/).textContent)
      .toContain('当前树反映上次成功解析的结果');
  });

  it('updates or clears mdata.src without dropping consumer-owned metadata', () => {
    const node = createSnlSyntaxTreeNode('styled');
    node.mdata = { src: 'entry-a', consumerFlag: { keep: true } };
    expect(withContextEntryId(node, 'entry-b')).toEqual({
      src: 'entry-b',
      consumerFlag: { keep: true }
    });
    expect(withContextEntryId(node, '')).toEqual({
      consumerFlag: { keep: true }
    });
  });

  it('keeps Macro identity and Style in separate input channels', async () => {
    const { view, latest } = renderEditor('styled');
    const macroInput = view.getAllByRole('textbox')[0] as HTMLInputElement;
    expect(macroInput.value).toBe('styled');
    expect(macroInput.value).not.toContain('[');
    fireEvent.change(macroInput, { target: { value: 'styled[compact]' } });
    expect(latest()).toBe('styled');
    expect(macroInput.value).toBe('styled');

    const style = await waitFor(() =>
      view.getByRole('combobox', { name: 'Macro style for styled' }) as HTMLSelectElement
    );
    expect(style.value).toBe('default');
    expect(Array.from(style.options).map((option) => [option.value, option.textContent])).toEqual([
      ['default', 'default ★'],
      ['compact', 'compact']
    ]);
    expect(style.style.color).toBe('var(--vscode-descriptionForeground, #999)');
    fireEvent.change(style, { target: { value: 'compact' } });
    expect(latest()).toBe('styled[compact]');
    expect(macroInput.value).toBe('styled');
    expect(style.style.color).toBe('var(--vscode-dropdown-foreground, var(--vscode-input-foreground, #ddd))');
    fireEvent.change(style, { target: { value: 'default' } });
    expect(latest()).toBe('styled');
  });

  it('shows an existing @ context as an independent Entry ID input', async () => {
    const { view, latest } = renderEditor('styled@entry-a', [
      { id: 'entry-a', title: 'Entry A', hasContent: true },
      { id: 'entry-b', title: 'Entry B', hasContent: true }
    ]);
    const macroInput = view.getAllByRole('textbox')[0] as HTMLInputElement;
    expect(macroInput.value).toBe('styled');
    const row = macroInput.closest<HTMLElement>('.snl-tree-row')!;
    const macroControl = row.querySelector<HTMLElement>('[data-macro-id-control="true"]')!;
    expect(macroControl.style.minWidth).toBe('0px');
    const responsiveCss = Array.from(view.container.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(responsiveCss).toContain('flex-wrap: wrap');
    expect(responsiveCss).toContain('.snl-tree-context-entry-control');

    const contextInput = await waitFor(() =>
      view.getByRole('combobox', { name: 'Context Entry ID' }) as HTMLInputElement
    );
    expect(contextInput.value).toBe('entry-a');
    expect(document.activeElement).not.toBe(contextInput);
    fireEvent.focus(contextInput);
    expect(view.getByRole('option', { name: /Entry A/ })).toBeTruthy();

    fireEvent.change(contextInput, { target: { value: 'entry' } });
    fireEvent.keyDown(contextInput, { key: 'ArrowDown' });
    fireEvent.keyDown(contextInput, { key: 'Enter' });
    expect(contextInput.value).toBe('entry-b');
    expect(latest()).toBe('styled@entry-b');

    fireEvent.change(contextInput, { target: { value: 'entry' } });
    fireEvent.mouseDown(view.getByRole('option', { name: /Entry A/ }));
    expect(contextInput.value).toBe('entry-a');
    expect(latest()).toBe('styled@entry-a');

    fireEvent.change(contextInput, { target: { value: 'missing-entry' } });
    expect(contextInput.getAttribute('aria-invalid')).toBe('true');
    expect(view.getByText('No entry with this id in the current pool.')).toBeTruthy();
    fireEvent.change(contextInput, { target: { value: 'entry-b' } });
    const style = await waitFor(() =>
      view.getByRole('combobox', { name: 'Macro style for styled' }) as HTMLSelectElement
    );
    fireEvent.change(style, { target: { value: 'compact' } });
    expect(latest()).toBe('styled@entry-b[compact]');
  });

  it('preserves delimited Macro, context, Style, children, and recursive context ordering', async () => {
    const { view, latest } = renderEditor(
      'root($x$@entry-a[compact](child@entry-b))',
      [
        { id: 'entry-a', title: 'Entry A', hasContent: true },
        { id: 'entry-b', title: 'Entry B', hasContent: true }
      ]
    );
    await waitFor(() =>
      expect(view.getAllByRole('combobox', { name: 'Context Entry ID' })).toHaveLength(2)
    );
    const macroInputs = view.getAllByRole('textbox') as HTMLInputElement[];
    expect(macroInputs.map((input) => input.value)).toEqual(['root', '$x$', 'child']);

    const contexts = view.getAllByRole('combobox', {
      name: 'Context Entry ID'
    }) as HTMLInputElement[];
    expect(contexts.map((input) => input.value)).toEqual(['entry-a', 'entry-b']);
    fireEvent.change(contexts[1], { target: { value: 'entry-a' } });
    expect(latest()).toBe('root($x$@entry-a[compact](child@entry-a))');
  });

  it('distinguishes authored binder @ from annotate-bind occurrences during edits', async () => {
    let rendered = renderEditor('root(@$x$,$x$)');
    await waitFor(() => expect(rendered.view.getAllByRole('textbox')).toHaveLength(3));
    let macroInputs = rendered.view.getAllByRole('textbox') as HTMLInputElement[];
    expect(macroInputs.map((input) => input.value)).toEqual(['root', '@$x$', '$x$']);

    cleanup();
    rendered = renderEditor('@$x$');
    macroInputs = rendered.view.getAllByRole('textbox') as HTMLInputElement[];
    fireEvent.change(macroInputs[0], { target: { value: '$x$' } });
    expect(macroInputs[0].value).toBe('$x$');
    expect(rendered.latest()).toBe('$x$');
  });

  it('closes the Context Entry input when external SNL removes the suffix', async () => {
    const common = {
      entryCandidates: [{ id: 'entry-a', title: 'Entry A', hasContent: true }],
      macroDataDriver: driver,
      macroCandidates: [{ id: 'styled', labels: [] }],
      macroOrigin: {},
      onOpenMacroEditor: () => undefined,
      onChange: () => undefined
    };
    const view = render(<GuiInductiveEditor {...common} snl="styled@entry-a" />);
    await waitFor(() =>
      expect(view.getByRole('combobox', { name: 'Context Entry ID' })).toBeTruthy()
    );
    view.rerender(<GuiInductiveEditor {...common} snl="styled" />);
    await waitFor(() =>
      expect(view.queryByRole('combobox', { name: 'Context Entry ID' })).toBeNull()
    );
  });

  it('opens the Entry ID input on a suffix @ and drops it when blank editing ends', async () => {
    const { view, latest } = renderEditor('styled', [
      { id: 'entry-a', title: 'Entry A', hasContent: true }
    ]);
    const macroInput = view.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(macroInput, { target: { value: 'styled@' } });
    expect(macroInput.value).toBe('styled');

    const contextInput = await waitFor(() =>
      view.getByRole('combobox', { name: 'Context Entry ID' }) as HTMLInputElement
    );
    expect(contextInput.value).toBe('');
    expect(document.activeElement).toBe(contextInput);
    expect(latest()).toBe('styled');

    fireEvent.change(contextInput, { target: { value: 'entry-a' } });
    expect(latest()).toBe('styled@entry-a');
    fireEvent.change(contextInput, { target: { value: '' } });
    expect(latest()).toBe('styled');
    const style = view.getByRole('combobox', { name: 'Macro style for styled' });
    fireEvent.blur(contextInput, { relatedTarget: style });
    expect(view.queryByRole('combobox', { name: 'Context Entry ID' })).toBeNull();

    fireEvent.change(macroInput, { target: { value: 'styled@' } });
    const emptyContext = await waitFor(() =>
      view.getByRole('combobox', { name: 'Context Entry ID' }) as HTMLInputElement
    );
    fireEvent.keyDown(emptyContext, { key: 'Enter' });
    expect(latest()).toBe('styled');
    expect(view.queryByRole('combobox', { name: 'Context Entry ID' })).toBeNull();

    fireEvent.change(macroInput, { target: { value: '@styled' } });
    expect(latest()).toBe('@styled');
    expect(view.queryByRole('combobox', { name: 'Context Entry ID' })).toBeNull();

    fireEvent.change(macroInput, { target: { value: '%mail@host%' } });
    expect(latest()).toBe('%mail@host%');
    expect(view.queryByRole('combobox', { name: 'Context Entry ID' })).toBeNull();
    fireEvent.change(macroInput, { target: { value: '$x@y$' } });
    expect(latest()).toBe('$x@y$');
    expect(view.queryByRole('combobox', { name: 'Context Entry ID' })).toBeNull();

    fireEvent.change(macroInput, { target: { value: '%mail@host%@entry-a' } });
    expect(macroInput.value).toBe('%mail@host%');
    expect(latest()).toBe('%mail@host%@entry-a');
    expect(
      (view.getByRole('combobox', { name: 'Context Entry ID' }) as HTMLInputElement).value
    ).toBe('entry-a');
  });

  it('covers default, missing, and unavailable Style presentation states', async () => {
    let rendered = renderEditor('styled[default]');
    let style = await waitFor(() =>
      rendered.view.getByRole('combobox', { name: 'Macro style for styled' }) as HTMLSelectElement
    );
    expect(style.value).toBe('default');
    expect(style.options[0]?.textContent).toBe('default ★');
    expect(style.style.color).toBe('var(--vscode-descriptionForeground, #999)');

    cleanup();
    rendered = renderEditor('styled[legacy]');
    style = await waitFor(() =>
      rendered.view.getByRole('combobox', { name: 'Macro style for styled' }) as HTMLSelectElement
    );
    expect(Array.from(style.options).map((option) => option.textContent)).toEqual([
      'legacy (missing)',
      'default ★',
      'compact'
    ]);
    expect(style.style.color).toBe('var(--vscode-dropdown-foreground, var(--vscode-input-foreground, #ddd))');
    fireEvent.change(style, { target: { value: 'default' } });
    expect(rendered.latest()).toBe('styled');

    cleanup();
    rendered = renderEditor('atom');
    style = await waitFor(() =>
      rendered.view.getByRole('combobox', { name: 'Macro style for atom' }) as HTMLSelectElement
    );
    expect(style.disabled).toBe(false);
    expect(style.value).toBe('default');
    expect(style.style.color).toBe('var(--vscode-descriptionForeground, #999)');

    cleanup();
    rendered = renderEditor('x');
    style = rendered.view.getByRole('combobox', { name: 'Macro style for x' }) as HTMLSelectElement;
    expect(style.disabled).toBe(true);
    expect(style.style.opacity).toBe('0.35');
  });

  it('can clear a missing legacy Style through the independent dropdown', async () => {
    const { view, latest } = renderEditor('gone[legacy]');
    const style = await waitFor(() =>
      view.getByRole('combobox', { name: 'Macro style for gone' }) as HTMLSelectElement
    );
    expect(style.disabled).toBe(false);
    expect(Array.from(style.options).map((option) => option.value)).toContain('');
    fireEvent.change(style, { target: { value: '' } });
    expect(latest()).toBe('gone');
  });

  it('opens child rows once a fixed-arity Macro is matched', async () => {
    let latest = '';
    const view = render(
      <GuiInductiveEditor
        snl="x"
        macroDataDriver={driver}
        macroCandidates={[{ id: 'pair', labels: [] }]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={(next) => { latest = next; }}
      />
    );
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });

    await waitFor(() => expect(latest).toBe('pair(,)'), { timeout: 2000 });
  });

  it('resolves fixed arity after a temporary child row is named', async () => {
    const { view, latest } = renderEditor('root');
    const rootRow = view.getAllByRole('textbox')[0].closest<HTMLElement>('.snl-tree-row')!;
    fireEvent.click(within(rootRow).getByRole('button', { name: 'Add child node' }));

    const temporary = view.getAllByRole('textbox')[1] as HTMLInputElement;
    expect(temporary.value).toBe('');
    fireEvent.change(temporary, { target: { value: 'pair' } });

    await waitFor(() => expect(latest()).toBe('root(pair(,))'), { timeout: 2000 });
  });

  it('opens the right number of rows for a three-argument Macro', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'triple' } });
    await waitFor(() => expect(latest()).toBe('triple(,,)'), { timeout: 2000 });
  });

  it('opens a row for a one-argument Macro', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'neg' } });
    // A lone empty slot is pruned on serialize (it has no surface form), so
    // the SNL stays `neg` — but the editor row must still be there to type in.
    await waitFor(() => expect(view.getAllByRole('textbox').length).toBeGreaterThan(1), { timeout: 2000 });
    expect(latest()).toBe('neg');
  });

  it('opens one empty child row when a dynamic-arity constant Macro is matched', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    const before = view.getAllByRole('textbox').length;
    fireEvent.change(box, { target: { value: 'list' } });
    await waitFor(() => expect(view.getAllByRole('textbox').length).toBe(before + 1));
    // A lone empty slot has no stable SNL surface form, so it remains editor
    // state until the author fills it or adds a second argument.
    expect(latest()).toBe('list');
  });

  it('honors the positional prefix of a dynamic Macro before its variadic tail', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'spread2' } });
    await waitFor(() => expect(latest()).toBe('spread2(,)'));
    expect(view.getAllByRole('textbox')).toHaveLength(3);
  });

  it('reconciles again when returning from a dynamic Macro to the same fixed Macro', async () => {
    const { view, latest } = renderEditor('atom');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);

    fireEvent.change(box, { target: { value: 'list' } });
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(2));

    fireEvent.change(box, { target: { value: 'atom' } });
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(1));
    expect(latest()).toBe('atom');
  });

  it('adds no rows for a Macro that takes no arguments', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'atom' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest()).toBe('atom');
  });

  it('never removes rows the author already filled in', async () => {
    // `pair` needs 2; the tree already has 3. Auto-fill only ever grows.
    const { view, latest } = renderEditor('x(a,b,c)');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest()).toBe('pair(a,b,c)');
  });

  it('does not churn the tree when the arity is already satisfied', async () => {
    // Re-resolving a Macro whose rows already exist must not emit a change;
    // an unguarded effect would fire onChange on every render.
    let changes = 0;
    const view = render(
      <GuiInductiveEditor
        snl="pair(a,b)"
        macroDataDriver={driver}
        macroCandidates={[]}
        macroOrigin={{}}
        onOpenMacroEditor={() => undefined}
        onChange={() => { changes += 1; }}
      />
    );
    await waitFor(() => expect(view.getAllByRole('textbox').length).toBeGreaterThan(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toBe(0);
  });

  it('reclaims empty slots when one Macro is retyped over another', async () => {
    // pair opens two rows; atom needs none, and leaving them behind would
    // serialize as `atom(,)`. Reported by review 2026-07-25.
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'), { timeout: 2000 });

    fireEvent.change(box, { target: { value: 'atom' } });
    await waitFor(() => expect(latest()).toBe('atom'), { timeout: 2000 });
  });

  it('shrinks to the new Macro\'s arity rather than clearing outright', async () => {
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'triple' } });
    await waitFor(() => expect(latest()).toBe('triple(,,)'), { timeout: 2000 });

    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'), { timeout: 2000 });
  });

  it('never discards a slot the author already filled in', async () => {
    const { view, latest } = renderEditor('x(a,b)');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    // `atom` wants zero arguments, but both rows have content — keep them and
    // let the author decide, rather than silently deleting their work.
    fireEvent.change(box, { target: { value: 'atom' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(latest()).toBe('atom(a,b)');
  });

  it('keeps a filled slot even when a later slot is empty', async () => {
    const { view, latest } = renderEditor('x(a,)');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'atom' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Blank excess slots are removed individually; authored siblings remain.
    expect(latest()).toBe('atom(a)');
  });

  // The production driver is a long-lived useMemo with an LRU cache, so the
  // second lookup of a name is a fast cache hit while a previous MISS may
  // still be in flight. Both bugs below were found by review 2026-07-25 and
  // are invisible to a fresh-driver test.
  describe('under a warm cache and out-of-order answers', () => {
    const slowDriver = new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name }: { macro_name: string }) => {
          if (macro_name === 'pair') {
            await new Promise((resolve) => setTimeout(resolve, 120));
            return macro('pair', false, '#0 + #1');
          }
          if (macro_name === 'atom') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return macro('atom', false, 'A');
          }
          if (macro_name === 'list') {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return macro('list', true, '#0: #*');
          }
          return null;
        }
      }
    });

    function renderWith(initial: string): { view: ReturnType<typeof render>; latest: () => string } {
      let latest = initial;
      const view = render(
        <GuiInductiveEditor
          snl={initial}
          macroDataDriver={slowDriver}
          macroCandidates={[]}
          macroOrigin={{}}
          onOpenMacroEditor={() => undefined}
          onChange={(next) => { latest = next; }}
        />
      );
      return { view, latest: () => latest };
    }

    it('still opens slots on a second session with the same driver', async () => {
      const first = renderWith('x');
      fireEvent.change(first.view.getAllByRole('textbox')[0], { target: { value: 'pair' } });
      await waitFor(() => expect(first.latest()).toBe('pair(,)'), { timeout: 3000 });
      cleanup();

      // Warm cache: `pair` now resolves almost instantly, so a stale answer
      // for the initial name could arrive afterwards and wipe it out.
      const second = renderWith('x');
      fireEvent.change(second.view.getAllByRole('textbox')[0], { target: { value: 'pair' } });
      await waitFor(() => expect(second.latest()).toBe('pair(,)'), { timeout: 3000 });
    });

    it('does not let a slow Macro open slots on the name that replaced it', async () => {
      const { view, latest } = renderWith('x');
      const box = view.getAllByRole('textbox')[0] as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'pair' } });
      // Switch away before `pair` resolves; its late answer must be discarded.
      fireEvent.change(box, { target: { value: 'atom' } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(latest()).toBe('atom');
    });

    it('does not let a slow fixed-arity Macro open slots on a variadic one', async () => {
      const { view, latest } = renderWith('x');
      const box = view.getAllByRole('textbox')[0] as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'pair' } });
      fireEvent.change(box, { target: { value: 'list' } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(latest()).toBe('list');
    });
  });

  it('lets the author add a child to a fixed-arity row without it snapping back', async () => {
    // The surplus reclaim must not fight the `+ child` button: it applies to
    // a Macro change, not to every render. Review 2026-07-25.
    const { view, latest } = renderEditor('x');
    const box = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'), { timeout: 2000 });

    fireEvent.click(view.getAllByLabelText('Add child node')[0]);
    await waitFor(() => expect(latest()).toBe('pair(,,)'), { timeout: 2000 });
    // And it stays: nothing reclaims it on a later render.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(latest()).toBe('pair(,,)');
  });

  // Every unfilled sibling's auto-fill effect fires in the SAME commit. When
  // those writes went through `onChange({...node})` each one overwrote the
  // previous sibling's result and only the last row got its slots — a lost
  // update. Found by review 2026-07-25.
  describe('several siblings resolving at once', () => {
    it('gives every sibling its slots, not just the last one', async () => {
      const { latest } = renderEditor('top(pair,triple)');
      await waitFor(() => expect(latest()).toBe('top(pair(,),triple(,,))'), { timeout: 3000 });
    });

    it('holds up with three identical siblings', async () => {
      const { latest } = renderEditor('top3(pair,pair,pair)');
      await waitFor(() => expect(latest()).toBe('top3(pair(,),pair(,),pair(,))'), { timeout: 3000 });
    });

    it('fills a nested row without dropping its parent\'s other branch', async () => {
      const { latest } = renderEditor('top(pair,top(pair,triple))');
      await waitFor(
        () => expect(latest()).toBe('top(pair(,),top(pair(,),triple(,,)))'),
        { timeout: 3000 }
      );
    });
  });

  it('derives temporary Macro arity from authored unescaped placeholders', async () => {
    const zero = renderEditor('$x$');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(zero.view.getAllByRole('textbox')).toHaveLength(1);
    cleanup();

    const one = renderEditor('$#0$');
    await waitFor(() => expect(one.view.getAllByRole('textbox')).toHaveLength(2));
    cleanup();

    const two = renderEditor('$#0 + #1$');
    await waitFor(() => expect(two.latest()).toBe('$#0 + #1$(,)'));
  });

  it('does not count an escaped temporary placeholder', async () => {
    const escaped = renderEditor('$\\#0$');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(escaped.view.getAllByRole('textbox')).toHaveLength(1);
  });

  it('opens the required editor slot for a variadic-only temporary Macro', async () => {
    const variadic = renderEditor('$#*$');
    await waitFor(() => expect(variadic.view.getAllByRole('textbox')).toHaveLength(2));
  });

  it('keeps a temporary variadic Macro dynamic after its required positional prefix', async () => {
    const variadic = renderEditor('$#0 #*$(,)');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(variadic.view.getAllByRole('textbox')).toHaveLength(3);
    expect(variadic.latest()).toBe('$#0 #*$(,)');
  });

  it('does not treat an escaped temporary variadic placeholder as dynamic', async () => {
    const escaped = renderEditor('$\\#*$');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(escaped.view.getAllByRole('textbox')).toHaveLength(1);
  });

  it('reconciles temporary arity again when its source changes', async () => {
    let latest = '$#0$';
    const props = (snl: string) => ({
      snl, macroDataDriver: driver, macroCandidates: [], macroOrigin: {},
      onOpenMacroEditor: () => undefined, onChange: (next: string) => { latest = next; }
    });
    const view = render(<GuiInductiveEditor {...props(latest)} />);
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(2));

    view.rerender(<GuiInductiveEditor {...props('$#0 #1$')} />);
    await waitFor(() => expect(latest).toBe('$#0 #1$(,)'));
    expect(view.getAllByRole('textbox')).toHaveLength(3);
  });

  it('reconciles temporary arity again when its environment changes', async () => {
    let latest = '$#0$';
    const props = (snl: string) => ({
      snl, macroDataDriver: driver, macroCandidates: [], macroOrigin: {},
      onOpenMacroEditor: () => undefined, onChange: (next: string) => { latest = next; }
    });
    const view = render(<GuiInductiveEditor {...props(latest)} />);
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(2));

    view.rerender(<GuiInductiveEditor {...props('%#0%')} />);
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(2));
    expect(latest).toBe('%#0%');
  });

  it('uses only the effective Style and reconciles when Style changes', async () => {
    const styledMacro = {
      name: 'styled-arity', description: '', source: { entries: [], urls: [] }, tags: [],
      dynamic_arity: false,
      styles: [
        { style_name: 'default', template: { mode: 'formula_inline', body: '#0' }, tags: [] },
        { style_name: 'wide', template: { mode: 'formula_inline', body: '#0 #1 #2' }, tags: [] }
      ]
    } as never;
    const styledDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'styled-arity' ? styledMacro : null
    }});
    let latest = 'styled-arity';
    const view = render(<GuiInductiveEditor
      snl={latest}
      macroDataDriver={styledDriver}
      macroCandidates={[{ id: 'styled-arity', labels: [], styles: ['default', 'wide'] }]}
      macroOrigin={{}}
      onOpenMacroEditor={() => undefined}
      onChange={(next) => { latest = next; }}
    />);
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(2));
    fireEvent.change(view.getByRole('combobox', { name: 'Macro style for styled-arity' }), {
      target: { value: 'wide' }
    });
    await waitFor(() => expect(latest).toBe('styled-arity[wide](,,)'));
  });

  it('commits a picked default Style atomically and omits explicit default serialization', async () => {
    const styledMacro = {
      name: 'styled-arity', description: '', source: { entries: [], urls: [] }, tags: [],
      dynamic_arity: false,
      styles: [
        { style_name: 'default', template: { mode: 'formula_inline', body: '#0' }, tags: [] },
        { style_name: 'wide', template: { mode: 'formula_inline', body: '#0 #1 #2' }, tags: [] }
      ]
    } as never;
    const styledDriver = new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'styled-arity' ? styledMacro : null
    }});
    let latest = 'styled-arity[wide](,,)';
    const view = render(<GuiInductiveEditor
      snl={latest}
      macroDataDriver={styledDriver}
      macroCandidates={[{ id: 'styled-arity', labels: [], styles: ['default', 'wide'] }]}
      macroOrigin={{}}
      onOpenMacroEditor={() => undefined}
      onChange={(next) => { latest = next; }}
    />);
    const input = await waitFor(() => view.getAllByRole('textbox')[0] as HTMLInputElement);
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    const search = await waitFor(() => view.getByRole('textbox', { name: 'Search macros in SNoogL' }));
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(latest).toBe('styled-arity'));
    expect((view.getByRole('combobox', { name: 'Macro style for styled-arity' }) as HTMLSelectElement).value)
      .toBe('default');
  });

  it('uses every locale projection in the effective Style as one stable arity', async () => {
    const localized = {
      name: 'localized', description: '', source: { entries: [], urls: [] }, tags: [],
      dynamic_arity: false,
      styles: [{ style_name: 'default', tags: [], template: {
        type: 'i18n', default_language: 'en', values: {
          en: { mode: 'formula_inline', body: '#0' },
          zh: { mode: 'formula_inline', body: '#0 #1' }
        }
      }}]
    } as never;
    const localizedDriver = new MacroDataDriver({ queries: {
      query_macro: async () => localized
    }});
    let latest = 'localized';
    render(<GuiInductiveEditor
      snl={latest} macroDataDriver={localizedDriver} macroCandidates={[]}
      macroOrigin={{}} onOpenMacroEditor={() => undefined}
      onChange={(next) => { latest = next; }}
    />);
    await waitFor(() => expect(latest).toBe('localized(,)'));
  });

  it('reconciles same-name Macro payload shrink and grow', async () => {
    const makeDriver = (template: string) => new MacroDataDriver({ queries: {
      query_macro: async ({ macro_name }: { macro_name: string }) =>
        macro_name === 'same' ? macro('same', false, template) : null
    }});
    let latest = 'same';
    const props = (macroDataDriver: MacroDataDriver) => ({
      snl: latest, macroDataDriver, macroCandidates: [], macroOrigin: {},
      onOpenMacroEditor: () => undefined, onChange: (next: string) => { latest = next; }
    });
    const view = render(<GuiInductiveEditor {...props(makeDriver('#0 #1'))} />);
    await waitFor(() => expect(latest).toBe('same(,)'));
    view.rerender(<GuiInductiveEditor {...props(makeDriver('#0'))} />);
    await waitFor(() => expect(view.getAllByRole('textbox')).toHaveLength(2));
    view.rerender(<GuiInductiveEditor {...props(makeDriver('#0 #1 #2'))} />);
    await waitFor(() => expect(latest).toBe('same(,,)'));
  });

  it('selectively removes blank excess children while retaining semantic excess in order', () => {
    const tree = createSnlSyntaxTreeNode('root', { children: [
      createSnlSyntaxTreeNode('required'),
      createSnlSyntaxTreeNode(''),
      createSnlSyntaxTreeNode('kept-a'),
      createSnlSyntaxTreeNode(''),
      createSnlSyntaxTreeNode('kept-b')
    ] });
    const next = withArityAtPath(tree, '', 1);
    expect(next.children.map((child) => child.macro_name)).toEqual(['required', 'kept-a', 'kept-b']);
  });

  it('does not classify metadata-bearing apparent blanks as semantic blanks', () => {
    for (const field of ['style_name', 'source', 'postfix', 'env_mode', 'temporary_source',
      'temporary_format', 'binder_explicit', 'binder_name', 'scope'] as const) {
      const node = createSnlSyntaxTreeNode('') as unknown as Record<string, unknown>;
      node[field] = field === 'binder_explicit' ? true : { semantic: field };
      expect(isSemanticallyBlankInductiveNode(node as never), field).toBe(false);
    }
    const withMdata = createSnlSyntaxTreeNode('');
    withMdata.mdata = { source: 'authored' };
    expect(isSemanticallyBlankInductiveNode(withMdata)).toBe(false);
    expect(isSemanticallyBlankInductiveNode(createSnlSyntaxTreeNode(' '))).toBe(false);
    const withUnknownSemantics = createSnlSyntaxTreeNode('') as unknown as Record<string, unknown>;
    withUnknownSemantics.context = 'authored-context';
    expect(isSemanticallyBlankInductiveNode(withUnknownSemantics as never)).toBe(false);
  });

  it('undoes a Macro edit and its generated slots atomically', async () => {
    const { view, latest } = renderEditor('x');
    const box = view.getAllByRole('textbox')[0] as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: 'pair' } });
    await waitFor(() => expect(latest()).toBe('pair(,)'));
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'shortcutAction', action: 'inductive.undo' }
    }));
    await waitFor(() => expect(latest()).toBe('x'));
  });

  it('routes a stable owner token while inline completion owns Tab', async () => {
    const { view } = renderEditor('x');
    const box = view.getAllByRole('textbox')[0] as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'pa' } });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'inductiveAutocompleteTabOwnership',
      ownerToken: expect.any(String),
      ownsTab: true
    })));
    const ownerToken = postMessage.mock.calls
      .map(([message]) => message as { ownerToken?: string; ownsTab?: boolean })
      .find((message) => message.ownsTab === true)?.ownerToken;
    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({
      type: 'inductiveAutocompleteTabOwnership', ownerToken, ownsTab: false
    }));
  });

});
