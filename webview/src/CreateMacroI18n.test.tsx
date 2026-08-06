import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = {
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined
  };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { BlockRendererPresetControl, CreateMacroApp } = await import('./CreateMacroApp');

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('Create Macro localization', () => {
  it('renders the macro creation form in Chinese while preserving technical tokens', () => {
    document.documentElement.lang = 'zh-CN';
    render(<CreateMacroApp />);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'context',
          mode: 'create',
          file: 'algebra.json',
          packageName: 'Algebra',
          existingNames: [],
          macroCandidates: [],
          macroKinds: [],
          existing: null,
          entries: [],
          prefill: null
        }
      }));
    });

    expect(screen.getByRole('heading', { level: 1, name: '在 Algebra 中创建宏' })).toBeTruthy();
    expect(screen.getByText('名称')).toBeTruthy();
    expect(screen.getByText('种类')).toBeTruthy();
    expect(screen.getByText('说明')).toBeTruthy();
    expect(screen.getByText('样式')).toBeTruthy();
    expect(screen.getByText('预览参数覆盖')).toBeTruthy();
    expect(screen.getByText('宏标签')).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建宏' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^KaTeX 模板/ })).toBeTruthy();
    expect(screen.getByText(/#0、#1、…/)).toBeTruthy();
  });

  it('renders block preset LaTeX examples as literals instead of message parameters', () => {
    document.documentElement.lang = 'zh-CN';
    render(<BlockRendererPresetControl value="list" onChange={() => undefined} />);
    expect(screen.getByText(/\\begin\{itemize\}/)).toBeTruthy();
  });

  it('starts I18N and preview overrides collapsed and uses paired language/style selectors', () => {
    document.documentElement.lang = 'en';
    render(<CreateMacroApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
          existingNames: [], macroCandidates: [], macroKinds: [], existing: null,
          entries: [], prefill: null
        }
      }));
    });

    const i18n = screen.getByRole('button', { name: 'Default style by language' });
    expect(i18n.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /Language: English/ })).toBeNull();
    fireEvent.click(i18n);
    const language = screen.getByRole('button', { name: /Language: English/ });
    expect(language.querySelector('svg[data-language-icon="en"]')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Default style for English/ })).toBeTruthy();
    fireEvent.click(language);
    const languageMenu = screen.getByRole('listbox', { name: 'Language' });
    expect(languageMenu.style.left).toBe('0px');
    expect(languageMenu.style.right).toBe('auto');
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    expect(screen.getByRole('combobox', { name: /Default style for 简体中文/ })).toBeTruthy();

    const preview = screen.getByRole('button', { name: 'Argument overrides during preview' });
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Reset all args' })).toBeNull();
    fireEvent.click(preview);
    expect(screen.getByRole('button', { name: 'Reset all args' })).toBeTruthy();
  });
});
