import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonacoTextEditor, type MonacoLoader } from './MonacoTextEditor';

function fakeMonaco(initial = ''): {
  load: MonacoLoader;
  model: {
    value: string;
    setValue: ReturnType<typeof vi.fn>;
    pushEditOperations: ReturnType<typeof vi.fn>;
    pushStackElement: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  editor: {
    commands: Map<number, () => void>;
    create: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    layout: ReturnType<typeof vi.fn>;
  };
  contentChanged: () => void;
} {
  let change = (): void => undefined;
  const model = {
    value: initial,
    getValue() { return this.value; },
    setValue: vi.fn(function (this: { value: string }, value: string) {
      this.value = value;
      change();
    }),
    getFullModelRange: () => ({ marker: 'full-range' }),
    pushEditOperations: vi.fn(function (
      this: { value: string },
      _selections: null,
      edits: Array<{ text: string }>
    ) {
      this.value = edits[0].text;
      change();
      return null;
    }),
    pushStackElement: vi.fn(),
    dispose: vi.fn()
  };
  const commands = new Map<number, () => void>();
  const create = vi.fn();
  const editor = {
    addCommand: vi.fn((key: number, callback: () => void) => {
      commands.set(key, callback);
      return 'command';
    }),
    onDidChangeModelContent: vi.fn((callback: () => void) => {
      change = callback;
      return { dispose: vi.fn() };
    }),
    layout: vi.fn(),
    dispose: vi.fn(),
    commands
  };
  create.mockReturnValue(editor);
  const monaco = {
    KeyMod: { CtrlCmd: 1, Shift: 2, Alt: 4 },
    KeyCode: { KeyS: 8, KeyF: 16 },
    editor: {
      createModel: vi.fn((value: string) => {
        model.value = value;
        return model;
      }),
      create,
      setTheme: vi.fn()
    }
  };
  return {
    load: vi.fn(async () => monaco) as MonacoLoader,
    model,
    editor: { ...editor, create },
    contentChanged: () => change()
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MonacoTextEditor', () => {
  it('enables bracket-pair coloring and matching guides for SNL', async () => {
    const fake = fakeMonaco('outer(inner(a,b), c)');
    const view = render(
      <MonacoTextEditor
        value="outer(inner(a,b), c)"
        language="snl"
        ariaLabel="SNL source"
        onChange={vi.fn()}
        onSave={vi.fn()}
        loadMonaco={fake.load}
      />
    );

    await waitFor(() => expect(view.getByTestId('monaco-editor').getAttribute('data-ready')).toBe('true'));
    expect(fake.editor.create).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
      guides: expect.objectContaining({ bracketPairs: true, highlightActiveBracketPair: true }),
      matchBrackets: 'always'
    }));
  });

  it('loads lazily, preserves controlled edits, and keeps formatting as one undoable edit', async () => {
    const fake = fakeMonaco('root(child)');
    const onChange = vi.fn();
    const view = render(
      <MonacoTextEditor
        value="root(child)"
        language="snl"
        ariaLabel="SNL source"
        formatLabel="Format SNL"
        onChange={onChange}
        onSave={vi.fn()}
        format={(source: string) => `${source}\nformatted`}
        loadMonaco={fake.load}
      />
    );

    expect(fake.load).toHaveBeenCalledOnce();
    await waitFor(() => expect(view.getByTestId('monaco-editor').getAttribute('data-ready')).toBe('true'));
    fireEvent.click(view.getByRole('button', { name: 'Format SNL' }));

    expect(fake.model.pushStackElement).toHaveBeenCalledTimes(2);
    expect(fake.model.pushEditOperations).toHaveBeenCalledWith(
      null,
      [{ range: { marker: 'full-range' }, text: 'root(child)\nformatted' }],
      expect.any(Function)
    );
    expect(onChange).toHaveBeenLastCalledWith('root(child)\nformatted');
  });

  it('routes Monaco save and format shortcuts independently', async () => {
    const fake = fakeMonaco('x');
    const onSave = vi.fn();
    const format = vi.fn(() => 'formatted');
    render(
      <MonacoTextEditor
        value="x"
        language="snl"
        ariaLabel="SNL source"
        formatLabel="Format SNL"
        onChange={vi.fn()}
        onSave={onSave}
        format={format}
        loadMonaco={fake.load}
      />
    );
    await waitFor(() => expect(fake.editor.commands.size).toBe(2));

    act(() => fake.editor.commands.get(1 | 8)?.());
    expect(onSave).toHaveBeenCalledOnce();
    expect(format).not.toHaveBeenCalled();
    act(() => fake.editor.commands.get(2 | 4 | 16)?.());
    expect(format).toHaveBeenCalledWith('x');
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('creates a deferred Monaco model from the latest controlled value', async () => {
    const fake = fakeMonaco();
    const monaco = await fake.load();
    let resolveLoad: ((value: typeof monaco) => void) | undefined;
    const deferredLoad = vi.fn(() => new Promise<typeof monaco>((resolve) => {
      resolveLoad = resolve;
    })) as MonacoLoader;
    const props = {
      language: 'snl',
      ariaLabel: 'SNL source',
      onChange: vi.fn(),
      onSave: vi.fn(),
      loadMonaco: deferredLoad
    };
    const view = render(<MonacoTextEditor {...props} value="stale" />);
    view.rerender(<MonacoTextEditor {...props} value="latest draft" />);

    await act(async () => resolveLoad?.(monaco));
    await waitFor(() => expect(
      view.getByTestId('monaco-editor').getAttribute('data-ready')
    ).toBe('true'));
    expect(fake.model.value).toBe('latest draft');
  });

  it('does not report a controlled prop refresh as a user edit', async () => {
    const fake = fakeMonaco('disk value');
    const onChange = vi.fn();
    const props = {
      language: 'snl',
      ariaLabel: 'SNL source',
      onChange,
      onSave: vi.fn(),
      loadMonaco: fake.load
    };
    const view = render(<MonacoTextEditor {...props} value="disk value" />);
    await waitFor(() => expect(
      view.getByTestId('monaco-editor').getAttribute('data-ready')
    ).toBe('true'));

    view.rerender(<MonacoTextEditor {...props} value="fresh host value" />);
    await waitFor(() => expect(fake.model.value).toBe('fresh host value'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lays out on resize and disposes editor, model, listener, and observer', async () => {
    const fake = fakeMonaco();
    const disconnect = vi.fn();
    let resize = (): void => undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as never); }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = disconnect;
    });
    const view = render(
      <MonacoTextEditor
        value=""
        language="plaintext"
        ariaLabel="Text source"
        onChange={vi.fn()}
        onSave={vi.fn()}
        loadMonaco={fake.load}
      />
    );
    await waitFor(() => expect(view.getByTestId('monaco-editor').getAttribute('data-ready')).toBe('true'));
    act(() => resize());
    expect(fake.editor.layout).toHaveBeenCalled();

    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(fake.editor.dispose).toHaveBeenCalledOnce();
    expect(fake.model.dispose).toHaveBeenCalledOnce();
  });
});
