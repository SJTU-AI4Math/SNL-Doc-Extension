import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const { KindEditorApp } = await import('./KindEditorApp');

afterEach(() => {
  cleanup();
  posted.length = 0;
  document.documentElement.lang = 'en';
});

describe('Entry Kind localized editor', () => {
  it('submits complete localized name and description with explicit dark colors', async () => {
    render(<KindEditorApp domain="entry" />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'context', mode: 'create', targetState: 'found', existingIds: [],
        contentLanguage: 'en',
        languages: [
          { id: 'en', display_name: 'English (US)' },
          { id: 'zh-CN', display_name: '简体中文（中国大陆）' }
        ]
      }}));
    });

    fireEvent.change(await screen.findByLabelText('ID'), { target: { value: 'theorem' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Theorem' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A proved result.' } });
    fireEvent.change(screen.getByLabelText('Entry Kind language'), { target: { value: 'zh-CN' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '定理' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '已经证明的结果。' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Entry Kind' }));

    await waitFor(() => expect(posted.some((message) => (message as { type?: string }).type === 'create')).toBe(true));
    const create = posted.find((message) => (message as { type?: string }).type === 'create') as {
      payload: Record<string, unknown>
    };
    expect(create.payload.name).toEqual({
      type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' }
    });
    expect(create.payload.description).toEqual({
      type: 'i18n', default_language: 'en', values: { en: 'A proved result.', 'zh-CN': '已经证明的结果。' }
    });
    expect(create.payload.coloring).toMatchObject({
      light: { stroke: expect.any(String), background: expect.any(String) },
      dark: { stroke: expect.any(String), background: expect.any(String) }
    });
  });

  it('preserves legacy scalar fallbacks when adding another language', async () => {
    render(<KindEditorApp domain="entry" />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'context', mode: 'edit', id: 'theorem', targetState: 'found',
        kindRevision: 'revision-1', existingIds: [],
        existing: {
          id: 'theorem',
          name: '  Theorem  ',
          description: '  A legacy description.  '
        },
        languages: [
          { id: 'en', display_name: 'English (US)' },
          { id: 'zh-CN', display_name: '简体中文（中国大陆）' }
        ]
      }}));
    });

    fireEvent.change(await screen.findByLabelText('Entry Kind language'), { target: { value: 'zh-CN' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '定理' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '旧版描述。' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Entry Kind' }));

    await waitFor(() => expect(posted.some((message) => (message as { type?: string }).type === 'update')).toBe(true));
    const update = posted.find((message) => (message as { type?: string }).type === 'update') as {
      payload: Record<string, unknown>
    };
    expect(update.payload.name).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: '  Theorem  ', 'zh-CN': '定理' }
    });
    expect(update.payload.description).toEqual({
      type: 'i18n', default_language: 'en',
      values: { en: '  A legacy description.  ', 'zh-CN': '旧版描述。' }
    });
  });
});
