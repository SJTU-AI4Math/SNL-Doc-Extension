import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posted: unknown[] = [];

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  return {
    ...actual,
    getVsCodeApi: () => ({
      postMessage: (message: unknown) => { posted.push(message); },
      getState: () => undefined,
      setState: () => undefined
    })
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
  source: { entries: ['entry-a'], urls: ['https://example.com/source'] },
  kind: 'operator',
  dynamic_arity: true,
  tags: ['macro-tag'],
  styles: [
    {
      style_name: 'default',
      mode: 'formula_display',
      template: '\\left(#*\\right)',
      separator: ', ',
      tags: ['style-tag'],
      typst: { built_in: 'sum', synthesis: { mode: 'formula', macro: 'sum(#*)' } },
      latex: { built_in: '\\sum', synthesis: { mode: 'text', macro: 'sum #*' } },
      markdown: '**#***',
      text: 'items: #*'
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
      text: 'compact'
    }
  ]
};

describe('Copy Macro', () => {
  it('posts the copied macro name from the correct package-row action', () => {
    render(<PackagePanelApp />);
    send({
      type: 'package',
      pkg: { version: '7', name: 'Algebra', macros: {} },
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
    send({
      type: 'context',
      mode: 'create',
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
      existing: null,
      entries: [{ id: 'entry-a', title: 'Entry A', hasContent: true }],
      prefill: { macro: original }
    });

    const name = document.getElementById('m-name') as HTMLInputElement;
    expect(name.value).toBe('');
    expect(name.readOnly).toBe(false);

    fireEvent.change(name, { target: { value: 'copy' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Macro/ }));

    const create = posted.find(
      (message): message is { type: string; macro: unknown } =>
        typeof message === 'object' && message !== null &&
        (message as { type?: string }).type === 'create'
    );
    expect(create?.macro).toEqual({ ...original, name: 'copy' });
  });
});
