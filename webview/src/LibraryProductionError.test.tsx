// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { VsCodeApi } from './vscodeApi';

import { apply_preferences_snapshot } from './runtime/preferencesRuntime';

const postMessage = vi.fn();

let localeRevision = 0;
function setLocale(language: 'en' | 'zh-CN') {
  act(() => {
    expect(apply_preferences_snapshot({
      type: 'snl.preferences/snapshot', generation: 'library-i18n-test', revision: ++localeRevision,
      preferences: { language, language_preference: language, color_scheme: 'dark', motion: 'full' }
    })).toBe(true);
  });
}


beforeEach(() => {
  setLocale('en');
  postMessage.mockClear();
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
});

afterEach(() => {
  cleanup();
  setLocale('en');
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Library Infoview fatal graph errors', () => {
  it('localizes an already visible unavailable Library without changing retry identity or provider detail', async () => {
    render(<App />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'libraryEntriesError', slug: 'notes', message: 'Provider denied notes'
    }})));
    expect(await screen.findByText('Library unavailable: notes')).toBeTruthy();
    setLocale('zh-CN');
    expect(await screen.findByText('文档库不可用：notes')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Provider denied notes');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'selectLibrary', slug: 'notes' });
  });
  it('shows an explicit invalid-library state instead of an empty outline', async () => {
    render(<App />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'libraryEntriesError',
        slug: 'notes',
        message: 'Could not resolve Library Entry references: malformed envelope'
      }
    }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/malformed envelope/);
    expect(screen.getByText(/Library unavailable: notes/)).toBeTruthy();
  });
});
