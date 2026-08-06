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
        generation: 'panel-test',
      revision: 100,
      preferences: { language: 'zh-CN', color_scheme: 'dark', motion: 'reduced' }
    });
    await waitFor(() => expect(view.container.textContent).toContain('返回'));
    expect(view.getByRole('navigation').getAttribute('aria-label')).toBe('面板导航');
  });

  it('renders font-independent SVG language icons and no Unicode flag glyphs', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    document.documentElement.dataset.snlLogoBlack = 'webview://logo-black.svg';
    document.documentElement.dataset.snlLogoWhite = 'webview://logo-white.svg';
    const api = { postMessage: vi.fn() } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Create Entry" back={back} />);

    expect(view.getByRole('heading', { name: 'Create Entry' })).toBeTruthy();
    expect(view.getByText('SJTU AI4Math')).toBeTruthy();
    expect(view.container.querySelector('.snl-panel-header__logo')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Back' })
      .querySelector('svg[data-snl-icon="chevron-left"]')).toBeTruthy();
    expect(view.getByRole('button', { name: /Refresh this panel/ })
      .querySelector('svg[data-snl-icon="refresh"]')).toBeTruthy();
    const trigger = view.getByRole('button', { name: /Interface language: English \(US\)/ });
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.querySelector('svg[data-language-icon="en"]')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/🇨🇳|🇺🇸/);

    fireEvent.click(trigger);
    expect(view.getByRole('menuitemradio', { name: '简体中文（中国大陆）' })
      .querySelector('svg[data-language-icon="zh-CN"]')).toBeTruthy();
    expect(view.getByRole('menuitemradio', { name: 'English (US)' })
      .querySelector('svg[data-language-icon="en"]')).toBeTruthy();
    expect(view.getByRole('menuitemradio', { name: /Follow VS Code/ })
      .querySelector('svg[data-language-icon="auto"]')).toBeTruthy();
    expect(view.container.querySelector('[disabled]')).toBeNull();
  });

  it('sends explicit and Auto preferences from usable menu items', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    const postMessage = vi.fn();
    const api = { postMessage } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Create Entry" back={back} />);

    fireEvent.click(view.getByRole('button', { name: /Interface language/ }));
    fireEvent.click(view.getByRole('menuitemradio', { name: '简体中文（中国大陆）' }));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'snl.preferences/set-language',
      language: 'zh-CN'
    });

    fireEvent.click(view.getByRole('button', { name: /Interface language/ }));
    fireEvent.click(view.getByRole('menuitemradio', { name: /Follow VS Code/ }));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'snl.preferences/set-language',
      language: 'auto'
    });
  });

  it('uses roving menu focus and closes cleanly for keyboard users', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    const api = { postMessage: vi.fn() } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Dashboard" />);
    const trigger = view.getByRole('button', { name: /Interface language/ });

    fireEvent.click(trigger);
    const auto = view.getByRole('menuitemradio', { name: /Follow VS Code/ });
    const chinese = view.getByRole('menuitemradio', { name: '简体中文（中国大陆）' });
    const english = view.getByRole('menuitemradio', { name: 'English (US)' });
    expect(document.activeElement).toBe(english);
    expect(english.tabIndex).toBe(0);
    expect(auto.tabIndex).toBe(-1);
    expect(chinese.tabIndex).toBe(-1);

    fireEvent.keyDown(english, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(auto);
    expect(auto.tabIndex).toBe(0);
    expect(english.tabIndex).toBe(-1);

    fireEvent.keyDown(auto, { key: 'Escape' });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.keyDown(view.getByRole('menuitemradio', { name: 'English (US)' }), { key: 'Tab' });
    expect(view.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.keyDown(view.getByRole('menuitemradio', { name: 'English (US)' }), {
      key: 'Tab',
      shiftKey: true
    });
    expect(view.queryByRole('menu')).toBeNull();
  });

  it('represents Auto as a usable menu choice', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'auto';
    const api = { postMessage: vi.fn() } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Dashboard" />);

    expect(view.getByRole('button', {
      name: /Interface language: Follow VS Code \(English \(US\)\)/
    })).toBeTruthy();
  });
});
