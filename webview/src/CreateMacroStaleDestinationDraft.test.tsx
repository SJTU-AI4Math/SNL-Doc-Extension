import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorDraftKey } from './components/draftState';

const harness = vi.hoisted(() => ({
  posted: [] as unknown[],
  state: {} as Record<string, unknown>
}));

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = {
    postMessage: (message: unknown) => { harness.posted.push(message); },
    getState: () => harness.state,
    setState: (state: unknown) => { harness.state = state as Record<string, unknown>; }
  };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { CreateMacroApp } = await import('./CreateMacroApp');

afterEach(cleanup);
beforeEach(() => {
  harness.posted.length = 0;
  harness.state = {};
});

function send(message: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data: message })));
}

describe('Macro create-to-edit destination drafts', () => {
  it('discards a stale deleted-macro edit draft so recreated values and revision win', () => {
    const file = 'algebra.json';
    const name = 'recreated';
    harness.state[editorDraftKey('macro', 'edit', `${file}\u0000${name}`)] = {
      name,
      description: 'STALE DELETED DRAFT',
      sourceEntries: [''],
      sourceUrls: [''],
      dynamicArity: false,
      macroTags: [],
      kind: '',
      styles: [{
        extensions: {}, typst_extensions: {}, typst_synthesis_extensions: {},
        latex_extensions: {}, latex_synthesis_extensions: {}, style_name: 'default',
        mode: 'text', template: 'STALE TEMPLATE', template_left: '', separator: '',
        template_right: '', block_template_name: '', tags: [], typst_built_in: '',
        typst_synthesis: '', typst_synthesis_mode: 'formula', latex_built_in: '',
        latex_synthesis: '', latex_synthesis_mode: 'formula', markdown: '', text: ''
      }],
      defaultStyle: { en: 'default' },
      originalRevision: 'stale-revision'
    };

    render(<CreateMacroApp />);
    send({
      type: 'context', mode: 'create', file, packageName: 'Algebra', existingNames: [],
      macroCandidates: [], workspaceMacros: {}, macroKinds: [], entries: [], existing: null, prefill: null
    });
    send({ type: 'created', name });
    send({
      type: 'context', mode: 'edit', targetState: 'found', targetId: name, file,
      packageName: 'Algebra', existingNames: [name], macroCandidates: [], workspaceMacros: {},
      macroKinds: [], entries: [], prefill: null, macroRevision: 'fresh-revision',
      existing: {
        name, description: 'FRESHLY CREATED', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [],
        styles: [{ style_name: 'default', mode: 'text', template: 'FRESH TEMPLATE', tags: [] }]
      }
    });

    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toBe('FRESHLY CREATED');
    fireEvent.click(screen.getByRole('button', { name: /Update Macro/ }));
    expect(harness.posted).toContainEqual(expect.objectContaining({
      type: 'update',
      expectedRevision: 'fresh-revision',
      macro: expect.objectContaining({ description: 'FRESHLY CREATED' })
    }));
  });
});