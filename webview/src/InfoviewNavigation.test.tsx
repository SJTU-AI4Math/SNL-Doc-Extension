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
  it('localizes the fallback for a malformed library error payload', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<App />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'librariesError', message: '' }
      }));
    });
    expect(view.getByRole('alert').textContent).toContain('未知错误');
    document.documentElement.lang = 'en';
  });

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

  it('localizes a failed Library title and back action while preserving the host diagnostic and retry target', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<App />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'libraryEntriesError', slug: 'analysis', message: 'AUTHOR-DIAGNOSTIC'
    } })));
    expect(view.getByRole('heading', { name: '文档库不可用：analysis' })).toBeTruthy();
    expect(view.getByRole('alert').textContent).toBe('AUTHOR-DIAGNOSTIC');
    api.postMessage.mockClear();
    fireEvent.click(view.getByRole('button', { name: '重试' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'selectLibrary', slug: 'analysis' });
    api.postMessage.mockClear();
    fireEvent.click(view.getByRole('button', { name: '← 返回文档库列表' }));
    expect(api.postMessage).toHaveBeenCalledTimes(1);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'back' });
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
    const back = view.getByRole('button', { name: '← Back' });
    expect(back.getAttribute('title')).toBe('Back to libraries');
    fireEvent.click(back);
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
