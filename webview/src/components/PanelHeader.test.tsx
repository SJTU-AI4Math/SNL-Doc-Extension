// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelHeader } from './PanelHeader';
import { apply_preferences_snapshot } from '../runtime/preferencesRuntime';
import type { VsCodeApi } from '../vscodeApi';

const back = {
  label: {
    type: 'i18n' as const,
    default_language: 'en',
    values: { en: 'Back', 'zh-CN': '返回' }
  },
  message: { type: 'back' }
};

afterEach(cleanup);

describe('PanelHeader', () => {
  it('re-renders localized UI text after a preference snapshot', async () => {
    document.documentElement.lang = 'en';
    const api = { postMessage: vi.fn() } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title={back.label} back={back} />);
    expect(view.container.textContent).toContain('Back');
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot',
      revision: 100,
      preferences: { language: 'zh-CN', color_scheme: 'dark', motion: 'reduced' }
    });
    await waitFor(() => expect(view.container.textContent).toContain('返回'));
    expect(view.getByRole('navigation').getAttribute('aria-label')).toBe('面板导航');
  });

  it('renders shared branding, a parameterized title, and the two language choices', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    document.documentElement.dataset.snlLogoBlack = 'webview://logo-black.svg';
    document.documentElement.dataset.snlLogoWhite = 'webview://logo-white.svg';
    const api = { postMessage: vi.fn() } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Create Entry" back={back} />);

    expect(view.getByRole('heading', { name: 'Create Entry' })).toBeTruthy();
    expect(view.getByText('SJTU AI4Math')).toBeTruthy();
    expect(view.container.querySelector('.snl-panel-header__logo')).toBeTruthy();
    const language = view.getByRole('combobox', { name: 'Interface language' });
    expect(language.textContent).toContain('🇨🇳 简体中文（中国大陆）');
    expect(language.textContent).toContain('🇺🇸 English (US)');
  });

  it('sends a global preference message when the language changes', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    const postMessage = vi.fn();
    const api = { postMessage } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Create Entry" back={back} />);

    fireEvent.change(view.getByRole('combobox', { name: 'Interface language' }), {
      target: { value: 'zh-CN' }
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'snl.preferences/set-language',
      language: 'zh-CN'
    });
  });

  it('represents Auto honestly while keeping exactly two enabled language choices', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'auto';
    const postMessage = vi.fn();
    const api = { postMessage } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Dashboard" />);
    const language = view.getByRole('combobox', { name: 'Interface language' }) as HTMLSelectElement;

    expect(language.value).toBe('');
    expect(Array.from(language.options).filter((option) => !option.disabled)).toHaveLength(2);
    fireEvent.change(language, { target: { value: 'en' } });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'snl.preferences/set-language',
      language: 'en'
    });
  });
});
