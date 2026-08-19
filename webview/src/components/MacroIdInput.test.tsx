import React from 'react';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autoCloseLeadingDelimiter,
  MacroIdInput,
  tokenizeMacroIdDsl
} from './MacroIdInput';
import { createMacroPreviewRuntime } from '../render/MacroPreview';
import type { WireMacro } from '../render/macroWire';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MacroIdInput', () => {
  const previewMacro = (name: string, body: string): WireMacro => ({
    name,
    description: '',
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    styles: [{
      style_name: 'default',
      tags: [],
      template: { mode: 'formula_inline', body }
    }],
    tags: []
  });

  it('renders exactly the highlighted inline preview and updates it for arrows and query', async () => {
    const alpha = previewMacro('Alpha.one', '\\mathrm{ALPHA}');
    const beta = previewMacro('Beta.two', '\\mathrm{BETA}');
    const runtime = createMacroPreviewRuntime({
      macros: { 'Alpha.one': alpha, 'Beta.two': beta },
      language: 'en'
    });
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroCandidates={[
            { id: 'Alpha.one', labels: ['common'] },
            { id: 'Beta.two', labels: ['common'] }
          ]}
          macroPreviewRuntime={runtime}
          aria-label="Preview Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Preview Macro ID' });
    fireEvent.change(input, { target: { value: 'common' } });
    await view.findByLabelText('Preview Alpha.one');
    const firstOption = view.getByRole('option', { name: 'Alpha.one' });
    expect(input.getAttribute('aria-activedescendant')).toBe(firstOption.id);
    expect(input.getAttribute('aria-controls')).toBe(
      firstOption.closest('[role="listbox"]')?.id
    );
    expect(view.container.querySelectorAll('[data-macro-preview]')).toHaveLength(1);
    expect(view.container.querySelector('[data-macro-preview]')?.hasAttribute('inert')).toBe(true);
    expect(view.container.querySelector('[data-macro-preview]')?.getAttribute('data-macro-preview'))
      .toBe('Alpha.one');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await view.findByLabelText('Preview Beta.two');
    expect(input.getAttribute('aria-activedescendant'))
      .toBe(view.getByRole('option', { name: 'Beta.two' }).id);
    expect(view.container.querySelectorAll('[data-macro-preview]')).toHaveLength(1);

    fireEvent.change(input, { target: { value: 'Alpha' } });
    await view.findByLabelText('Preview Alpha.one');
    expect(view.queryByLabelText('Preview Beta.two')).toBeNull();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    expect(input.getAttribute('aria-controls')).toBeNull();
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('keeps the compact inline layout when no preview runtime is supplied', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return <MacroIdInput value={value} onChange={setValue}
        macroCandidates={[{ id: 'Alpha.one', labels: [] }]} aria-label="Compact Macro ID" />;
    }
    const view = render(<Harness />);
    fireEvent.change(view.getByRole('textbox', { name: 'Compact Macro ID' }), {
      target: { value: 'Alpha' }
    });
    expect(view.getByRole('option', { name: 'Alpha.one' })).toBeTruthy();
    expect(view.container.querySelector('[data-macro-preview-pane]')).toBeNull();
  });

  it('lazy-mounts only visible full-modal row previews from one shared runtime', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observed: Element[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe = (element: Element) => { observed.push(element); };
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    });
    const macros = Object.fromEntries(['Alpha', 'Beta', 'Gamma'].map((name) => [
      name,
      previewMacro(name, `\\mathrm{${name}}`)
    ]));
    const runtime = createMacroPreviewRuntime({ macros, language: 'en' });
    const view = render(
      <MacroIdInput
        value=""
        onChange={() => undefined}
        macroCandidates={Object.keys(macros).map((id) => ({ id, labels: [] }))}
        macroPreviewRuntime={runtime}
        aria-label="Lazy Macro ID"
      />
    );
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Lazy Macro ID' }), {
      key: 'f', ctrlKey: true
    });
    const modalSearch = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    expect(modalSearch.getAttribute('aria-controls'))
      .toBe(view.getByRole('listbox', { name: 'SNoogL macro results' }).id);
    expect(observed).toHaveLength(3);
    expect(view.container.querySelectorAll('[data-macro-preview]')).toHaveLength(0);

    callbacks[0]?.([
      { target: observed[0], isIntersecting: true },
      { target: observed[1], isIntersecting: true }
    ] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await view.findByLabelText('Preview Alpha');
    await view.findByLabelText('Preview Beta');
    expect(view.container.querySelectorAll('[data-macro-preview]')).toHaveLength(2);
    expect(view.queryByLabelText('Preview Gamma')).toBeNull();
    expect(runtime.macroDataDriver).toBe(runtime.macroDataDriver);
  });

  it('keeps an arrow-highlighted modal result scrolled into view', () => {
    const view = render(
      <MacroIdInput
        value=""
        onChange={() => undefined}
        macroCandidates={[
          { id: 'Alpha.one', labels: [] },
          { id: 'Beta.two', labels: [] }
        ]}
        aria-label="Scrolling Macro ID"
      />
    );
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Scrolling Macro ID' }), {
      key: 'f', ctrlKey: true
    });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    const beta = view.getByRole('option', { name: 'Beta.two' });
    const scrollIntoView = vi.fn();
    beta.scrollIntoView = scrollIntoView;
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('ignores stale lazy-preview observations after the preview runtime changes', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observedByGeneration: Element[][] = [];
    vi.stubGlobal('IntersectionObserver', class {
      private readonly generation: number;
      constructor(callback: IntersectionObserverCallback) {
        this.generation = callbacks.push(callback) - 1;
        observedByGeneration[this.generation] = [];
      }
      observe = (element: Element) => { observedByGeneration[this.generation].push(element); };
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = () => [];
      root = null;
      rootMargin = '0px';
      thresholds = [0];
    });
    const alpha = previewMacro('Alpha', '\\mathrm{ALPHA}');
    const runtime = createMacroPreviewRuntime({ macros: { Alpha: alpha }, language: 'en' });
    const element = (activeRuntime: typeof runtime) => (
      <MacroIdInput
        value=""
        onChange={() => undefined}
        macroCandidates={[{ id: 'Alpha', labels: [] }]}
        macroPreviewRuntime={activeRuntime}
        aria-label="Stale observer Macro ID"
      />
    );
    const view = render(element(runtime));
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Stale observer Macro ID' }), {
      key: 'f', ctrlKey: true
    });
    const oldAlphaRow = observedByGeneration[0][0];
    const replacementRuntime = createMacroPreviewRuntime({
      macros: { Alpha: previewMacro('Alpha', '\\mathrm{REPLACEMENT}') },
      language: 'en'
    });
    view.rerender(element(replacementRuntime));
    const currentAlphaRow = observedByGeneration[1][0];
    callbacks[1]([
      { target: currentAlphaRow, isIntersecting: true }
    ] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await view.findByLabelText('Preview Alpha');
    callbacks[0]([
      { target: oldAlphaRow, isIntersecting: false }
    ] as IntersectionObserverEntry[], {} as IntersectionObserver);
    await view.findByLabelText('Preview Alpha');
  });

  it('keeps syntax colors visible through native text selection', () => {
    const view = render(
      <MacroIdInput
        value="$Foo.bar$"
        onChange={() => undefined}
        aria-label="Selected Macro"
        className="caller-class"
      />
    );
    const input = view.getByRole('textbox', { name: 'Selected Macro' });
    expect(input.classList.contains('snl-macro-id-native-control')).toBe(true);
    expect(input.classList.contains('caller-class')).toBe(true);

    const css = readFileSync('webview/src/components/MacroIdInput.css', 'utf8');
    const selectionRule = css.match(
      /\.snl-macro-id-native-control::selection\s*\{([^}]*)\}/
    )?.[1] ?? '';
    expect(selectionRule).toMatch(/(?:^|\n)\s*color:\s*transparent;/);
    expect(selectionRule).toMatch(/(?:^|\n)\s*-webkit-text-fill-color:\s*transparent;/);
    expect(selectionRule).toMatch(/(?:^|\n)\s*background:[^;]*color-mix\(/s);
  });

  it('auto-closes a leading formula or text delimiter', () => {
    expect(autoCloseLeadingDelimiter('', '$')).toEqual({ value: '$$', caret: 1 });
    expect(autoCloseLeadingDelimiter('', '%')).toEqual({ value: '%%', caret: 1 });
    expect(autoCloseLeadingDelimiter('x', 'x$')).toEqual({ value: 'x$', caret: null });
  });

  it('tokenizes DSL delimiters and binder/context annotations for coloring', () => {
    expect(tokenizeMacroIdDsl('@Foo($x$,%text%)@ctx')).toEqual([
      { text: '@', tone: 'binder' },
      { text: 'Foo(', tone: 'plain' },
      { text: '$', tone: 'formula' },
      { text: 'x', tone: 'plain' },
      { text: '$', tone: 'formula' },
      { text: ',', tone: 'plain' },
      { text: '%', tone: 'text' },
      { text: 'text', tone: 'plain' },
      { text: '%', tone: 'text' },
      { text: ')', tone: 'plain' },
      { text: '@', tone: 'context' },
      { text: 'ctx', tone: 'plain' }
    ]);
  });

  it('keeps dollar delimiters literal when coloring percent-delimited text', () => {
    expect(tokenizeMacroIdDsl('%$\\texcommand$ stays text%')).toEqual([
      { text: '%', tone: 'text' },
      { text: '$\\texcommand$ stays text', tone: 'plain' },
      { text: '%', tone: 'text' }
    ]);
  });

  it('keeps every structural-looking character literal inside percent text', () => {
    expect(tokenizeMacroIdDsl('%foo@bar,(baz)[style]$x$%')).toEqual([
      { text: '%', tone: 'text' },
      { text: 'foo@bar,(baz)[style]$x$', tone: 'plain' },
      { text: '%', tone: 'text' }
    ]);
  });

  it('auto-closes delimiters in the control and renders parser-aware colors', async () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return <MacroIdInput value={value} onChange={setValue} aria-label="DSL Macro ID" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'DSL Macro ID' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '$' } });
    expect(input.value).toBe('$$');
    await Promise.resolve();
    expect(input.selectionStart).toBe(1);

    fireEvent.change(input, { target: { value: '@Foo($x$)@ctx' } });
    expect(view.container.querySelectorAll('[data-tone="binder"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-tone="formula"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('[data-tone="context"]')).toHaveLength(1);
  });

  it('gates autocomplete on real input and re-arms after Escape', () => {
    const onKeyDown = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('FO');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          onKeyDown={onKeyDown}
          macroCandidates={['FOL.forall', 'Foo.bar', 'Add.add'].map((id) => ({ id, labels: [] }))}
          aria-label="Autocomplete Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Autocomplete Macro ID' }) as HTMLInputElement;

    fireEvent.focus(input);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    fireEvent.change(input, { target: { value: 'Foo' } });
    expect(view.getByRole('listbox', { name: 'Macro ID suggestions' })).toBeTruthy();
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    fireEvent.blur(input);
    fireEvent.focus(input);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    fireEvent.change(input, { target: { value: 'Fo' } });
    expect(view.getByRole('listbox', { name: 'Macro ID suggestions' })).toBeTruthy();
  });

  it('owns forward Tab only for an input-armed visible result and always leaves Shift+Tab', () => {
    const onOwnershipChange = vi.fn();
    const onKeyDown = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('FO');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          onKeyDown={onKeyDown}
          onSuggestionTabOwnershipChange={onOwnershipChange}
          macroCandidates={['FOL.forall', 'Foo.bar'].map((id) => ({ id, labels: [] }))}
          aria-label="Navigable Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Navigable Macro ID' }) as HTMLInputElement;
    fireEvent.focus(input);
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(input.value).toBe('FO');

    fireEvent.change(input, { target: { value: 'Fo' } });
    expect(onOwnershipChange).toHaveBeenLastCalledWith(true);
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(input.value).toBe('Fo');
    expect(onKeyDown).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Tab', shiftKey: true }));
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('FOL.forall');
    expect(onOwnershipChange).toHaveBeenLastCalledWith(false);
  });

  it('clears Tab ownership on empty results, blur, Escape, and unmount', () => {
    const onOwnershipChange = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return <MacroIdInput value={value} onChange={setValue}
        onSuggestionTabOwnershipChange={onOwnershipChange}
        macroCandidates={[{ id: 'Foo.one', labels: [] }]}
        aria-label="Ownership lifecycle Macro ID" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Ownership lifecycle Macro ID' });
    fireEvent.change(input, { target: { value: 'Fo' } });
    expect(onOwnershipChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(input, { target: { value: 'no-match' } });
    expect(onOwnershipChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(input, { target: { value: 'Fo' } });
    fireEvent.blur(input);
    expect(onOwnershipChange).toHaveBeenLastCalledWith(false);
    fireEvent.focus(input);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    fireEvent.change(input, { target: { value: 'Foo' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onOwnershipChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(input, { target: { value: 'Fo' } });
    view.unmount();
    expect(onOwnershipChange).toHaveBeenLastCalledWith(false);
  });

  it('does not let an armed empty suggestion list consume Escape or Tab', () => {
    const onKeyDown = vi.fn();
    const onOwnershipChange = vi.fn();
    const { rerender, ...view } = render(
      <MacroIdInput
        value="no-match"
        onChange={() => undefined}
        onKeyDown={onKeyDown}
        onSuggestionTabOwnershipChange={onOwnershipChange}
        macroCandidates={[{ id: 'Foo.one', labels: [] }]}
        aria-label="Empty suggestions Macro ID"
      />
    );
    const input = view.getByRole('textbox', { name: 'Empty suggestions Macro ID' });

    fireEvent.change(input, { target: { value: 'still-no-match' } });
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    expect(onOwnershipChange).not.toHaveBeenCalledWith(true);
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Tab' }));

    rerender(
      <MacroIdInput
        value="still-no-match"
        onChange={() => undefined}
        onKeyDown={onKeyDown}
        onSuggestionTabOwnershipChange={onOwnershipChange}
        macroCandidates={[{ id: 'still-no-match-result', labels: [] }]}
        aria-label="Empty suggestions Macro ID"
      />
    );
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
  });

  it('does not open inline completion for composition input until composition ends', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return <MacroIdInput value={value} onChange={setValue}
        macroCandidates={[{ id: 'Foo.one', labels: [] }]}
        aria-label="Composition-gated Macro ID" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Composition-gated Macro ID' });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'Fo' } });
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
    fireEvent.compositionEnd(input);
    expect(view.getByRole('listbox', { name: 'Macro ID suggestions' })).toBeTruthy();
  });

  it('resets the highlighted result to the first candidate after each material query change', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return <MacroIdInput value={value} onChange={setValue} macroCandidates={[
        { id: 'Alpha.one', labels: ['common'] },
        { id: 'Beta.two', labels: ['common'] },
        { id: 'Alpha.beta', labels: [] }
      ]} aria-label="Rank-reset Macro ID" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Rank-reset Macro ID' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'common' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(view.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.change(input, { target: { value: 'Alpha' } });
    expect(view.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('refreshes suggestions when the caret moves to another token before Tab', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('foo ba');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroCandidates={['Foo.macro', 'Bar.macro'].map((id) => ({ id, labels: [] }))}
          aria-label="Multi-token Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Multi-token Macro ID' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'foo bar' } });
    input.setSelectionRange(1, 3);
    fireEvent.select(input);
    expect(view.getByRole('option', { name: 'Foo.macro' })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('Foo.macro bar');
  });

  it('leaves Shift+Tab to the consumer instead of accepting an autocomplete suggestion', () => {
    const onKeyDown = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('Fo');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          onKeyDown={onKeyDown}
          macroCandidates={[{ id: 'Foo.macro', labels: [] }]}
          aria-label="Reversible Macro navigation"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Reversible Macro navigation' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });

    expect(input.value).toBe('Fo');
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it('wraps an existing value when a delimiter is typed at the leading caret', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('foo');
      return <MacroIdInput value={value} onChange={setValue} aria-label="Leading delimiter" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Leading delimiter' }) as HTMLInputElement;
    fireEvent.focus(input);
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: '$' });
    expect(input.value).toBe('$foo$');
    expect(input.selectionStart).toBe(1);
  });

  it('does not duplicate a formula delimiter already authored at the far right', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('foo$');
      return <MacroIdInput value={value} onChange={setValue} aria-label="Terminated formula" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Terminated formula' }) as HTMLInputElement;
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: '$' });
    expect(input.value).toBe('$foo$');
  });

  it.each([
    ['%', 'text%', '%text%'],
    ['$', 'display$$', '$display$$'],
    ['%', 'formula$', '%formula$'],
    ['$', 'text%', '$text%']
  ])('preserves existing %s delimiter semantics for %s', (key, initial, expected) => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState(initial);
      return <MacroIdInput value={value} onChange={setValue} aria-label="Terminated shorthand" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Terminated shorthand' }) as HTMLInputElement;
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key });
    expect(input.value).toBe(expected);
  });

  it('commits the first clicked SNoogL result without requiring a second selection', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroCandidates={['FOL.forall', 'Foo.bar', 'Add.add'].map((id) => ({ id, labels: [] }))}
          aria-label="SNoogL Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'SNoogL Macro ID' }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    expect(view.getByRole('dialog', { name: 'SNoogL Macro Search' })).toBeTruthy();
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    expect(document.activeElement).toBe(search);
    fireEvent.click(view.getByRole('option', { name: 'FOL.forall' }));
    expect(input.value).toBe('FOL.forall');
    expect(view.queryByRole('dialog', { name: 'SNoogL Macro Search' })).toBeNull();
  });

  it('localizes the embedded SNoogL picker in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(
      <MacroIdInput
        value=""
        onChange={() => undefined}
        macroCandidates={[{ id: 'FOL.forall', labels: [] }]}
        aria-label="Macro ID"
      />
    );
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Macro ID' }), {
      key: 'f', ctrlKey: true
    });
    expect(view.getByRole('dialog', { name: 'SNoogL 宏搜索' })).toBeTruthy();
    expect(view.getByRole('textbox', { name: '在 SNoogL 中搜索宏' })).toBeTruthy();
    expect(view.getByText(/Tab 插入所选宏名/)).toBeTruthy();
    document.documentElement.lang = 'en';
  });

  it('uses shared SNoogL multi-token and tag ranking in the embedded picker', () => {
    const view = render(
      <MacroIdInput
        value=""
        onChange={() => undefined}
        macroCandidates={[
          { id: 'FOL.forall', labels: ['quantifier'] },
          { id: 'Other.forall', labels: [] }
        ]}
        aria-label="Ranked SNoogL Macro ID"
      />
    );
    const input = view.getByRole('textbox', { name: 'Ranked SNoogL Macro ID' });
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.change(search, { target: { value: 'quantifier forall' } });

    expect(view.getByRole('option', { name: 'FOL.forall' })).toBeTruthy();
    expect(view.queryByRole('option', { name: 'Other.forall' })).toBeNull();
  });

  it('does not open completion UI for a read-only Macro ID', () => {
    const view = render(
      <MacroIdInput
        readOnly
        value="Fixed.name"
        onChange={() => undefined}
        macroCandidates={[{ id: 'Other.name', labels: [] }]}
        aria-label="Read-only Macro ID"
      />
    );
    const input = view.getByRole('textbox', { name: 'Read-only Macro ID' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    expect(view.queryByRole('dialog', { name: 'SNoogL Macro Search' })).toBeNull();
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
  });

  it('provides one shared single-line Macro ID input', () => {
    const onChange = vi.fn();
    const view = render(
      <MacroIdInput value="foo" onChange={onChange} aria-label="Macro ID" />
    );
    const input = view.getByRole('textbox', { name: 'Macro ID' });
    fireEvent.change(input, { target: { value: 'bar' } });
    expect(onChange).toHaveBeenCalledWith('bar');
    expect(input.tagName).toBe('INPUT');
  });

  it('clips the scrolled highlight and mirrors className typography', () => {
    const styleElement = document.createElement('style');
    styleElement.textContent = '.macro-class-style { padding: 7px; font-size: 19px; line-height: 23px; }';
    document.head.appendChild(styleElement);
    const view = render(
      <MacroIdInput
        className="macro-class-style"
        value="Long.Macro.Identifier"
        onChange={() => undefined}
        aria-label="Styled Macro ID"
      />
    );
    const input = view.getByRole('textbox', { name: 'Styled Macro ID' }) as HTMLInputElement;
    const viewport = view.container.querySelector<HTMLElement>('[data-macro-id-viewport]')!;
    const highlight = view.container.querySelector<HTMLElement>('[data-macro-id-highlight]')!;
    const highlightContent = view.container.querySelector<HTMLElement>('[data-macro-id-highlight-content]')!;
    expect(viewport.style.overflow).toBe('hidden');
    expect(highlight.style.padding).toBe('7px');
    expect(highlight.style.fontSize).toBe('19px');
    Object.defineProperty(input, 'scrollLeft', { configurable: true, value: 30 });
    fireEvent.scroll(input);
    expect(highlightContent.style.transform).toContain('-30px');
    styleElement.remove();
  });

  it('supports an auto-sized multiline SNL editing mode and resizes with width', () => {
    const callbacks: { resize?: ResizeObserverCallback } = {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { callbacks.resize = callback; }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    });
    const view = render(
      <MacroIdInput
        multiline
        autoSize
        value={'root(\n  child\n)'}
        onChange={() => undefined}
        aria-label="Focused SNL"
      />
    );
    const textarea = view.getByRole('textbox', { name: 'Focused SNL' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.closest<HTMLElement>('[data-macro-id-control]')?.style.width).toContain('ch');
    expect(textarea.getAttribute('rows')).toBe('3');
    expect(observe).toHaveBeenCalledWith(textarea);
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 160 });
    callbacks.resize?.([], {} as ResizeObserver);
    expect(textarea.style.height).toBe('160px');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  const styledCandidates = [
    { id: 'Div.div', labels: [], styles: ['frac', 'inline', 'slash'] },
    { id: 'Add.add', labels: [], styles: ['plus'] }
  ];

  it('emits structured default and nondefault picker commits with replacement ranges', async () => {
    const commits = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          onStructuredCommit={commits}
          macroCandidates={styledCandidates}
          aria-label="Structured Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Structured Macro ID' }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Div[legacy]' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(commits).toHaveBeenNthCalledWith(1, {
      macroName: 'Div.div',
      styleName: undefined,
      replacementRange: { start: 0, end: 11 },
      source: 'inline-tab'
    });

    fireEvent.change(input, { target: { value: 'Div' } });
    fireEvent.contextMenu(await view.findByRole('option', { name: 'Div.div' }));
    fireEvent.click(await view.findByRole('menuitem', { name: /slash/i }));
    expect(commits).toHaveBeenNthCalledWith(2, {
      macroName: 'Div.div',
      styleName: 'slash',
      replacementRange: { start: 0, end: 3 },
      source: 'inline-style-click'
    });
  });

  it('opens a style menu from inline contextmenu and keyboard, closes on outside/stale changes, and guards IME', async () => {
    const commits = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <>
          <MacroIdInput
            value={value}
            onChange={setValue}
            onStructuredCommit={commits}
            macroCandidates={styledCandidates}
            aria-label="Inline style Macro ID"
          />
          <button type="button">Outside</button>
        </>
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Inline style Macro ID' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Div' } });

    const option = await view.findByRole('option', { name: 'Div.div' });
    fireEvent.contextMenu(option);
    await view.findByRole('menu', { name: 'Styles for Div.div' });
    fireEvent.pointerDown(view.getByRole('button', { name: 'Outside' }));
    await waitFor(() => expect(view.queryByRole('menu', { name: 'Styles for Div.div' })).toBeNull());
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'ArrowRight' });
    await view.findByRole('menu', { name: 'Styles for Div.div' });
    fireEvent.change(input, { target: { value: 'Add' } });
    await waitFor(() => expect(view.queryByRole('menu', { name: 'Styles for Div.div' })).toBeNull());

    fireEvent.change(input, { target: { value: 'Div' } });
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: 'ArrowRight', isComposing: true })).toBe(true);
    expect(view.queryByRole('menu', { name: 'Styles for Div.div' })).toBeNull();
    fireEvent.compositionEnd(input);
  });

  it('opens a modal style menu from keyboard and returns focus to the search field on Escape', async () => {
    const commits = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          onStructuredCommit={commits}
          macroCandidates={styledCandidates}
          aria-label="Modal style Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Modal style Macro ID' }) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    const search = await view.findByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.change(search, { target: { value: 'Div' } });
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    const menu = await view.findByRole('menu', { name: 'Styles for Div.div' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(view.queryByRole('menu', { name: 'Styles for Div.div' })).toBeNull());
    expect(document.activeElement).toBe(search);
  });

  it('does not expose a style drilldown for ID-only consumers', async () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroCandidates={styledCandidates}
          aria-label="Plain Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Plain Macro ID' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Div' } });
    const option = await view.findByRole('option', { name: 'Div.div' });
    fireEvent.contextMenu(option);
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    expect(view.queryByRole('menu', { name: 'Styles for Div.div' })).toBeNull();
  });

  it('renders all style previews from one shared runtime in the style menu', async () => {
    const runtime = createMacroPreviewRuntime({
      macros: {
        'Div.div': {
          name: 'Div.div',
          description: '',
          source: { entries: [], urls: [] },
          dynamic_arity: false,
          styles: [
            { style_name: 'frac', tags: [], template: { mode: 'formula_inline', body: '\\frac{#0}{#1}' } },
            { style_name: 'inline', tags: [], template: { mode: 'formula_inline', body: '#0 / #1' } },
            { style_name: 'slash', tags: [], template: { mode: 'formula_inline', body: '#0\\mathbin{/}#1' } }
          ],
          tags: []
        }
      },
      language: 'en'
    });
    const commits = vi.fn();
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          onStructuredCommit={commits}
          macroCandidates={styledCandidates}
          macroPreviewRuntime={runtime}
          aria-label="Preview style Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Preview style Macro ID' });
    fireEvent.change(input, { target: { value: 'Div' } });
    fireEvent.contextMenu(await view.findByRole('option', { name: 'Div.div' }));
    await view.findByRole('menu', { name: 'Styles for Div.div' });
    expect(document.querySelectorAll('[data-macro-style-menu] [data-macro-preview]')).toHaveLength(3);
    expect(runtime.backendQueryCount()).toBeGreaterThan(0);
    expect(runtime.backendQueryCount()).toBeLessThanOrEqual(3);
    expect(runtime.macroDataDriver).toBe(runtime.macroDataDriver);
  });

  it('offers only bare Macro ids even when candidates declare styles', async () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroCandidates={styledCandidates}
          aria-label="DSL Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'DSL Macro ID' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Div' } });

    const labels = (await view.findAllByRole('option')).map((option) => option.textContent);
    expect(labels[0]).toBe('Div.div');
    expect(labels.every((label) => !label?.includes('['))).toBe(true);
  });

  it('inserts only the Macro id from the embedded SNoogL dialog', async () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroCandidates={styledCandidates}
          aria-label="DSL Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'DSL Macro ID' }) as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.change(search, { target: { value: 'Div' } });
    const results = view.getAllByRole('option').map((option) => option.textContent);
    expect(results[0]).toBe('Div.div');
    expect(results.every((label) => !label?.includes('['))).toBe(true);
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(input.value).toBe('Div.div');
  });

  it('commits modal forward Tab only with results and leaves reverse/empty Tab native', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('seed');
      return <MacroIdInput value={value} onChange={setValue} macroCandidates={[
        { id: 'Foo.one', labels: [] }, { id: 'Bar.two', labels: [] }
      ]} aria-label="Modal keyboard Macro ID" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Modal keyboard Macro ID' }) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    let search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    expect(search.getAttribute('aria-activedescendant'))
      .toBe(view.getAllByRole('option')[0]?.id);
    expect(fireEvent.keyDown(search, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(input.value).toBe('seed');
    fireEvent.change(search, { target: { value: 'no-match' } });
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true);
    expect(input.value).toBe('seed');
    fireEvent.change(search, { target: { value: 'Foo' } });
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(false);
    expect(input.value).toBe('Foo.one');
    expect(view.queryByRole('dialog', { name: 'SNoogL Macro Search' })).toBeNull();

    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(view.queryByRole('dialog', { name: 'SNoogL Macro Search' })).toBeNull();
    fireEvent.focus(input);
    expect(view.queryByRole('listbox', { name: 'Macro ID suggestions' })).toBeNull();
  });

  it('does not navigate, commit, or dismiss inline and modal completion during IME composition', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('Fo');
      return <MacroIdInput value={value} onChange={setValue} macroCandidates={[
        { id: 'Foo.one', labels: [] }, { id: 'Foo.two', labels: [] }
      ]} aria-label="IME completion Macro ID" />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'IME completion Macro ID' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Foo' } });
    fireEvent.compositionStart(input);
    for (const key of ['ArrowDown', 'Tab', 'Escape']) {
      expect(fireEvent.keyDown(input, { key, isComposing: true })).toBe(true);
    }
    expect(input.value).toBe('Foo');
    expect(view.getByRole('listbox', { name: 'Macro ID suggestions' })).toBeTruthy();
    fireEvent.compositionEnd(input);

    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    const search = view.getByRole('textbox', { name: 'Search macros in SNoogL' });
    for (const key of ['ArrowDown', 'Tab', 'Escape']) {
      expect(fireEvent.keyDown(search, { key, isComposing: true })).toBe(true);
    }
    expect(view.getByRole('dialog', { name: 'SNoogL Macro Search' })).toBeTruthy();
    expect(input.value).toBe('Foo');
  });

  it('does not restore selection imperatively while an IME composition is active', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('abcd');
      return <MacroIdInput value={value} onChange={setValue} macroCandidates={[]} />;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox') as HTMLInputElement;
    const setSelectionRange = vi.spyOn(input, 'setSelectionRange');

    fireEvent.compositionStart(input);
    fireEvent.input(input, {
      target: { value: 'ab猫cd', selectionStart: 3, selectionEnd: 3 },
      isComposing: true
    });

    expect(setSelectionRange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    expect(setSelectionRange).toHaveBeenLastCalledWith(3, 3);
  });


  it('does not leak a rejected edit caret into a later external value update', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('abcd');
      return <>
        <MacroIdInput value={value} onChange={() => undefined} macroCandidates={[]} />
        <button type="button" onClick={() => setValue('uvwxyz')}>external update</button>
      </>;
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox') as HTMLInputElement;
    const setSelectionRange = vi.spyOn(input, 'setSelectionRange');
    input.focus();
    input.setSelectionRange(2, 2);
    setSelectionRange.mockClear();

    fireEvent.input(input, {
      target: { value: 'abXcd', selectionStart: 3, selectionEnd: 3 }
    });
    setSelectionRange.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'external update' }));

    expect(input.value).toBe('uvwxyz');
    expect(setSelectionRange).not.toHaveBeenCalled();
  });

});
