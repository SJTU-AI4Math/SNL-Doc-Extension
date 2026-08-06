import { act, cleanup, render, waitFor } from '@testing-library/react';
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

const { InitKindsApp } = await import('./InitKindsApp');

afterEach(() => {
  cleanup();
  posted.length = 0;
  document.documentElement.lang = 'en';
});

describe('Init Kinds live locale refresh', () => {
  it('requests a fresh host preset projection after a preference generation update', async () => {
    render(<InitKindsApp domain="entry" />);
    await waitFor(() => expect(posted.filter((m) => (m as { type?: string }).type === 'ready')).toHaveLength(1));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'snl.preferences/snapshot', generation: 'locale-refresh-test', revision: 1,
        preferences: { language: 'zh-CN', language_preference: 'zh-CN', color_scheme: 'dark', motion: 'full' }
      }}));
    });

    await waitFor(() => expect(posted.filter((m) => (m as { type?: string }).type === 'ready')).toHaveLength(2));
  });
});
