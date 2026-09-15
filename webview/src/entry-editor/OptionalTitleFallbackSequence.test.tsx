import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import type { VsCodeApi } from '../vscodeApi';
import { set_content_language } from '../runtime/preferencesRuntime';

const postMessage = vi.fn();
const api: VsCodeApi = {
  postMessage,
  getState: () => undefined,
  setState: () => undefined
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

beforeEach(() => {
  postMessage.mockClear();
  document.documentElement.lang = 'zh-CN';
  set_content_language('zh-CN');
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'snl.preferences/snapshot', generation: 'entry-i18n-test', revision: 1,
      preferences: { language: 'zh-CN', color_scheme: 'dark', motion: 'full' },
      supported_languages: [
        { id: 'zh-CN', display_name: '简体中文' },
        { id: 'en', display_name: 'English' }
      ]
    }
  }));
});

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

// Whole original oracle: c8e155fefcd18e65 / 5ac0d837805f8f13c278a0b727e8e8f10ab48b9b.
// Keep missing-default -> fallback -> outer locale change -> edit -> whole-map Save ordered.
describe('Optional Title fallback composed integration sequence', () => {
  // Additional boundary controls; not substitutes for the byte-exact historical callback below.
  it.each(['omitted', 'empty'] as const)('preserves identity for an %s Title across language change, rejection and authored Save', async (variant) => {
    const view = render(<CreateEntryApp />);
    const id = `untitled-${variant}`;
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', targetGeneration: 0, mode: 'edit', id,
      kinds: [{ id: 'theorem', name: 'Theorem', coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } }, numbering: 'theorem', style: 'default' }],
      entryPackages: ['_unpackaged'], existingIds: [], relationships: [], entryRevision: 'rev-empty-1',
      existing: {
        id, package: '_unpackaged', kind: 'theorem',
        ...(variant === 'empty' ? { title: '' } : {}), content: {}, pointer: null
      }
    } }));
    const title = await view.findByLabelText('标题') as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe(''));
    expect((view.getByDisplayValue(id) as HTMLInputElement).value).toBe(id);
    expect(view.getByRole('button', { name: `在信息视图阅读界面中打开条目“${id}”` })).toBeTruthy();
    expect(view.getByLabelText('标题语言: 通用')).toBeTruthy();
    act(() => set_content_language('en'));
    expect(view.getByLabelText('标题')).toBe(title);
    expect(title.value).toBe('');
    expect((view.getByDisplayValue(id) as HTMLInputElement).value).toBe(id);
    expect(view.getByRole('button', { name: `在信息视图阅读界面中打开条目“${id}”` })).toBeTruthy();
    const save = view.getByRole('button', { name: '更新条目' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(postMessage.mock.calls.filter(([message]) => message?.type === 'update')).toHaveLength(0);
    fireEvent.change(title, { target: { value: 'Authored title' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const updates = postMessage.mock.calls.map(([message]) => message)
      .filter((message) => message?.type === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0].entry).toMatchObject({ id, package: '_unpackaged', kind: 'theorem', title: 'Authored title' });
    expect(updates[0].expectedRevision).toBe('rev-empty-1');
  });

  it('gives the title editor its own language selector independent from panel content language', async () => {
    const view = render(<CreateEntryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', targetGeneration: 0, mode: 'edit', id: 'localized-entry',
        kinds: [{ id: 'theorem', name: 'Theorem', coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } }, numbering: 'theorem', style: 'default' }],
        entryPackages: ['_unpackaged'], existingIds: [], relationships: [], entryRevision: 'rev-1',
        existing: {
          id: 'localized-entry', package: '_unpackaged', kind: 'theorem',
          title: { type: 'i18n', default_language: 'en', values: { 'zh-CN': '中文标题' } },
          content: {}, pointer: null
        }
      }
    }));

    await view.findByLabelText('标题');
    await waitFor(() => expect((view.getByLabelText('标题') as HTMLInputElement).value).toBe('中文标题'));
    expect(view.getByLabelText('标题语言: English')).toBeTruthy();
    act(() => set_content_language('en'));
    await waitFor(() => expect((view.getByLabelText('标题') as HTMLInputElement).value).toBe('中文标题'));
    expect(view.getByText('正在显示来自 zh-CN 的回退标题')).toBeTruthy();
    expect(view.getByRole('heading', { name: '编辑条目' })).toBeTruthy();
    expect(view.getByLabelText('条目包')).toHaveProperty('readOnly', true);
    expect(view.getByLabelText('条目包').tagName).toBe('INPUT');

    fireEvent.change(view.getByLabelText('标题'), { target: { value: 'English title' } });
    fireEvent.click(view.getByRole('button', { name: '更新条目' }));
    const update = postMessage.mock.calls.map(([message]) => message)
      .find((message) => message?.type === 'update');
    expect(update?.entry.title).toEqual({
      type: 'i18n', default_language: 'en',
      values: { 'zh-CN': '中文标题', en: 'English title' }
    });
  });
});
