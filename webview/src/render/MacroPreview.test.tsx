// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WireMacro } from './macroWire';
import {
  MacroPreview,
  createMacroPreviewRuntime,
  macroPreviewTree
} from './MacroPreview';

afterEach(() => {
  cleanup();
  document.documentElement.dataset.snlContentLanguage = 'en';
});

function macro(
  name: string,
  styles: WireMacro['styles'],
  dynamic_arity = false
): WireMacro {
  return {
    name,
    description: '',
    source: { entries: [], urls: [] },
    dynamic_arity,
    styles,
    tags: []
  };
}

const style = (
  style_name: string,
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block',
  body: string,
  extra: Record<string, unknown> = {}
): WireMacro['styles'][number] => ({
  style_name,
  tags: [],
  template: { mode, body, ...extra }
});

describe('MacroPreview', () => {
  it('uses styles[0] for implicit style and honors an explicit style', async () => {
    const value = macro('choice', [
      style('default', 'formula_inline', '\\mathrm{DEFAULT}'),
      style('compact', 'formula_inline', '\\mathrm{EXPLICIT}')
    ]);
    const runtime = createMacroPreviewRuntime({ macros: { choice: value }, language: 'en' });
    const implicit = render(<MacroPreview macro={value} runtime={runtime} label="implicit" />);
    await waitFor(() => expect(implicit.container.textContent).toContain('DEFAULT'));
    implicit.unmount();

    const explicit = render(
      <MacroPreview macro={value} styleName="compact" runtime={runtime} label="explicit" />
    );
    await waitFor(() => expect(explicit.container.textContent).toContain('EXPLICIT'));
    expect(explicit.container.textContent).not.toContain('DEFAULT');
  });

  it('resolves one locale projection atomically', async () => {
    const value = macro('localized', [{
      style_name: 'default',
      tags: [],
      template: {
        type: 'i18n',
        default_language: 'en',
        values: {
          en: { mode: 'formula_inline', body: '\\mathrm{EN}', separator: ',' },
          'zh-CN': { mode: 'text', body: '中文', separator: '、' }
        }
      }
    }]);
    const runtime = createMacroPreviewRuntime({
      macros: { localized: value },
      language: 'zh-CN'
    });
    const view = render(<MacroPreview macro={value} runtime={runtime} label="localized" />);
    await waitFor(() => expect(view.container.textContent).toContain('中文'));
    expect(view.container.textContent).not.toContain('EN');
  });

  it.each([
    ['formula', macro('formula', [style('default', 'formula_inline', '\\frac{#0}{#1}')]), 2],
    ['text', macro('textual', [style('default', 'text', 'before #0 after')]), 1],
    ['block', macro('blocked', [style('default', 'block', '#*', {
      block_template_name: 'centered'
    })], true), 3],
    ['dynamic', macro('dynamic', [style('default', 'formula_inline', '#*', {
      separator: '+'
    })], true), 3]
  ] as const)('renders %s templates with the expected placeholder arity', async (
    _kind,
    value,
    expectedChildren
  ) => {
    const runtime = createMacroPreviewRuntime({ macros: { [value.name]: value }, language: 'en' });
    expect(macroPreviewTree(value, undefined, 'en').children).toHaveLength(expectedChildren);
    const view = render(<MacroPreview macro={value} runtime={runtime} label={value.name} />);
    await waitFor(() =>
      expect(view.container.querySelectorAll('.snlArgPlaceholder')).toHaveLength(expectedChildren)
    );
  });

  it.each([
    ['empty', macro('empty', [style('default', 'formula_inline', '   ')])],
    ['invalid locale', macro('invalid', [{
      style_name: 'default',
      tags: [],
      template: { type: 'i18n', default_language: 'en', values: {} }
    }])]
  ])('falls back locally for an %s preview', (_label, value) => {
    const runtime = createMacroPreviewRuntime({ macros: { [value.name]: value }, language: 'en' });
    const view = render(<MacroPreview macro={value} runtime={runtime} label={value.name} />);
    expect(view.getByText('—')).toBeTruthy();
    expect(view.container.querySelector('[data-macro-preview-fallback]')).toBeTruthy();
  });
});
