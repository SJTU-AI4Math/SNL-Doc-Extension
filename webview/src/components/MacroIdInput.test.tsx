import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autoCloseLeadingDelimiter,
  MacroIdInput,
  tokenizeMacroIdDsl
} from './MacroIdInput';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MacroIdInput', () => {
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

  it('autocompletes Macro IDs from the workspace library', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('FO');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroIds={['FOL.forall', 'Foo.bar', 'Add.add']}
          aria-label="Autocomplete Macro ID"
        />
      );
    }
    const view = render(<Harness />);
    const input = view.getByRole('textbox', { name: 'Autocomplete Macro ID' });
    fireEvent.focus(input);
    expect(view.getByRole('listbox', { name: 'Macro ID suggestions' })).toBeTruthy();
    expect(view.getByText('FOL.forall')).toBeTruthy();
    expect(view.getByText('Foo.bar')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect((input as HTMLInputElement).value).toBe('FOL.forall');
  });

  it('opens an embedded SNoogL picker with Ctrl+F and Tab inserts the selected Macro', () => {
    function Harness(): React.ReactElement {
      const [value, setValue] = React.useState('');
      return (
        <MacroIdInput
          value={value}
          onChange={setValue}
          macroIds={['FOL.forall', 'Foo.bar', 'Add.add']}
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
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(input.value).toBe('FOL.forall');
    expect(view.queryByRole('dialog', { name: 'SNoogL Macro Search' })).toBeNull();
  });

  it('does not open completion UI for a read-only Macro ID', () => {
    const view = render(
      <MacroIdInput
        readOnly
        value="Fixed.name"
        onChange={() => undefined}
        macroIds={['Other.name']}
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
});
