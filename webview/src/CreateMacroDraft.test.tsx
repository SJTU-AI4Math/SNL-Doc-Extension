import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let webviewState: unknown;
const posted: unknown[] = [];
const api = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => webviewState,
  setState: (next: unknown) => { webviewState = next; }
};

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { CreateMacroApp } = await import('./CreateMacroApp');

function macro(name: string, description: string, template = '\\host'): Record<string, unknown> {
  return {
    name,
    description,
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    tags: [],
    styles: [{
      style_name: 'default',
      template: { mode: 'formula_inline', body: template },
      tags: []
    }]
  };
}

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

function context(
  mode: 'create' | 'edit',
  existing: Record<string, unknown> | null,
  revision?: string
): Record<string, unknown> {
  return {
    type: 'context',
    mode,
    file: 'algebra.json',
    packageName: 'Algebra',
    existingNames: existing ? [existing.name] : [],
    macroCandidates: [],
    macroKinds: [],
    entries: [],
    existing,
    macroRevision: revision,
    prefill: null
  };
}

function lastMutation(): Record<string, unknown> | undefined {
  return [...posted].reverse().find((message): message is Record<string, unknown> => {
    if (typeof message !== 'object' || message === null) return false;
    const type = (message as { type?: unknown }).type;
    return type === 'create' || type === 'update';
  });
}

afterEach(cleanup);
beforeEach(() => {
  webviewState = undefined;
  posted.length = 0;
});

describe('Create Macro persisted drafts', () => {
  it('restores a create draft after a full unmount/remount', () => {
    const first = render(<CreateMacroApp />);
    send(context('create', null));

    fireEvent.change(document.getElementById('m-name')!, { target: { value: 'Draft.macro' } });
    fireEvent.change(screen.getByPlaceholderText('Short human-readable description'), {
      target: { value: 'draft description' }
    });
    fireEvent.change(screen.getByPlaceholderText(/\\frac/), { target: { value: '\\draft' } });
    first.unmount();

    render(<CreateMacroApp />);
    send(context('create', null));

    expect((document.getElementById('m-name') as HTMLInputElement).value).toBe('Draft.macro');
    expect((screen.getByPlaceholderText('Short human-readable description') as HTMLInputElement).value)
      .toBe('draft description');
    expect((screen.getByPlaceholderText(/\\frac/) as HTMLTextAreaElement).value).toBe('\\draft');
  });

  it('opens the new-kind panel once for the native input/change pair', () => {
    render(<CreateMacroApp />);
    send(context('create', null));
    const kind = document.getElementById('m-kind') as HTMLSelectElement;

    fireEvent.input(kind, { target: { value: '__new__' } });
    fireEvent.change(kind);

    expect(posted.filter((message) =>
      typeof message === 'object' && message !== null &&
      (message as { type?: unknown }).type === 'createMacroKind'
    )).toHaveLength(1);
  });

  it('keeps a restored edit draft through host refresh and submits its original revision', () => {
    const first = render(<CreateMacroApp />);
    send(context('edit', macro('FOL.forall', 'original'), 'revision-original'));
    fireEvent.change(screen.getByPlaceholderText('Short human-readable description'), {
      target: { value: 'restored draft' }
    });
    first.unmount();

    render(<CreateMacroApp />);
    send(context('edit', macro('FOL.forall', 'new host value'), 'revision-new'));
    send(context('edit', macro('FOL.forall', 'newer host refresh'), 'revision-newer'));

    expect((screen.getByPlaceholderText('Short human-readable description') as HTMLInputElement).value)
      .toBe('restored draft');
    fireEvent.click(screen.getByRole('button', { name: 'Update Macro' }));

    expect(lastMutation()).toMatchObject({
      type: 'update',
      expectedRevision: 'revision-original',
      macro: { name: 'FOL.forall', description: 'restored draft' }
    });
  });
});


describe('SVG Macro editor forward port', () => {
  it('opens the production SVG editor without losing title, tags or slot body', () => {
    render(<CreateMacroApp />);
    const existing = { ...macro('Diagram.square', 'Keep title', '#0 #1'), tags: ['keep'], styles: [{ style_name: 'default', tags: ['style-tag'], template: { mode: 'block', body: '#0 #1', block_template_name: 'svg_template' } }] };
    send(context('edit', existing, 'original-revision'));
    expect(screen.getByRole('region', { name: 'SVG Macro editor' })).toBeTruthy();
    expect((screen.getByPlaceholderText('Short human-readable description') as HTMLInputElement).value).toBe('Keep title');
    fireEvent.click(screen.getByRole('button', { name: 'Update Macro' }));
    expect(lastMutation()).toMatchObject({ expectedRevision: 'original-revision', macro: { tags: ['keep'], styles: [{ tags: ['style-tag'], template: { body: '#0 #1' } }] } });
  });
});


describe('unsaved SVG drafts', () => {
  it('retains SVG source and loaded artwork across refresh and full remount', () => {
    const existing = { ...macro('Diagram.square', 'Keep title', '#0 #1'), styles: [{ style_name: 'default', tags: [], template: { mode: 'block', body: '#0 #1', block_template_name: 'svg_template' } }] };
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-snl-slot="1"/></svg>';
    const view = render(<CreateMacroApp />);
    send(context('edit', existing, 'revision-original'));
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: source } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'draft-art' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'My title' } });
    send(context('edit', existing, 'revision-new'));
    view.unmount();
    render(<CreateMacroApp />);
    send(context('edit', existing, 'revision-newer'));
    expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe(source);
    expect((screen.getByLabelText('Asset name') as HTMLInputElement).value).toBe('draft-art');
    expect((screen.getByLabelText('Accessibility label') as HTMLInputElement).value).toBe('My title');
    expect(screen.getByTestId('svg-macro-preview').querySelector('[data-snl-slot="1"]')).toBeTruthy();
    const update = screen.getByRole('button', { name: 'Update Macro' }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    fireEvent.click(update);
    expect(lastMutation()).toBeUndefined();
    expect(JSON.stringify(webviewState)).toContain('revision-original');
  });
});
