import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posted: unknown[] = [];

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = {
    postMessage: (message: unknown) => { posted.push(message); },
    getState: () => undefined,
    setState: () => undefined
  };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { PackagePanelApp } = await import('./PackagePanelApp');
const { CreateMacroApp } = await import('./CreateMacroApp');

afterEach(cleanup);
beforeEach(() => { posted.length = 0; });

function send(message: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  });
}

const original = {
  name: 'original',
  description: 'Full description',
  source: {
    entries: ['entry-a'],
    urls: ['https://example.com/source'],
    vendor_source: { provenance: 'keep-me' }
  },
  kind: 'operator',
  dynamic_arity: true,
  tags: ['macro-tag'],
  consumer_metadata: { owner: 'downstream', flags: ['keep-me'] },
  styles: [
    {
      style_name: 'default',
      mode: 'formula_display',
      template: '\\left(#*\\right)',
      separator: ', ',
      tags: ['style-tag'],
      typst: {
        built_in: 'sum',
        synthesis: { mode: 'formula', macro: 'sum(#*)', vendor_synthesis: 'keep-me' },
        vendor_backend: { engine: 'typst-x' }
      },
      latex: { built_in: '\\sum', synthesis: { mode: 'text', macro: 'sum #*' } },
      markdown: '**#***',
      text: 'items: #*',
      custom_renderer: { engine: 'consumer-x', options: { compact: false } }
    },
    {
      style_name: 'compact',
      mode: 'text',
      template: 'compact #*',
      separator: '',
      tags: ['compact-tag'],
      typst: { built_in: '', synthesis: { mode: 'formula', macro: '' } },
      latex: { built_in: '', synthesis: { mode: 'formula', macro: '' } },
      markdown: '',
      text: 'compact',
      custom_renderer: { engine: 'consumer-y', options: { compact: true } }
    }
  ]
};

function sendMacroContext(mode: 'create' | 'edit'): void {
  send({
    type: 'context',
    mode,
    file: 'algebra.json',
    packageName: 'Algebra',
    existingNames: ['original'],
    macroCandidates: [],
    macroKinds: [{
      id: 'operator',
      name: 'Operator',
      description: '',
      coloring: { stroke: '#000', background: '#fff' }
    }],
    existing: mode === 'edit' ? original : null,
    entries: [{ id: 'entry-a', title: 'Entry A', hasContent: true }],
    prefill: mode === 'create' ? { macro: original } : undefined
  });
}

describe('Copy Macro', () => {
  it('posts the copied macro name from the correct package-row action', () => {
    render(<PackagePanelApp />);
    send({
      type: 'package',
      pkg: { version: '9', name: 'Algebra', macros: {} },
      file: 'algebra.json',
      macros: [original],
      macroKinds: [],
      otherPackages: [],
      active: true,
      entryPoolIds: ['entry-a']
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy macro original' }));

    expect(posted).toContainEqual({ type: 'copyMacro', name: 'original' });
    expect(posted).not.toContainEqual({ type: 'editMacro', name: 'original' });
  });

  it('hydrates every macro field in create mode while leaving the ID empty', () => {
    render(<CreateMacroApp />);
    sendMacroContext('create');

    const name = document.getElementById('m-name') as HTMLInputElement;
    expect(name.value).toBe('');
    expect(name.readOnly).toBe(false);

    expect(screen.getByRole('button', { name: /KaTeX template/ })).toBeTruthy();
    const styleGroup = screen.getByRole('group', { name: 'Styles' });
    expect(within(styleGroup).getByRole('button', { name: 'default' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Style tags/ }));
    for (const label of [
      'Remove tag 1',
      'Remove style compact',
      'Remove Entry source 1',
      'Remove URL source 1'
    ]) {
      const remove = screen.getByRole('button', { name: label });
      expect(remove.querySelector('svg[data-snl-icon="delete"]')).toBeTruthy();
    }

    for (const label of ['Left delimiter', 'Separator', 'Right delimiter']) {
      const field = screen.getByLabelText(label) as HTMLTextAreaElement;
      expect(field.tagName).toBe('TEXTAREA');
      expect(field.rows).toBeGreaterThanOrEqual(2);
      const previous = field.value;
      fireEvent.change(field, { target: { value: 'first line\nsecond line' } });
      expect(field.value).toBe('first line\nsecond line');
      fireEvent.change(field, { target: { value: previous } });
    }

    fireEvent.change(name, { target: { value: 'copy' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Macro/ }));

    const create = posted.find(
      (message): message is { type: string; macro: unknown } =>
        typeof message === 'object' && message !== null &&
        (message as { type?: string }).type === 'create'
    );
    expect(create?.macro).toEqual({ ...original, name: 'copy' });
  });

  it.each([
    { mode: 'create' as const, messageType: 'create', button: /Create Macro/ },
    { mode: 'edit' as const, messageType: 'update', button: /Update Macro/ }
  ])('preserves multiline dynamic delimiters through $mode submission and style switches', ({
    mode,
    messageType,
    button
  }) => {
    render(<CreateMacroApp />);
    sendMacroContext(mode);
    if (mode === 'create') {
      fireEvent.change(document.getElementById('m-name')!, { target: { value: 'multiline-copy' } });
    }

    const defaultValues = {
      left: '\\left(\n\\begin{aligned}',
      separator: '\\\\\n&',
      right: '\\end{aligned}\n\\right)'
    };
    fireEvent.change(screen.getByLabelText('Left delimiter'), {
      target: { value: defaultValues.left }
    });
    fireEvent.change(screen.getByLabelText('Separator'), {
      target: { value: defaultValues.separator }
    });
    fireEvent.change(screen.getByLabelText('Right delimiter'), {
      target: { value: defaultValues.right }
    });

    fireEvent.click(screen.getAllByText(/^compact$/).find((element) => element.tagName === 'BUTTON')!);
    const compactValues = {
      left: 'compact\nleft',
      separator: 'compact\nseparator',
      right: 'compact\nright'
    };
    fireEvent.change(screen.getByLabelText('Left delimiter'), {
      target: { value: compactValues.left }
    });
    fireEvent.change(screen.getByLabelText('Separator'), {
      target: { value: compactValues.separator }
    });
    fireEvent.change(screen.getByLabelText('Right delimiter'), {
      target: { value: compactValues.right }
    });

    fireEvent.click(screen.getAllByText(/default ★/).find((element) => element.tagName === 'BUTTON')!);
    expect((screen.getByLabelText('Left delimiter') as HTMLTextAreaElement).value)
      .toBe(defaultValues.left);
    expect((screen.getByLabelText('Separator') as HTMLTextAreaElement).value)
      .toBe(defaultValues.separator);
    expect((screen.getByLabelText('Right delimiter') as HTMLTextAreaElement).value)
      .toBe(defaultValues.right);

    fireEvent.click(screen.getByRole('button', { name: button }));
    const submitted = posted.find(
      (message): message is { type: string; macro: typeof original } =>
        typeof message === 'object' && message !== null &&
        (message as { type?: string }).type === messageType
    );
    expect(submitted).toBeDefined();
    const defaultStyle = submitted!.macro.styles.find((style) => style.style_name === 'default')!;
    const compactStyle = submitted!.macro.styles.find((style) => style.style_name === 'compact')!;
    expect(defaultStyle.template).toBe(`${defaultValues.left}#*${defaultValues.right}`);
    expect(defaultStyle.separator).toBe(defaultValues.separator);
    expect(compactStyle.template).toBe(`${compactValues.left}#*${compactValues.right}`);
    expect(compactStyle.separator).toBe(compactValues.separator);
  });

  it('keeps opaque style fields attached to their logical style after reordering', () => {
    render(<CreateMacroApp />);
    sendMacroContext('create');
    fireEvent.change(document.getElementById('m-name')!, { target: { value: 'reordered-copy' } });
    fireEvent.click(screen.getByTitle('Move earlier (toward default)'));
    fireEvent.click(screen.getByRole('button', { name: /Create Macro/ }));

    const submitted = posted.find(
      (message): message is { type: string; macro: typeof original } =>
        typeof message === 'object' && message !== null &&
        (message as { type?: string }).type === 'create'
    );
    expect(submitted).toBeDefined();
    expect(submitted!.macro.styles.map((style) => style.style_name)).toEqual(['compact', 'default']);
    expect(submitted!.macro.styles[0].custom_renderer).toEqual({
      engine: 'consumer-y', options: { compact: true }
    });
    expect(submitted!.macro.styles[1].custom_renderer).toEqual({
      engine: 'consumer-x', options: { compact: false }
    });
  });
});
