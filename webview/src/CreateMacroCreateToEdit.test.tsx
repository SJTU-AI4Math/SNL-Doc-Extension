import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Webview half of the create->edit flip (cat 2026-07-27).
 *
 * The host, after a successful create, posts `created` and then a context
 * with mode:'edit' + a populated `existing`. This pins that the panel then
 * (a) renders as Edit, (b) makes the Name field readonly, (c) labels the
 * submit button "Update Macro", (d) does NOT disable Save even though the
 * new name is now in `existingNames` (the self-duplicate bug), and (e)
 * posts `{type:'update'}` on the next save.
 */

const posted: unknown[] = [];

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = {
    postMessage: (m: unknown) => { posted.push(m); },
    getState: () => undefined,
    setState: () => undefined
  };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { CreateMacroApp } = await import('./CreateMacroApp');

afterEach(cleanup);
beforeEach(() => { posted.length = 0; });

function send(msg: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const existing = {
  name: 'foo',
  styles: [
    {
      style_name: 'default',
      template: { mode: 'formula_inline', body: '\\foo' },

      tags: []
    }
  ]
};

function editContext(): unknown {
  return {
    type: 'context',
    mode: 'edit',
    file: 'algebra.json',
    packageName: 'algebra',
    // The trap: the freshly created name is here.
    existingNames: ['foo'],
    macroCandidates: [],
    macroKinds: [],
    existing,
    entries: [],
    prefill: null
  };
}

describe('Create Macro panel flips to Edit after create', () => {
  it('renders edit UI and keeps Save enabled despite the self-duplicate', () => {
    render(<CreateMacroApp />);
    send({
      type: 'context',
      mode: 'create',
      file: 'algebra.json',
      packageName: 'algebra',
      existingNames: [],
      macroCandidates: [],
      macroKinds: [],
      existing: null,
      entries: [],
      prefill: null
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent)
      .toContain('Create Macro');

    // Host: create succeeded, then flipped and re-pushed context.
    send({ type: 'created', name: 'foo' });
    send(editContext());

    expect(screen.getByRole('heading', { level: 1 }).textContent)
      .toContain('Edit Macro');

    const nameInput = document.getElementById('m-name') as HTMLInputElement;
    expect(nameInput.readOnly).toBe(true);
    expect(nameInput.value).toBe('foo');

    const submit = screen.getByRole('button', { name: /Update Macro/ }) as HTMLButtonElement;
    // The isDuplicate regression would leave this disabled forever.
    expect(submit.disabled).toBe(false);
  });

  it('posts type:"update" on the second save, not another create', () => {
    render(<CreateMacroApp />);
    send(editContext());

    const submit = screen.getByRole('button', { name: /Update Macro/ });
    fireEvent.click(submit);

    const save = posted.find(
      (m): m is { type: string } =>
        typeof m === 'object' && m !== null &&
        ((m as { type?: string }).type === 'update' ||
          (m as { type?: string }).type === 'create')
    );
    expect(save?.type).toBe('update');
  });
});
