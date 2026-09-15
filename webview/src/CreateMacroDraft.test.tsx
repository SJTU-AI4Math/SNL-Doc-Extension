import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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




describe('SVG-R1 Macro receipt ordering', () => {
  it.each(['edit', 'create'] as const)('preserves post-submit SVG edits across %s success/context and remount', async (mode) => {
    const oldSource = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="old-art" d="M0 0h2v2z"/></svg>';
    const projection = { asset: { source: 'svg/original.svg', base_identity: 'workspace:.SNL_Doc/assets', revision: 'sha256:' + 'a'.repeat(64), request_epoch: 0 }, generation: 1, producer_revision: 'test', accessibility: { label: 'Saved label' } };
    const existing = { ...macro('Diagram.receipt', 'Original'), name: 'Diagram.receipt', styles: [{ style_name: 'default', tags: ['keep'], template: { mode: 'block', body: '#1 #0', block_template_name: 'svg_template', svg_template: projection } }] };
    const firstContext = mode === 'edit' ? context('edit', existing, 'r1') : { ...context('create', null), prefill: { macro: { ...existing, name: '' } } };
    const view = render(<CreateMacroApp />);
    send(firstContext);
    if (mode === 'create') fireEvent.change(document.getElementById('m-name')!, { target: { value: existing.name } });
    await act(async () => {
      for (const request of posted as Record<string, unknown>[]) {
        if (request.type === 'snl.assets/read-svg') send({ ...request, type: 'snl.assets/svg-source', value: oldSource });
      }
    });
    await waitFor(() => expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe(oldSource));
    fireEvent.click(screen.getByRole('button', { name: mode === 'edit' ? 'Update Macro' : 'Create Macro' }));
    const request = lastMutation()!;
    expect(request).toBeTruthy();
    const newer = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g data-snl-slot="1"/><path id="new-art" d="M0 0h5v5z"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: newer } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'New label' } });
    fireEvent.change(screen.getByLabelText('Slot index'), { target: { value: '3' } });
    fireEvent.change(screen.getByPlaceholderText('Short human-readable description'), { target: { value: 'New description' } });
    expect(JSON.stringify(webviewState)).toContain('New label');
    const beforeWrongReceipt = JSON.stringify(webviewState);
    send({ type: mode === 'edit' ? 'updated' : 'created', name: existing.name, requestId: 'wrong-request', committedRevision: 'wrong-revision' });
    expect(JSON.stringify(webviewState)).toBe(beforeWrongReceipt);
    send({ type: mode === 'edit' ? 'updated' : 'created', name: existing.name, requestId: request.requestId });
    expect(JSON.stringify(webviewState)).toBe(beforeWrongReceipt); // No revision is not a commit receipt.
    send({ type: mode === 'edit' ? 'updated' : 'created', name: existing.name, requestId: request.requestId, committedRevision: 'r2' });
    expect(JSON.stringify(webviewState)).toContain('r2'); // terminal alone persists CAS
    send({ ...context('edit', { ...existing, description: 'External R3' }, 'r3'), savedRequestId: request.requestId });
    const check = (): void => {
      expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe(newer);
      expect((screen.getByLabelText('Accessibility label') as HTMLInputElement).value).toBe('New label');
      expect((screen.getByLabelText('Slot index') as HTMLInputElement).value).toBe('3');
      expect((screen.getByPlaceholderText('Short human-readable description') as HTMLInputElement).value).toBe('New description');
      expect(screen.getByTestId('svg-macro-preview').querySelector('#new-art')).toBeTruthy();
      expect(screen.getByTestId('svg-macro-preview').querySelector('[data-snl-slot="1"]')).toBeTruthy();
      expect(JSON.stringify(webviewState)).toContain('"saved":false');
      expect(JSON.stringify(webviewState)).toContain('r2');
      expect((screen.getByRole('button', { name: 'Update Macro' }) as HTMLButtonElement).disabled).toBe(true);
    };
    check();
    send({ type: mode === 'edit' ? 'updated' : 'created', name: existing.name, requestId: request.requestId, committedRevision: 'replayed-revision' });
    check(); // A replay cannot clear the surviving generation.
    expect(Object.keys(webviewState as object).filter(key => key.includes('macro:create:'))).toEqual([]);
    view.unmount(); render(<CreateMacroApp />);
    send(context('edit', existing, 'r3'));
    check();
    expect((document.getElementById('m-name') as HTMLInputElement).readOnly).toBe(true);
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

// D01: complete original cell 65cc81cfbb1f5017; only digest syntax updated.
describe('historical opaque SVG draft', () => {
  it('preserves opaque svg_template through edit, draft persistence, and save', () => {
    const svgTemplate = {
      asset: { source: 'diagrams/proof.svg', base_identity: 'workspace:.SNL_Doc/assets', revision: 'sha256:' + 'a'.repeat(64), request_epoch: 3 },
      generation: 2, producer_revision: 'renderer-v1', accessibility: { label: 'Diagram' },
      formula_embed: { total_height_em: 2, baseline_ratio: 0.7 }
    };
    const existing = macro('diagram', 'original');
    (existing.styles as Array<Record<string, unknown>>)[0].template = {
      mode: 'block', body: '#0', block_template_name: 'svg_template', svg_template: svgTemplate
    };
    const first = render(<CreateMacroApp />);
    send(context('edit', existing, 'revision-svg'));
    fireEvent.change(screen.getByPlaceholderText('Short human-readable description'), { target: { value: 'changed' } });
    first.unmount();
    render(<CreateMacroApp />);
    send(context('edit', existing, 'revision-new'));
    expect(screen.getByRole('button', { name: 'Update Macro' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Update Macro' }));
    expect(lastMutation()).toMatchObject({
      expectedRevision: 'revision-svg',
      macro: { styles: [{ style_name: 'default', template: { svg_template: svgTemplate } }] }
    });
  });
});
