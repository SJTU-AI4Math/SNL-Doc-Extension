import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply_preferences_snapshot } from './runtime/preferencesRuntime';

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };
  return { ...actual, getVsCodeApi: () => api, useVsCodeApiRef: () => ({ current: api }) };
});
const { CreateMacroApp } = await import('./CreateMacroApp');

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}
function textMacro(name: string, template: unknown): Record<string, unknown> {
  return {
    name, description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
    styles: [{ style_name: 'default', tags: [], template }]
  };
}
function context(mode: 'create' | 'edit', existing: Record<string, unknown> | null): Record<string, unknown> {
  return {
    type: 'context', mode, targetId: mode === 'edit' ? existing?.name : undefined,
    file: 'algebra.json', packageName: 'Algebra', existingNames: existing ? [existing.name] : [],
    macroCandidates: [], macroKinds: [], entries: [], prefill: null, existing
  };
}
function chooseLanguage(current: RegExp, option: RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: current }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

beforeEach(() => {
  document.documentElement.lang = 'en';
  apply_preferences_snapshot({
    type: 'snl.preferences/snapshot', generation: 'macro-retarget-phase-b', revision: 1,
    preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
    supported_languages: [
      { id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }
    ]
  });
});
afterEach(cleanup);

describe('Macro localized edit scope target lifecycle', () => {
  it('retains manual language on same-target refresh and resets on A to B retarget', async () => {
    const macroA = textMacro('Macro.A', {
      type: 'i18n', default_language: 'en',
      values: { en: { mode: 'text', body: 'A EN' }, 'zh-CN': { mode: 'text', body: 'A ZH' } }
    });
    render(<CreateMacroApp />);
    send(context('edit', macroA));
    await waitFor(() => expect(screen.getByRole('button', { name: /Language: English/ })).toBeTruthy());
    chooseLanguage(/Language: English/, /简体中文/);
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();

    send(context('edit', macroA));
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();

    send(context('edit', textMacro('Macro.B', { mode: 'text', body: 'B GENERAL' })));
    await waitFor(() => expect(screen.getByRole('button', { name: /Language: General/ })).toBeTruthy());
  });

  it('resets manual language on create to edit identity transition', async () => {
    render(<CreateMacroApp />);
    send(context('create', null));
    const textModes = screen.getAllByRole('button', { name: 'Text (I18N)' });
    fireEvent.click(textModes[textModes.length - 1]);
    chooseLanguage(/Language: General/, /简体中文/);
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();

    send(context('edit', textMacro('Macro.Created', { mode: 'text', body: 'CREATED GENERAL' })));
    await waitFor(() => expect(screen.getByRole('button', { name: /Language: General/ })).toBeTruthy());
  });
});
