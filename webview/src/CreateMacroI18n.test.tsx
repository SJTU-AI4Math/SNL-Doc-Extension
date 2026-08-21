import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';


const posted: unknown[] = [];
let webviewState: unknown;
let stateWrites = 0;

function digest(value: string): string { return bytesToHex(sha256(new TextEncoder().encode(value))); }
function projectionFor(request: Record<string, unknown>): Record<string, unknown> {
  const slug = request.slug as string;
  const sourceDigest = digest(request.sourceSvg as string);
  const templateDigest = digest(request.templateSvg as string);
  const source = `svg/${slug}.source.${sourceDigest}.svg`;
  const template = `svg/${slug}.template.${templateDigest}.svg`;
  const manifestText = `${JSON.stringify({ version: 1, compiler: 'snl-doc-extension-svg-editor:v1', source,
    source_revision: `sha256:${sourceDigest}`, output: template, output_revision: `sha256:${templateDigest}`,
    operations: request.operations }, null, 2)}\n`;
  return {
    asset: { source: template, base_identity: 'workspace:.SNL_Doc/assets', revision: `sha256:${templateDigest}`, request_epoch: 0 },
    generation: 1, producer_revision: 'snl-doc-extension-svg-editor:v1', accessibility: { label: request.accessibilityLabel },
    editor: { source, source_revision: `sha256:${sourceDigest}`, manifest: `svg/${slug}.manifest.${digest(manifestText)}.json` }
  };
}

vi.mock('./vscodeApi', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./vscodeApi');
  const api = {
    postMessage: (message: unknown) => { posted.push(message); },
    getState: () => webviewState,
    setState: (state: unknown) => { webviewState = state; stateWrites += 1; }
  };
  return {
    ...actual,
    getVsCodeApi: () => api,
    useVsCodeApiRef: () => ({ current: api })
  };
});

const { BlockRendererPresetControl, CreateMacroApp, styleUsesSvgRenderer, styleHasAnySvgRenderer } = await import('./CreateMacroApp');
const { apply_preferences_snapshot, set_content_language } = await import('./runtime/preferencesRuntime');

afterEach(() => {
  cleanup();
  posted.length = 0;
  webviewState = undefined;
  stateWrites = 0;
  document.documentElement.lang = 'en';
});

describe('Create Macro localization', () => {
  it('treats malformed custom renderer metadata as non-SVG without throwing during render capability checks', () => {
    expect(() => styleUsesSvgRenderer({ mode: 'block', block_template_name: 'custom?x=1' })).not.toThrow();
    expect(styleUsesSvgRenderer({ mode: 'block', block_template_name: 'custom?x=1' })).toBe(false);
  });
  it('detects SVG renderers in inactive localized projections for fixed-arity gating', () => {
    expect(styleHasAnySvgRenderer({
      mode: 'formula_inline', block_template_name: '',
      template_localized: {
        type: 'i18n', default_language: 'en', values: {
          en: { mode: 'formula_inline', block_template_name: '' },
          'zh-CN': { mode: 'block', block_template_name: 'svg_template' }
        }
      }
    } as never)).toBe(true);
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
      existingNames: ['Inactive.svg'], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
      existing: { name: 'Inactive.svg', description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
        styles: [{ style_name: 'default', tags: [], template: {
          type: 'i18n', default_language: 'en', values: {
            en: { mode: 'formula_inline', body: '#0' },
            'zh-CN': { mode: 'block', body: '#0', block_template_name: 'svg_template' }
          }
        } }] }
    } })));
    expect(screen.getByRole('checkbox', { name: 'Dynamic Arity' })).toHaveProperty('disabled', true);
  });

  it('invalidates a pending SVG save when the localized projection changes', () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'svg-locale-authority', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }]
    });
    render(<CreateMacroApp />);
    const svg = { mode: 'block', body: '#0', block_template_name: 'svg_template' };
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
      existingNames: ['Localized.svg'], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
      existing: { name: 'Localized.svg', description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
        styles: [{ style_name: 'default', tags: [], template: {
          type: 'i18n', default_language: 'en', values: { en: svg, 'zh-CN': svg }
        } }] }
    } })));
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h2v2H0z"/></svg>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'localized' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Localized' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const request = [...posted].reverse().find((value) => typeof value === 'object' && value !== null
      && (value as { type?: string }).type === 'svgMacro.writeAssets') as Record<string, unknown>;
    fireEvent.click(screen.getByRole('button', { name: /Language: English/ }));
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'svgMacro.assetsWritten', requestId: request.requestId, projection: projectionFor(request)
    } })));
    expect(screen.queryByText('SVG Macro Asset saved.')).toBeNull();
    expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps per-Style template languages stable across repeated Style switches', async () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'macro-style-language-switch', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'en', display_name: 'English' },
        { id: 'zh-CN', display_name: '简体中文' }
      ]
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
      existingNames: ['Style.localized'], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
      existing: {
        name: 'Style.localized', description: '', source: { entries: [], urls: [] },
        dynamic_arity: false, tags: [],
        styles: [
          {
            style_name: 'default', tags: [],
            template: {
              type: 'i18n', default_language: 'en',
              values: {
                en: { mode: 'text', body: 'DEFAULT EN' },
                'zh-CN': { mode: 'text', body: 'DEFAULT ZH' }
              }
            }
          },
          {
            style_name: 'compact', tags: [],
            template: {
              type: 'i18n', default_language: 'zh-CN',
              values: {
                en: { mode: 'text', body: 'COMPACT EN' },
                'zh-CN': { mode: 'text', body: 'COMPACT ZH' }
              }
            }
          }
        ]
      }
    } })));

    await waitFor(() => expect(screen.getByRole('button', { name: /Language: English/ })).toBeTruthy());
    const writesBeforeSwitching = stateWrites;
    const postsBeforeSwitching = posted.length;
    for (let index = 0; index < 20; index += 1) {
      const compact = index % 2 === 0;
      fireEvent.click(screen.getByRole('button', { name: compact ? 'compact' : 'default' }));
      expect(screen.getByRole('button', {
        name: compact ? /Language: 简体中文/ : /Language: English/
      })).toBeTruthy();
      expect((screen.getAllByRole('textbox').find((element) =>
        element.tagName === 'TEXTAREA') as HTMLTextAreaElement).value)
        .toBe(compact ? 'COMPACT ZH' : 'DEFAULT EN');
    }

    expect(screen.getByRole('button', { name: 'default' }).getAttribute('aria-pressed')).toBe('true');
    const name = screen.getByRole('textbox', { name: /^Name/ }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Style.localized.updated' } });
    expect(name.value).toBe('Style.localized.updated');
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/maximum update depth/i);
    expect(posted.length - postsBeforeSwitching).toBeLessThanOrEqual(2);
    expect(stateWrites - writesBeforeSwitching).toBeLessThanOrEqual(26);
    consoleError.mockRestore();
  });

  it('preserves localized workspace Macros through the released Basics 0.2.1 preview boundary', async () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'macro-cross-preview', revision: 20,
      preferences: { language: 'zh-CN', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
        { id: 'en', display_name: 'English (US)' }
      ]
    });
    act(() => set_content_language('zh-CN'));
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: ['Existing'], macroCandidates: [], macroKinds: [], existing: null,
      entries: [], prefill: null,
      workspaceMacros: {
        Existing: {
          name: 'Existing', description: '', source: { entries: [], urls: [] },
          kind: 'const', dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: {
              type: 'i18n', default_language: 'en',
              values: {
                en: { mode: 'formula_inline', body: '\\text{CROSS-EN}' },
                'zh-CN': { mode: 'text', body: 'CROSS-ZH' }
              }
            }
          }]
        }
      }
    } })));
    const template = screen.getAllByRole('textbox').find(
      (element) => element.tagName === 'TEXTAREA'
    )!;
    fireEvent.change(template, { target: { value: '#0' } });
    fireEvent.click(screen.getByRole('button', { name: /Argument overrides|预览参数覆盖/ }));
    const argument = screen.getAllByRole('textbox').filter(
      (element) => element.tagName === 'TEXTAREA'
    ).at(-1)!;
    fireEvent.change(argument, { target: { value: 'Existing()' } });
    await waitFor(() => expect(screen.getAllByText('CROSS-ZH').length).toBeGreaterThan(0));
    act(() => set_content_language('en'));
    await waitFor(() => {
      expect(screen.getAllByText('CROSS-EN').length).toBeGreaterThan(0);
      expect(screen.queryAllByText('CROSS-ZH')).toHaveLength(0);
    });
  });

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

  it('keeps Create disabled while any non-block style has an empty template', () => {
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
      target: { value: 'Two.styles' }
    });
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: '#0' } }
    );
    fireEvent.click(screen.getByRole('button', { name: '+ Add style' }));
    const create = screen.getByRole('button', { name: 'Create Macro' });
    expect(create).toHaveProperty('disabled', true);
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: '#0 + #1' } }
    );
    expect(create).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: /Macro tags/ }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
    const macroTag = screen.getAllByPlaceholderText('tag')[0];
    fireEvent.change(macroTag, { target: { value: 'bad\\tag' } });
    expect(create).toHaveProperty('disabled', true);
    fireEvent.change(macroTag, { target: { value: 'good-tag' } });
    expect(create).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: /Style tags/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '+ Add tag' }).at(-1)!);
    const styleTag = screen.getAllByPlaceholderText('tag').at(-1)!;
    fireEvent.change(styleTag, { target: { value: 'bad\\style' } });
    expect(create).toHaveProperty('disabled', true);
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

  it('opens the SVG Macro editor for the svg_template Block renderer', () => {
    document.documentElement.lang = 'en';
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: [], macroCandidates: [], macroKinds: [], existing: null,
      entries: [], prefill: null
    } })));
    const blockModes = screen.getAllByRole('button', { name: 'Block' });
    fireEvent.click(blockModes[blockModes.length - 1]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Render preset' }), {
      target: { value: 'svg_template' }
    });
    expect(screen.getByRole('region', { name: 'SVG Macro editor' })).toBeTruthy();
    expect(screen.getByLabelText('Import SVG file')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')[0]).toHaveProperty('disabled', true);
  });

  it('assigns distinct pending-save identities to host-hydrated SVG styles', () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'hydrated-svg-style-identity', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [{ id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '简体中文' }]
    });
    render(<CreateMacroApp />);
    const svgTemplate = { mode: 'block', body: '#0', block_template_name: 'svg_template' };
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
      existingNames: ['Hydrated'], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
      existing: { name: 'Hydrated', description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [],
        styles: [
          { style_name: 'default', tags: [], template: { type: 'i18n', default_language: 'en', values: { en: svgTemplate } } },
          { style_name: 'alternate', tags: [], template: { type: 'i18n', default_language: 'zh-CN', values: { 'zh-CN': svgTemplate } } }
        ] }
    } })));
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h2v2H0z"/></svg>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'hydrated' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Hydrated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const request = [...posted].reverse().find((value) => typeof value === 'object' && value !== null
      && (value as { type?: string }).type === 'svgMacro.writeAssets') as Record<string, unknown>;
    fireEvent.click(screen.getByRole('button', { name: 'Remove style default' }));
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'svgMacro.assetsWritten', requestId: request.requestId, projection: projectionFor(request)
    } })));
    expect(screen.queryByText('SVG Macro Asset saved.')).toBeNull();
    expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not adopt an SVG save after the active style is removed and replaced at the same index', () => {
    document.documentElement.lang = 'en';
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: [], macroCandidates: [], macroKinds: [], existing: null,
      entries: [], prefill: null
    } })));
    fireEvent.click(screen.getByRole('button', { name: '+ Add style' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Block' }).at(-1)!);
    fireEvent.change(screen.getByRole('combobox', { name: 'Render preset' }), { target: { value: 'svg_template' } });
    fireEvent.click(screen.getByRole('button', { name: 'default' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Block' }).at(-1)!);
    fireEvent.change(screen.getByRole('combobox', { name: 'Render preset' }), { target: { value: 'svg_template' } });
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h2v2H0z"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'diagram' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Diagram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const request = [...posted].reverse().find((value) => typeof value === 'object' && value !== null
      && (value as { type?: string }).type === 'svgMacro.writeAssets') as { requestId: string };
    fireEvent.click(screen.getByRole('button', { name: 'Remove style default' }));
    const projection = projectionFor(request as unknown as Record<string, unknown>);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'svgMacro.assetsWritten', requestId: request.requestId, projection } })));
    expect(screen.queryByText('SVG Macro Asset saved.')).toBeNull();
    expect((screen.getByLabelText('SVG source') as HTMLTextAreaElement).value).toBe('');
  });

  it('attaches a saved SVG projection and derives ordinary Macro arity from slots', () => {
    document.documentElement.lang = 'en';
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: [], macroCandidates: [], macroKinds: [], existing: null,
      entries: [], prefill: null
    } })));
    fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), { target: { value: 'Diagram' } });
    const blockModes = screen.getAllByRole('button', { name: 'Block' });
    fireEvent.click(blockModes[blockModes.length - 1]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Render preset' }), { target: { value: 'svg_template' } });
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path id="label" d="M0 0h2v2H0z"/></svg>';
    fireEvent.change(screen.getByLabelText('SVG source'), { target: { value: raw } });
    fireEvent.click(screen.getByRole('button', { name: 'Load SVG preview' }));
    const path = screen.getByTestId('svg-macro-preview').querySelector('#label') as SVGGraphicsElement;
    Object.defineProperty(path, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 2, height: 2 }) });
    Object.defineProperty(path, 'getCTM', { configurable: true, value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
    fireEvent.click(path);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection with slot' }));
    fireEvent.change(screen.getByLabelText('Asset name'), { target: { value: 'diagram' } });
    fireEvent.change(screen.getByLabelText('Accessibility label'), { target: { value: 'Diagram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save SVG Macro Asset' }));
    const request = [...posted].reverse().find((value) =>
      typeof value === 'object' && value !== null && (value as { type?: string }).type === 'svgMacro.writeAssets'
    ) as { requestId: string };
    const projection = projectionFor(request as unknown as Record<string, unknown>);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'svgMacro.assetsWritten', requestId: request.requestId, projection
    } })));
    fireEvent.click(screen.getByRole('button', { name: 'Create Macro' }));
    const mutation = [...posted].reverse().find((value) =>
      typeof value === 'object' && value !== null && (value as { type?: string }).type === 'create'
    ) as { macro?: { styles?: Array<{ template?: Record<string, unknown> }> } } | undefined;
    expect(mutation?.macro?.styles?.[0]?.template).toMatchObject({
      mode: 'block', body: '#0', block_template_name: 'svg_template', svg_template: projection
    });
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

  it('defaults a new text template to General independently of panel content language', () => {
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
    const language = screen.getByRole('button', { name: /Language: General/ });
    expect(language.querySelector('svg[data-language-icon="general"]')).toBeTruthy();
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

  it('creates a text Macro from the default General template', () => {
    document.documentElement.lang = 'en';
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: [], macroCandidates: [], macroKinds: [], existing: null,
      entries: [], prefill: null
    } })));
    fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Group.prose' }
    });
    const textModes = screen.getAllByRole('button', { name: 'Text (I18N)' });
    fireEvent.click(textModes[textModes.length - 1]);
    expect(screen.getByRole('button', { name: /Language: General/ })).toBeTruthy();
    const template = screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!;
    fireEvent.change(template, { target: { value: 'Group #0' } });
    const create = screen.getByRole('button', { name: 'Create Macro' });
    expect(create).toHaveProperty('disabled', false);
    fireEvent.click(create);
    const message = posted.find((candidate) =>
      typeof candidate === 'object' && candidate !== null && (candidate as { type?: string }).type === 'create'
    ) as { macro?: { styles?: Array<{ template?: unknown }> } } | undefined;
    expect(message?.macro?.styles?.[0]?.template).toMatchObject({
      mode: 'text', body: 'Group #0'
    });
  });

  it('materializes the displayed General whole-template on direct Save without typing', async () => {
    document.documentElement.lang = 'en';
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'macro-general-save', revision: 1,
      preferences: { language: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'en', display_name: 'English' },
        { id: 'zh-CN', display_name: '简体中文' },
        { id: 'ja', display_name: '日本語' }
      ]
    });
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', file: 'algebra.json', packageName: 'Algebra',
      existingNames: ['General.direct'], macroCandidates: [], macroKinds: [], entries: [], prefill: null,
      existing: {
        name: 'General.direct', description: '', source: { entries: [], urls: [], source_extension: 'SOURCE-EXT' },
        dynamic_arity: false, tags: [], macro_extension: 'MACRO-EXT',
        styles: [{
          style_name: 'default', tags: [], style_extension: 'STYLE-EXT',
          template: {
            type: 'i18n', default_language: 'en', map_extension: 'MAP-EXT',
            values: {
              en: { mode: 'text', body: 'GENERAL #0', projection_extension: 'GENERAL-EXT' },
              'zh-CN': { mode: 'text', body: 'ZH #0', projection_extension: 'ZH-EXT' },
              ja: { mode: 'text', body: 'JA #0', projection_extension: 'JA-EXT' }
            }
          }
        }]
      }
    } })));

    await waitFor(() => expect(screen.getByRole('button', { name: /Language: English/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Language: English/ }));
    fireEvent.click(screen.getByRole('option', { name: 'General' }));
    const template = screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!;
    expect(template).toHaveProperty('value', 'GENERAL #0');
    fireEvent.click(screen.getByRole('button', { name: /Language: General/ }));
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    expect(template).toHaveProperty('value', 'ZH #0');
    fireEvent.click(screen.getByRole('button', { name: /Language: 简体中文/ }));
    fireEvent.click(screen.getByRole('option', { name: 'General' }));
    act(() => set_content_language('zh-CN'));
    expect(screen.getByRole('button', { name: /Language: General/ })).toBeTruthy();

    const save = screen.getByRole('button', { name: /Update Macro/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const update = posted.find((candidate) =>
      typeof candidate === 'object' && candidate !== null && (candidate as { type?: string }).type === 'update'
    ) as { macro?: { macro_extension?: string; source?: Record<string, unknown>; styles?: Array<Record<string, unknown>> } } | undefined;
    expect(update?.macro?.macro_extension).toBe('MACRO-EXT');
    expect(update?.macro?.source?.source_extension).toBe('SOURCE-EXT');
    expect(update?.macro?.styles?.[0]?.style_extension).toBe('STYLE-EXT');
    expect(update?.macro?.styles?.[0]?.template).toMatchObject({
      mode: 'text', body: 'GENERAL #0', projection_extension: 'GENERAL-EXT'
    });
    expect(JSON.stringify(update?.macro?.styles?.[0]?.template)).not.toContain('__snl_general__');
  });

  it('canonicalizes the legacy partial Macro Kind to v11 sub before create', () => {
    document.documentElement.lang = 'en';
    render(<CreateMacroApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', file: 'algebra.json', packageName: 'Algebra',
      existingNames: [], macroCandidates: [],
      macroKinds: [{
        id: 'partial', name: 'Partial', description: 'Legacy preset kind',
        coloring: { light: { stroke: 'inherit', background: 'transparent' }, dark: { stroke: 'inherit', background: 'transparent' } }
      }],
      existing: null, entries: [], prefill: null
    } })));
    const kind = screen.getByLabelText('Kind') as HTMLSelectElement;
    expect(Array.from(kind.options).map((option) => option.value)).toContain('sub');
    expect(Array.from(kind.options).map((option) => option.value)).not.toContain('partial');
    fireEvent.change(kind, { target: { value: 'sub' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Name/ }), {
      target: { value: 'Partial.helper' }
    });
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: '#0' } }
    );
    const create = screen.getByRole('button', { name: 'Create Macro' });
    expect(create).toHaveProperty('disabled', false);
    fireEvent.click(create);
    const message = posted.find((candidate) =>
      typeof candidate === 'object' && candidate !== null &&
      (candidate as { type?: string }).type === 'create'
    ) as { macro?: { kind?: string } } | undefined;
    expect(message?.macro?.kind).toBe('sub');
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
    fireEvent.click(screen.getByRole('button', { name: /Language: General/ }));
    expect(screen.getByRole('option', { name: /Français/ })).toBeTruthy();
  });

  it('converts every retained mode draft when dynamic arity changes', () => {
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
      target: { value: 'Dynamic.prose' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Text (I18N)' }));
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: 'prose' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: 'inline' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Formula (display)' }));
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: 'display' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dynamic Arity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Formula (display)' }));
    const displayLeft = screen.getByRole('textbox', { name: 'Left delimiter' });
    expect(displayLeft).toHaveProperty('value', 'display');
    fireEvent.change(displayLeft, { target: { value: 'display-edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dynamic Arity' }));
    fireEvent.click(screen.getByRole('button', { name: 'Formula (display)' }));
    expect((screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA') as HTMLTextAreaElement).value)
      .toBe('display-edited#*');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dynamic Arity' }));
    expect(screen.getByRole('textbox', { name: 'Left delimiter' })).toHaveProperty(
      'value', 'display-edited'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Text (I18N)' }));
    expect(screen.getByRole('textbox', { name: 'Left delimiter' }))
      .toHaveProperty('value', 'prose');
    const create = screen.getByRole('button', { name: 'Create Macro' });
    expect(create).toHaveProperty('disabled', false);
    fireEvent.click(create);
    const submission = posted.find((message) => (
      typeof message === 'object' && message !== null &&
      (message as { type?: string }).type === 'create'
    )) as { macro: { dynamic_arity: boolean; styles: Array<{ template: unknown }> } };
    expect(submission.macro.dynamic_arity).toBe(true);
    expect(submission.macro.styles[0].template).toMatchObject({
      mode: 'text', body: 'prose#*'
    });
  });

  it('treats escaped variadic text literally and gates effective fixed variadics', () => {
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
      target: { value: 'Escaped.dynamic' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Text (I18N)' }));
    const template = screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!;
    fireEvent.change(template, { target: { value: '\\#*' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dynamic Arity' }));
    expect(screen.getByRole('textbox', { name: 'Left delimiter' })).toHaveProperty('value', '\\#*');
    expect(screen.getByRole('button', { name: 'Create Macro' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Dynamic Arity' }));
    const fixedTemplate = screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!;
    expect(fixedTemplate).toHaveProperty('value', '\\#*');
    fireEvent.change(fixedTemplate, { target: { value: '#*' } });
    expect(screen.getByRole('button', { name: 'Create Macro' })).toHaveProperty('disabled', true);
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

  it('switches away from and back to text mode without disabling the buttons or losing translations', () => {
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
    fireEvent.click(screen.getByRole('button', { name: /Language: General/ }));
    fireEvent.click(screen.getByRole('option', { name: /English/ }));
    fireEvent.change(template, { target: { value: 'English text' } });
    fireEvent.click(screen.getByRole('button', { name: /Language: English/ }));
    fireEvent.click(screen.getByRole('option', { name: /简体中文/ }));
    fireEvent.change(template, { target: { value: '中文文本' } });

    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();
    fireEvent.change(
      screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA')!,
      { target: { value: 'formula-only' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Text (I18N)' }));
    expect(screen.getByRole('button', { name: /Language: 简体中文/ })).toBeTruthy();
    expect((screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA') as HTMLTextAreaElement).value)
      .toBe('中文文本');
    fireEvent.click(screen.getByRole('button', { name: 'Formula (inline)' }));
    expect((screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA') as HTMLTextAreaElement).value)
      .toBe('formula-only');
    fireEvent.click(screen.getByRole('button', { name: 'Text (I18N)' }));
    fireEvent.click(screen.getByRole('button', { name: /Language: 简体中文/ }));
    fireEvent.click(screen.getByRole('option', { name: /English/ }));
    expect((screen.getAllByRole('textbox').find((element) => element.tagName === 'TEXTAREA') as HTMLTextAreaElement).value)
      .toBe('English text');
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
              style_name: 'default',  tags: [],
              template: {
                type: 'i18n', default_language: 'en', map_extension: 'MAP-EXT',
                values: {
                  en: { mode: 'text', body: 'English #*', projection_extension: 'EN-EXT' },
                  'zh-CN': { mode: 'text', body: '中文 #*', projection_extension: 'ZH-EXT' },
                  ja: { mode: 'text', body: '日本語 #*', projection_extension: 'JA-EXT' }
                }
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
    expect(update?.macro.styles[0].template).toMatchObject({
      type: 'i18n',
      default_language: 'en',
      map_extension: 'MAP-EXT',
      values: {
        en: expect.objectContaining({ mode: 'text', body: 'English #*', projection_extension: 'EN-EXT' }),
        'zh-CN': expect.objectContaining({ mode: 'formula_inline', body: '中文 #*', projection_extension: 'ZH-EXT' }),
        ja: expect.objectContaining({ mode: 'text', body: '日本語 #*', projection_extension: 'JA-EXT' })
      }
    });
    confirm.mockRestore();
  });
});
