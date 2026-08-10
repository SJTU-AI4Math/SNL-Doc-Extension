import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';


const posted: unknown[] = [];
let webviewState: unknown;

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = {
    postMessage: (message: unknown) => { posted.push(message); },
    getState: () => webviewState,
    setState: (state: unknown) => { webviewState = state; }
  };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { BlockRendererPresetControl, CreateMacroApp } = await import('./CreateMacroApp');
const { apply_preferences_snapshot } = await import('./runtime/preferencesRuntime');

afterEach(() => {
  cleanup();
  posted.length = 0;
  webviewState = undefined;
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

  it('lets a new empty style switch directly to block mode and preview a preset', () => {
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
    fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Figure' }
    });
    const blockModes = screen.getAllByRole('button', { name: 'Block' });
    fireEvent.click(blockModes[blockModes.length - 1]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Render preset' }), {
      target: { value: 'image' }
    });
    expect(screen.getByRole('textbox', { name: 'Image path' })).toBeTruthy();
    expect(screen.queryByText('SNL Macro Preview')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Image path is required');
    expect(screen.getByRole('button', { name: 'Create Macro' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('KaTeX template is required.')).toBeNull();
  });

  it('restores an invalid visible image-path draft after the webview remounts', () => {
    document.documentElement.lang = 'en';
    const context = {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: [], macroCandidates: [], macroKinds: [], existing: null,
      entries: [], prefill: null
    };
    const first = render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: context })));
    fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Figure' }
    });
    const blockModes = screen.getAllByRole('button', { name: 'Block' });
    fireEvent.click(blockModes[blockModes.length - 1]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Render preset' }), {
      target: { value: 'image' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Image path' }), {
      target: { value: '../outside.png' }
    });
    expect(screen.getByRole('textbox', { name: 'Image path' })).toHaveProperty(
      'value', '../outside.png'
    );
    first.unmount();

    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: context })));
    expect(screen.getByRole('textbox', { name: 'Image path' })).toHaveProperty(
      'value', '../outside.png'
    );
    expect(screen.getByRole('alert').textContent).toContain('.SNL_Doc/assets');
    expect(screen.getByRole('button', { name: 'Create Macro' })).toHaveProperty('disabled', true);
  });

  it('edits preset-specific enumerate and image parameters', () => {
    document.documentElement.lang = 'en';
    const onEnumerate = vi.fn();
    const enumerate = render(
      <BlockRendererPresetControl value="enumerate" onChange={onEnumerate} />
    );
    fireEvent.change(enumerate.getByRole('combobox', { name: 'Numbering' }), {
      target: { value: 'lower-alpha' }
    });
    expect(onEnumerate).toHaveBeenLastCalledWith(
      'snl-ext-preset:v1:enumerate?marker=lower-alpha'
    );
    enumerate.unmount();

    const onImage = vi.fn();
    const image = render(<BlockRendererPresetControl value="image" onChange={onImage} />);
    const pathInput = image.getByRole('textbox', { name: 'Image path' });
    fireEvent.change(pathInput, { target: { value: 'figures/' } });
    expect(pathInput).toHaveProperty('value', 'figures/');
    expect(image.getByRole('alert').textContent).toContain('.SNL_Doc/assets');
    expect(onImage).toHaveBeenLastCalledWith('image');
    fireEvent.change(pathInput, { target: { value: '../secret.png' } });
    expect(image.getByRole('alert')).toBeTruthy();
    expect(onImage).toHaveBeenLastCalledWith('image');
    fireEvent.change(pathInput, {
      target: { value: 'figures/diagram.png' }
    });
    expect(onImage).toHaveBeenLastCalledWith(
      'snl-ext-preset:v1:image?src=figures%2Fdiagram.png&layout=block&alt=diagram.png'
    );
    image.rerender(
      <BlockRendererPresetControl
        value="snl-ext-preset:v1:image?src=figures%2Fdiagram.png&layout=block&alt=diagram.png"
        onChange={onImage}
      />
    );
    fireEvent.change(image.getByRole('textbox', { name: 'Image alt text' }), {
      target: { value: 'Proof diagram' }
    });
    expect(onImage).toHaveBeenLastCalledWith(
      'snl-ext-preset:v1:image?src=figures%2Fdiagram.png&layout=block&alt=Proof%20diagram'
    );
    image.rerender(
      <BlockRendererPresetControl
        value="snl-ext-preset:v1:image?src=figures%2Fdiagram.png&layout=block&alt=Proof%20diagram"
        onChange={onImage}
      />
    );
    fireEvent.change(image.getByRole('combobox', { name: 'Image layout' }), {
      target: { value: 'inline' }
    });
    expect(onImage).toHaveBeenLastCalledWith(
      'snl-ext-preset:v1:image?src=figures%2Fdiagram.png&layout=inline&alt=Proof%20diagram'
    );
  });

  it('clears the persisted image preset while an edited path is invalid', () => {
    const onChange = vi.fn();
    const view = render(
      <BlockRendererPresetControl
        value="snl-ext-preset:v1:image?src=old.png&layout=block&alt=Old"
        onChange={onChange}
      />
    );
    const path = view.getByRole('textbox', { name: 'Image path' });
    fireEvent.change(path, { target: { value: '../outside.png' } });
    expect(path).toHaveProperty('value', '../outside.png');
    expect(view.getByRole('alert').textContent).toContain('.SNL_Doc/assets');
    expect(onChange).toHaveBeenLastCalledWith('image');
  });

  it('edits a local text-template language without changing the interface language', () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'macro-local-language', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
        { id: 'en', display_name: 'English (US)' }
      ]
    });
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

    const textModeButtons = screen.getAllByRole('button', { name: 'Text (I18N)' });
    fireEvent.click(textModeButtons[textModeButtons.length - 1]);
    expect(screen.getByRole('heading', { name: 'Template (I18N)' })).toBeTruthy();
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

  it('offers repo-configured languages in the I18N Template editor', () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'macro-authoring-language', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
        { id: 'en', display_name: 'English (US)' },
        { id: 'fr', display_name: 'Français' }
      ]
    });
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
    const textModes = screen.getAllByRole('button', { name: 'Text (I18N)' });
    fireEvent.click(textModes[textModes.length - 1]);
    fireEvent.click(screen.getByRole('button', { name: /Language: English/ }));
    expect(screen.getByRole('option', { name: /Français/ })).toBeTruthy();
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

    const textModes = screen.getAllByRole('button', { name: 'Text (I18N)' });
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
