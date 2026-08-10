import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';

const postMessage = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.lang = 'en';
});

describe('CreateEntryApp Inductive Macro Kind coloring', () => {
  it('renders host Macro Kind colors through the real context and Macro query chain', async () => {
    document.documentElement.lang = 'en';
    vi.stubGlobal('acquireVsCodeApi', () => ({
      postMessage,
      getState: () => undefined,
      setState: () => undefined
    }));
    const view = render(<CreateEntryApp />);

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context',
        targetGeneration: 0,
        mode: 'edit',
        id: 'colored-entry',
        kinds: [{
          id: 'definition',
          name: 'Definition',
          coloring: {
            light: { stroke: '#555555', background: '#eeeeee' },
            dark: { stroke: '#888888', background: '#222222' }
          },
          numbering: '1',
          style: 'default'
        }],
        macros: {
          colored: {
            name: 'colored',
            description: '',
            source: { entries: [], urls: [] },
            kind: 'custom-kind',
            dynamic_arity: false,
            styles: [{
              style_name: 'default', mode: 'formula_inline', template: 'C', tags: []
            }],
            tags: []
          }
        },
        macroKinds: [{
          id: 'custom-kind',
          name: 'Custom kind',
          description: '',
          coloring: {
            light: { stroke: '#123456', background: '#abcdef' },
            dark: { stroke: '#fedcba', background: '#654321' }
          }
        }],
        macroOrigin: { colored: 'core' },
        existing: {
          id: 'colored-entry',
          package: '_unpackaged',
          title: 'Colored entry',
          kind: 'definition',
          content: { snl: 'colored' }
        },
        existingIds: [{ id: 'colored-entry', title: 'Colored entry', hasContent: true }],
        entryPackages: ['_unpackaged'],
        relationships: []
      }
    }));

    fireEvent.click(await view.findByRole('button', { name: 'GUI Editor (Inductive)' }));
    const macroInput = await waitFor(() => {
      const input = view.getAllByRole('textbox')
        .find((candidate) => (candidate as HTMLInputElement).value === 'colored');
      expect(input).toBeTruthy();
      return input as HTMLInputElement;
    });
    await waitFor(() => expect(macroInput.title).toContain('custom-kind'));
    expect(macroInput.style.borderColor).toBe('rgb(254, 220, 186)');
    expect(macroInput.closest<HTMLElement>('[data-macro-id-control="true"]')!.style.background)
      .toBe('rgba(101, 67, 33, 0.18)');
    const row = macroInput.closest<HTMLElement>('.snl-tree-row')!;
    expect(row.style.borderColor).toBe('rgb(254, 220, 186)');
    expect(row.style.background).toBe('rgba(101, 67, 33, 0.18)');
  });
});
