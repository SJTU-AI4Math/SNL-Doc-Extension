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
const { set_content_language } = await import('./runtime/preferencesRuntime');

const languages = [
  { id: 'en', display_name: 'English (US)' },
  { id: 'zh-CN', display_name: '简体中文（中国大陆）' }
];

function sendContext(
  existing: Record<string, unknown>,
  kindRevision = 'revision-1',
  id = 'theorem'
): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', id, targetState: 'found',
      kindRevision, existingIds: [], existing, languages
    }}));
  });
}

async function submittedPayload(type: 'create' | 'update'): Promise<Record<string, unknown>> {
  await waitFor(() => expect(posted.some((message) => (message as { type?: string }).type === type)).toBe(true));
  return (posted.find((message) => (message as { type?: string }).type === type) as {
    payload: Record<string, unknown>
  }).payload;
}

afterEach(() => {
  cleanup();
  posted.length = 0;
  document.documentElement.lang = 'en';
  set_content_language('en');
});

describe('Entry Kind localized editor', () => {
  it('submits complete localized name and description with explicit dark colors', async () => {
    render(<KindEditorApp domain="entry" />);
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'context', mode: 'create', targetState: 'found', existingIds: [], languages
      }}));
    });

    fireEvent.change(await screen.findByLabelText('ID'), { target: { value: 'theorem' } });
    expect((screen.getByLabelText('Entry Kind language') as HTMLSelectElement).value).toBe('__snl_general__');
    fireEvent.change(screen.getByLabelText('Entry Kind language'), { target: { value: 'en' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Theorem' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'A proved result.' } });
    fireEvent.change(screen.getByLabelText('Entry Kind language'), { target: { value: 'zh-CN' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '定理' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '已经证明的结果。' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Entry Kind' }));

    const payload = await submittedPayload('create');
    expect(payload.name).toEqual({
      type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' }
    });
    expect(payload.description).toEqual({
      type: 'i18n', default_language: 'en', values: { en: 'A proved result.', 'zh-CN': '已经证明的结果。' }
    });
    expect(payload.coloring).toMatchObject({
      light: { stroke: expect.any(String), background: expect.any(String) },
      dark: { stroke: expect.any(String), background: expect.any(String) }
    });
  });

  it('selects General for plain fields and preserves plain strings when editing General', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'theorem', name: 'Invariant theorem', description: 'Invariant description'
    });

    expect((await screen.findByLabelText('Entry Kind language') as HTMLSelectElement).value).toBe('__snl_general__');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Invariant theorem');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Edited invariant theorem' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Edited invariant description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Entry Kind' }));

    const payload = await submittedPayload('update');
    expect(payload.name).toBe('Edited invariant theorem');
    expect(payload.description).toBe('Edited invariant description');
  });

  it('creates only the selected projection when a plain field is switched to a specific language', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'theorem', name: 'Invariant theorem', description: 'Invariant description'
    });

    fireEvent.change(await screen.findByLabelText('Entry Kind language'), { target: { value: 'zh-CN' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '定理' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '描述' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Entry Kind' }));

    const payload = await submittedPayload('update');
    expect(payload.name).toEqual({
      type: 'i18n', default_language: 'zh-CN', values: { 'zh-CN': '定理' }
    });
    expect(payload.description).toEqual({
      type: 'i18n', default_language: 'zh-CN', values: { 'zh-CN': '描述' }
    });
    expect(JSON.stringify(payload)).not.toContain('Invariant theorem');
    expect(JSON.stringify(payload)).not.toContain('Invariant description');
  });

  it('materializes both displayed General fields on a direct save without typing', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'theorem',
      name: {
        type: 'i18n', default_language: 'en', extension: 'name-extension',
        values: { en: 'GENERAL-NAME', 'zh-CN': 'ZH-NAME', ja: 'JA-NAME' }
      },
      description: {
        type: 'i18n', default_language: 'en', extension: 'description-extension',
        values: { en: 'GENERAL-DESCRIPTION', 'zh-CN': 'ZH-DESCRIPTION', ja: 'JA-DESCRIPTION' }
      }
    });

    const selector = await screen.findByLabelText('Entry Kind language') as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: '__snl_general__' } });
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('GENERAL-NAME');
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('GENERAL-DESCRIPTION');
    // Selection is projection-only before acknowledgment: switching back recovers the raw map.
    fireEvent.change(selector, { target: { value: 'zh-CN' } });
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('ZH-NAME');
    fireEvent.change(selector, { target: { value: '__snl_general__' } });
    act(() => set_content_language('zh-CN'));
    expect(selector.value).toBe('__snl_general__');

    const save = screen.getByRole('button', { name: 'Update Entry Kind' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const payload = await submittedPayload('update');
    expect(payload.name).toBe('GENERAL-NAME');
    expect(payload.description).toBe('GENERAL-DESCRIPTION');
    expect(JSON.stringify(payload)).not.toContain('__snl_general__');
  });

  it('resets a retained edit scope when the authoritative Kind target changes', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'kind-a',
      name: { type: 'i18n', default_language: 'en', values: { en: 'Kind A', 'zh-CN': '类型甲' } },
      description: { type: 'i18n', default_language: 'en', values: { en: 'Description A', 'zh-CN': '描述甲' } }
    }, 'revision-a', 'kind-a');

    const selector = await screen.findByLabelText('Entry Kind language') as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'zh-CN' } });
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('类型甲');
    fireEvent.click(screen.getByRole('button', { name: 'Update Entry Kind' }));
    await submittedPayload('update');
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'updated', kind: { id: 'kind-a', name: '类型甲' }
    }})));
    posted.length = 0;

    sendContext({
      id: 'kind-b', name: 'Kind B', description: 'Description B'
    }, 'revision-b', 'kind-b');

    await waitFor(() => expect(
      (screen.getByLabelText('Entry Kind language') as HTMLSelectElement).value
    ).toBe('__snl_general__'));
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Kind B');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Edited Kind B' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Edited Description B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Entry Kind' }));

    const payload = await submittedPayload('update');
    expect(payload.name).toBe('Edited Kind B');
    expect(payload.description).toBe('Edited Description B');
  });

  it('preserves a selected locale and draft on a same-target watcher refresh', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'theorem',
      name: { type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' } },
      description: { type: 'i18n', default_language: 'en', values: { en: 'Description', 'zh-CN': '描述' } }
    });

    const selector = await screen.findByLabelText('Entry Kind language') as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'zh-CN' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '草稿定理' } });
    sendContext({
      id: 'theorem',
      name: { type: 'i18n', default_language: 'en', values: { en: 'External', 'zh-CN': '外部定理' } },
      description: { type: 'i18n', default_language: 'en', values: { en: 'External description', 'zh-CN': '外部描述' } }
    }, 'revision-2');

    await waitFor(() => expect(selector.value).toBe('zh-CN'));
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('草稿定理');
  });

  it('does not retarget the selected edit scope when the panel reading language changes', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'theorem',
      name: { type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' } },
      description: { type: 'i18n', default_language: 'en', values: { en: 'Description', 'zh-CN': '描述' } }
    });

    const selector = await screen.findByLabelText('Entry Kind language') as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: 'zh-CN' } });
    act(() => set_content_language('fr'));
    expect(selector.value).toBe('zh-CN');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('定理');
  });

  it('edits only the selected locale and preserves every own locale and default language', async () => {
    render(<KindEditorApp domain="entry" />);
    sendContext({
      id: 'theorem',
      name: { type: 'i18n', default_language: 'fr', extension: 'name-extension', values: { fr: 'Théorème', en: 'Theorem', 'zh-CN': '旧定理', ja: '定理' } },
      description: { type: 'i18n', default_language: 'fr', extension: 'description-extension', values: { fr: 'Description', en: 'English description', 'zh-CN': '旧描述', ja: '説明' } }
    });

    fireEvent.change(await screen.findByLabelText('Entry Kind language'), { target: { value: 'zh-CN' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '新定理' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '新描述' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Entry Kind' }));

    const payload = await submittedPayload('update');
    expect(payload.name).toEqual({
      type: 'i18n', default_language: 'fr', extension: 'name-extension', values: { fr: 'Théorème', en: 'Theorem', 'zh-CN': '新定理', ja: '定理' }
    });
    expect(payload.description).toEqual({
      type: 'i18n', default_language: 'fr', extension: 'description-extension', values: { fr: 'Description', en: 'English description', 'zh-CN': '新描述', ja: '説明' }
    });
  });
});
