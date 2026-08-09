import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const { BlockRendererPresetControl, CreateMacroApp } = await import('./CreateMacroApp');

afterEach(() => {
  cleanup();
  posted.length = 0;
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

  it('edits a local text-template language without changing the interface language', () => {
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

    const textModeButtons = screen.getAllByRole('button', { name: 'Text' });
    fireEvent.click(textModeButtons[textModeButtons.length - 1]);
    const language = screen.getByRole('button', { name: /Language: English/ });
    expect(language.querySelector('svg[data-language-icon="en"]')).toBeTruthy();
    fireEvent.click(language);
    const languageMenu = screen.getByRole('listbox', { name: 'Language' });
    expect(languageMenu.style.left).toBe('0px');
    expect(languageMenu.style.right).toBe('auto');
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByRole('heading', { level: 1, name: 'Create Macro in Algebra' })).toBeTruthy();

    const preview = screen.getByRole('button', { name: 'Argument overrides during preview' });
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Reset all args' })).toBeNull();
    fireEvent.click(preview);
    expect(screen.getByRole('button', { name: 'Reset all args' })).toBeTruthy();
  });

  it('keeps a fixed formula Template when enabling dynamic arity', () => {
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
    const template = screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!;
    fireEvent.change(template, { target: { value: '#0 + #1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dynamic Arity' }));
    expect((screen.getByLabelText('Left delimiter') as HTMLTextAreaElement).value).toBe('#0 + #1');
  });

  it('requires confirmation before discarding translations on a structural mode switch', () => {
    document.documentElement.lang = 'en';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
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

    const textModes = screen.getAllByRole('button', { name: 'Text' });
    fireEvent.click(textModes[textModes.length - 1]);
    const template = screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!;
    fireEvent.change(template, { target: { value: 'English text' } });
    const language = screen.getByRole('button', { name: /Language: English/ });
    fireEvent.click(language);
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    fireEvent.change(template, { target: { value: '中文文本' } });

    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    expect(screen.queryByRole('button', { name: /Language:/ })).toBeNull();
    confirm.mockRestore();
  });

  it('carries the selected localized dynamic projection into structural delimiters', () => {
    document.documentElement.lang = 'en';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CreateMacroApp />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
          existingNames: ['Dynamic.localized'], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
          existing: {
            name: 'Dynamic.localized', description: '', source: { entries: [], urls: [] },
            dynamic_arity: true, tags: [],
            styles: [{
              style_name: 'default', mode: 'text', tags: [],
              template: {
                type: 'i18n', default_language: 'en',
                values: { en: 'English #*', 'zh-CN': '中文 #*' }
              }
            }]
          }
        }
      }));
    });
    fireEvent.click(screen.getByRole('button', { name: /Language: English/ }));
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    expect((screen.getByLabelText('Left delimiter') as HTMLTextAreaElement).value).toBe('中文 ');
    fireEvent.click(screen.getByRole('button', { name: /Update Macro/ }));
    const update = posted.find((message): message is { type: string; macro: { kind: string; styles: Array<{ template: unknown }> } } =>
      typeof message === 'object' && message !== null && (message as { type?: string }).type === 'update');
    expect(update?.macro.kind).toBe('const');
    expect(update?.macro.styles[0].template).toBe('中文 #*');
    confirm.mockRestore();
  });
});
