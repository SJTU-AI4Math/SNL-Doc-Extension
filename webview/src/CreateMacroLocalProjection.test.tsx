import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VsCodeApi } from './vscodeApi';
import { loadDraft } from './components/draftState';

const state = vi.hoisted(() => ({ stored: undefined as unknown, posted: vi.fn() }));
vi.mock('./vscodeApi', async (importOriginal) => {
  const api: VsCodeApi = {
    postMessage: state.posted,
    getState: () => state.stored,
    setState: (next) => { state.stored = next; }
  };
  return { ...(await importOriginal<typeof import('./vscodeApi')>()),
    getVsCodeApi: () => api, useVsCodeApiRef: () => ({ current: api }) };
});

import { CreateMacroApp } from './CreateMacroApp';
import { getVsCodeApi } from './vscodeApi';
import { apply_preferences_snapshot, get_content_language, set_content_language } from './runtime/preferencesRuntime';

interface StoredDraft {
  styles: Array<{ style_name: string; template_localized: unknown }>;
}

const existing = {
  name: 'Local.preview', description: '', source: { entries: [], urls: [] },
  dynamic_arity: false, tags: [],
  styles: [
    {
      style_name: 'default', tags: [],
      template: {
        type: 'i18n', default_language: 'en',
        values: {
          en: { mode: 'text', body: 'DEFAULT-EN #0', projection_extension: 'EN' },
          'zh-CN': { mode: 'text', body: 'DEFAULT-ZH #0', projection_extension: 'ZH' }
        }
      }
    },
    {
      // A different Style owns its own arity, not a Macro-wide contract.
      style_name: 'compact', tags: [],
      template: {
        type: 'i18n', default_language: 'zh-CN',
        values: {
          en: { mode: 'formula_inline', body: '\\text{COMPACT-EN} #0 + #1' },
          'zh-CN': { mode: 'text', body: 'COMPACT-ZH #0 and #1' }
        }
      }
    }
  ]
};

function chooseLanguage(name: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: /^Language:/ }));
  fireEvent.click(screen.getByRole('option', { name }));
}

afterEach(() => {
  cleanup();
  state.stored = undefined;
  state.posted.mockReset();
  document.documentElement.lang = 'en';
  set_content_language('en');
});

it('renders the locally selected whole template without changing outer locale or stored maps', async () => {
  apply_preferences_snapshot({
    type: 'snl.preferences/snapshot', generation: 'local-projection', revision: 1,
    preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
    supported_languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }]
  });
  act(() => set_content_language('en'));
  const view = render(<CreateMacroApp />);
  act(() => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
    existingNames: [existing.name], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
    existing: structuredClone(existing), macroRevision: 'macro-r1'
  } })));
  const body = (): string => {
    const canvas = view.container.querySelector('.snl-preview-canvas')?.cloneNode(true) as HTMLElement | undefined;
    canvas?.querySelectorAll('style, annotation, .katex-mathml').forEach((element) => element.remove());
    return canvas?.textContent ?? '';
  };
  await waitFor(() => expect(body()).toContain('DEFAULT-EN'));
  // Make an unrelated field dirty so the real persistence seam contains full maps.
  fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), { target: { value: 'Local.preview.renamed' } });
  const draft = (): StoredDraft => {
    const key = Object.keys(state.stored as object).find((key) => key.startsWith('editor-draft:macro:'))!;
    return loadDraft<StoredDraft>(getVsCodeApi(), key)!;
  };
  await waitFor(() => expect(draft()?.styles).toHaveLength(2));
  const storedMaps = structuredClone(draft().styles.map((style) => style.template_localized));
  const input = structuredClone(existing);
  state.posted.mockClear();

  chooseLanguage(/简体中文/);
  await waitFor(() => {
    expect(body()).toContain('DEFAULT-ZH');
    expect(body()).not.toContain('DEFAULT-EN');
  });
  chooseLanguage(/English/);
  await waitFor(() => {
    expect(body()).toContain('DEFAULT-EN');
    expect(body()).not.toContain('DEFAULT-ZH');
  });
  fireEvent.click(screen.getByRole('button', { name: 'compact' }));
  await waitFor(() => {
    expect(body()).toContain('COMPACT-ZH');
    expect(body()).not.toContain('DEFAULT-EN');
  });
  chooseLanguage(/English/);
  await waitFor(() => {
    expect(body()).toContain('COMPACT-EN');
    expect(body()).not.toContain('COMPACT-ZH');
  });
  chooseLanguage(/简体中文/);
  await waitFor(() => expect(body()).toContain('COMPACT-ZH'));
  fireEvent.click(screen.getByRole('button', { name: 'default' }));
  await waitFor(() => expect(body()).toContain('DEFAULT-EN'));

  expect(get_content_language()).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(screen.getByRole('button', { name: /Update Macro/ })).toHaveProperty('disabled', false);
  expect(state.posted).not.toHaveBeenCalled();
  expect(draft().styles.map((style) => style.template_localized)).toEqual(storedMaps);
  expect(existing).toEqual(input);
});
