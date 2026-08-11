// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelHeader } from './PanelHeader';
import {
  apply_preferences_snapshot,
  get_content_language,
  set_content_language
} from '../runtime/preferencesRuntime';
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
    const view = render(
      <PanelHeader
        vsApi={api}
        title="Create Entry"
        back={back}
        viewInInfoview={{ label: 'View', title: 'View this entry', message: { type: 'view' } }}
        edit={{ label: 'Edit', title: 'Edit this entry', message: { type: 'edit' } }}
      />
    );

    expect(view.getByRole('heading', { name: 'Create Entry' })).toBeTruthy();
    const brandLink = view.getByRole('link', { name: 'SJTU AI4Math' });
    expect(brandLink.getAttribute('aria-label')).toBe('SJTU AI4Math');
    expect(brandLink.getAttribute('href')).toBe('https://sjtu-ai4math.github.io/');
    expect(brandLink.getAttribute('target')).toBe('_blank');
    expect(brandLink.getAttribute('rel')).toContain('noopener');
    expect(within(brandLink).getByText('SJTU AI4Math')).toBeTruthy();
    expect(view.container.querySelector('.snl-panel-header__logo')).toBeTruthy();
    const backButton = view.getByRole('button', { name: 'Back' });
    expect(backButton.querySelector('svg[data-snl-icon="chevron-left"]')).toBeTruthy();
    expect(backButton.textContent).toBe('');
    const viewButton = view.getByRole('button', { name: 'View this entry' });
    expect(viewButton.querySelector('svg[data-snl-icon="book"]')).toBeTruthy();
    expect(viewButton.classList.contains('snl-panel-header__reader-action')).toBe(true);
    expect(viewButton.textContent).toBe('');
    const editButton = view.getByRole('button', { name: 'Edit this entry' });
    expect(editButton.querySelector('svg[data-snl-icon="edit"]')).toBeTruthy();
    expect(editButton.classList.contains('snl-panel-header__edit-action')).toBe(true);
    expect(editButton.textContent).toBe('');
    expect(view.getByRole('button', { name: /Refresh this panel/ })
      .querySelector('svg[data-snl-icon="refresh"]')).toBeTruthy();
    const trigger = view.getByRole('button', { name: /Interface language: English \(US\)/ });
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.querySelector('svg[data-language-icon="en"]')).toBeTruthy();
    expect(trigger.textContent).toBe('');
    expect(trigger.querySelector('.snl-panel-header__language-chevron')).toBeNull();
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

  it('adds repo authoring languages from the top menu and shows host-confirmed entries', async () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    const postMessage = vi.fn();
    const api = { postMessage } as unknown as VsCodeApi;
    const view = render(<PanelHeader vsApi={api} title="Create Macro" />);

    fireEvent.click(view.getByRole('button', { name: /Content language/ }));
    expect(view.queryByRole('button', { name: 'Add authoring language' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: /Content language/ }));
    fireEvent.click(view.getByRole('button', { name: /Interface language/ }));
    fireEvent.click(view.getByRole('button', { name: 'Add authoring language' }));
    fireEvent.change(view.getByRole('textbox', { name: 'Language tag' }), {
      target: { value: 'fr' }
    });
    fireEvent.change(view.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Français' }
    });
    fireEvent.click(view.getByRole('button', { name: 'Save language' }));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'snl.languages/add',
      language: { id: 'fr', display_name: 'Français' }
    });

    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'panel-language-catalog', revision: 1,
      preferences: { language: 'en', language_preference: 'en', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'zh-CN', display_name: '简体中文（中国大陆）' },
        { id: 'en', display_name: 'English (US)' },
        { id: 'fr', display_name: 'Français' }
      ]
    });
    await waitFor(() => expect(view.getByRole('button', { name: /Content language/ })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /Content language/ }));
    const customChoice = view.getByRole('menuitemradio', { name: 'Français' });
    expect(customChoice.querySelector('svg[data-language-icon="custom"]')).toBeTruthy();
    fireEvent.click(customChoice);
    expect(get_content_language()).toBe('fr');
    expect(document.documentElement.lang).toBe('en');
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'snl.preferences/set-language', language: 'fr'
    }));
  });

  it('exposes separate interface and panel content language selectors', () => {
    document.documentElement.lang = 'en';
    document.documentElement.dataset.snlLanguagePreference = 'en';
    set_content_language('zh-CN');
    const view = render(<PanelHeader vsApi={undefined} title="Reader" />);
    expect(view.getByRole('button', { name: /Interface language: English/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /Content language: 简体中文/ })).toBeTruthy();
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

    const trigger = view.getByRole('button', {
      name: /Interface language: Follow VS Code \(English \(US\)\)/
    });
    expect(trigger.querySelector('svg[data-language-icon="en"]')).toBeTruthy();
    expect(trigger.querySelector('svg[data-language-icon="auto"]')).toBeNull();
  });

  it('places an optional title action beside the heading', () => {
    const view = render(
      <PanelHeader
        vsApi={undefined}
        title="Edit entry Pythagoras"
        titleAction={<button type="button" aria-label="Edit title">edit</button>}
      />
    );
    const heading = view.getByRole('heading', { name: 'Edit entry Pythagoras' });
    const action = view.getByRole('button', { name: 'Edit title' });
    expect(heading.parentElement).toBe(action.parentElement);
  });

  it('keeps the enlarged logo size after the effective CSS cascade', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.resolve(__dirname, 'ui.css'), 'utf8');
    document.head.appendChild(style);
    document.documentElement.dataset.snlLogoBlack = 'webview://logo-black.svg';
    document.documentElement.dataset.snlLogoWhite = 'webview://logo-white.svg';
    const view = render(<PanelHeader vsApi={undefined} title="Dashboard" />);
    const logo = view.container.querySelector<HTMLElement>('.snl-panel-header__logo');
    expect(logo).not.toBeNull();
    expect(getComputedStyle(logo!).width).toBe('2rem');
    expect(getComputedStyle(logo!).height).toBe('2rem');
    style.remove();
  });
});
