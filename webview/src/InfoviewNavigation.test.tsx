// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn()
}));

vi.mock('./vscodeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vscodeApi')>()),
  getVsCodeApi: () => api,
  useVsCodeApiRef: () => ({ current: api })
}));

import { App } from './App';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
  api.postMessage.mockReset();
  api.getState.mockReset();
  api.setState.mockReset();
});

describe('Infoview navigation', () => {
  it('shows library read failures instead of an empty catalog and retries', () => {
    const view = render(<App />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'librariesError', message: 'meta.json is malformed' }
      }));
    });

    expect(view.getByRole('alert').textContent).toContain(
      'Could not load libraries: meta.json is malformed'
    );
    expect(view.queryByText(/No libraries yet/)).toBeNull();

    api.postMessage.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('uses the explicit back transition from a directly opened Library', () => {
    const view = render(<App />);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'ready' });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'libraryEntries',
          slug: 'algebra',
          title: 'Algebra',
          entries: [],
          outline: [],
          warnings: []
        }
      }));
    });

    api.postMessage.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Back to libraries' }));
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'back' });
  });

  it('shows the localized command title in the Chinese empty state', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<App />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'libraries', libraries: [] }
      }));
    });
    expect(view.getByText('SNL：创建文档库')).toBeTruthy();
  });
});
