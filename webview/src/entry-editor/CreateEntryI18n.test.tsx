import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
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

function sendCreateContext(openPackageCreator = false): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'context',
      targetGeneration: 0,
      mode: 'create',
      id: 'new-entry',
      openPackageCreator,
      kinds: [{
        id: 'theorem',
        name: { type: 'i18n', default_language: 'en', values: { en: 'Theorem', 'zh-CN': '定理' } },
        description: {
          type: 'i18n', default_language: 'en',
          values: { en: 'A mathematical statement.', 'zh-CN': '数学陈述。' }
        },
        coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } },
        numbering: 'theorem',
        style: 'default'
      }],
      entryPackages: ['_unpackaged', 'core'],
      selectedPackage: 'core',
      existingIds: [],
      relationships: []
    }
  }));
}

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

describe('CreateEntryApp localization', () => {
  it('accepts a correlated package-creator command without clearing the draft', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext();
    const title = await view.findByLabelText('标题') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '未保存的标题' } });

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'openPackageCreator', targetGeneration: 0 }
    }));

    await waitFor(() => expect(view.getByLabelText('新条目包 ID')).toBeTruthy());
    expect(title.value).toBe('未保存的标题');
  });

  it('opens the Entry Package creator when routed from the cat navigation menu', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext(true);

    await waitFor(() => expect(view.getByLabelText('新条目包 ID')).toBeTruthy());
    expect(view.getByRole('button', { name: '添加条目包' })).toBeTruthy();
  });

  it('renders the create form and secondary sections in Simplified Chinese', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext();

    await waitFor(() => expect(view.getByRole('heading', { name: '创建条目' })).toBeTruthy());
    expect(view.getByLabelText('标题').getAttribute('placeholder')).toBe('例如：勾股定理');
    const titleLanguage = view.getByLabelText('标题语言: 通用');
    fireEvent.click(titleLanguage);
    fireEvent.click(view.getByText('English', { selector: 'span' }).closest('button')!);
    expect(view.getByLabelText('标题语言: English')).toBeTruthy();
    expect(view.getByLabelText('ID').getAttribute('placeholder')).toBe('例如：pythagorean-theorem');
    expect(view.getByLabelText('条目包')).toHaveProperty('readOnly', true);
    expect(view.getByLabelText('条目包').tagName).toBe('INPUT');
    const kindPicker = view.getByRole('combobox', { name: '条目类别：定理' });
    fireEvent.click(kindPicker);
    expect(view.getByText(/数学陈述。/)).toBeTruthy();
    act(() => set_content_language('en'));
    await waitFor(() => expect(view.getByRole('combobox', { name: '条目类别：Theorem' })).toBeTruthy());
    expect(view.getByText(/A mathematical statement\./)).toBeTruthy();
    expect(view.queryByText('宏包')).toBeNull();
    expect(view.queryByText('种类')).toBeNull();
    expect(view.getByRole('button', { name: '创建条目' })).toBeTruthy();
    expect(view.getByText('内容')).toBeTruthy();

    const pointerHeading = view.getByText('指针', { selector: 'span[role="heading"]' });
    fireEvent.click(pointerHeading.closest('button')!);
    const pointer = view.getByTestId('entry-pointer-editor');
    expect(within(pointer).getByText('将此条目绑定到源代码位置')).toBeTruthy();
    expect(within(pointer).getByText('尚未附加源代码位置。启用绑定后即可选择文件和寻址模式。')).toBeTruthy();
    fireEvent.click(within(pointer).getByLabelText('将此条目绑定到源代码位置'));
    expect(within(pointer).getByLabelText('项目相对路径文件').getAttribute('placeholder'))
      .toBe('例如：src/theorems/pythagorean.ts');
  });

  it('gives each localized content editor its own General language selector', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext();
    await waitFor(() => expect(view.getByRole('heading', { name: '创建条目' })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: '文本' }));
    const selector = view.getByLabelText('TEXT 内容语言: 通用');
    fireEvent.click(selector);
    fireEvent.click(view.getByText('English', { selector: 'span' }).closest('button')!);
    expect(view.getByLabelText('TEXT 内容语言: English')).toBeTruthy();
    act(() => set_content_language('en'));
    expect(view.getByLabelText('TEXT 内容语言: English')).toBeTruthy();
  });

  it('keeps the title input and caret stable when a specific-locale edit creates I18N', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext();
    const title = await view.findByLabelText('标题') as HTMLInputElement;
    fireEvent.input(title, { target: { value: 'abcdef' } });
    fireEvent.click(view.getByLabelText('标题语言: 通用'));
    fireEvent.click(view.getByText('简体中文', { selector: 'span' }).closest('button')!);

    title.focus();
    title.setSelectionRange(3, 3);
    fireEvent.input(title, {
      target: { value: 'abcXdef', selectionStart: 4, selectionEnd: 4 }
    });

    const titleAfterEdit = view.getByLabelText('标题') as HTMLInputElement;
    expect(titleAfterEdit).toBe(title);
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(4);
    expect(title.selectionEnd).toBe(4);

    fireEvent.input(view.getByLabelText('ID'), { target: { value: 'caret-stable-title' } });
    fireEvent.click(view.getByRole('button', { name: '创建条目' }));
    const create = postMessage.mock.calls.map(([message]) => message)
      .find((message) => message?.type === 'create');
    expect(create?.entry.title).toEqual({
      type: 'i18n', default_language: 'zh-CN', values: { 'zh-CN': 'abcXdef' }
    });
  });

  it('keeps the General title input stable during an ordinary edit', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext();
    const title = await view.findByLabelText('标题') as HTMLInputElement;
    fireEvent.input(title, { target: { value: 'abcdef' } });
    title.focus();
    title.setSelectionRange(3, 3);

    fireEvent.input(title, {
      target: { value: 'abcXdef', selectionStart: 4, selectionEnd: 4 }
    });

    expect(view.getByLabelText('标题')).toBe(title);
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(4);
    expect(title.selectionEnd).toBe(4);
    expect(view.getByLabelText('标题语言: 通用')).toBeTruthy();

    fireEvent.input(view.getByLabelText('ID'), { target: { value: 'general-caret-stable-title' } });
    fireEvent.click(view.getByRole('button', { name: '创建条目' }));
    const create = postMessage.mock.calls.map(([message]) => message)
      .find((message) => message?.type === 'create');
    expect(create?.entry.title).toBe('abcXdef');
  });

  it('keeps an existing I18N title input stable during a locale edit', async () => {
    const view = render(<CreateEntryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'context', targetGeneration: 1, mode: 'edit', id: 'existing-i18n',
        kinds: [{ id: 'theorem', name: 'Theorem', coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } }, numbering: 'theorem', style: 'default' }],
        entryPackages: ['_unpackaged'], existingIds: [], relationships: [], entryRevision: 'rev-1',
        existing: {
          id: 'existing-i18n', package: '_unpackaged', kind: 'theorem',
          title: {
            type: 'i18n', default_language: 'zh-CN',
            values: { 'zh-CN': 'abcdef', en: 'Distinct English title' }
          },
          content: {}, pointer: null
        }
      }
    }));
    const title = await view.findByLabelText('标题') as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe('abcdef'));
    title.focus();
    title.setSelectionRange(3, 3);

    fireEvent.input(title, {
      target: { value: 'abcXdef', selectionStart: 4, selectionEnd: 4 }
    });

    expect(view.getByLabelText('标题')).toBe(title);
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(4);
    expect(title.selectionEnd).toBe(4);
    expect(view.getByLabelText('标题语言: 简体中文')).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: '更新条目' }));
    const update = postMessage.mock.calls.map(([message]) => message)
      .find((message) => message?.type === 'update');
    expect(update?.entry.title).toEqual({
      type: 'i18n', default_language: 'zh-CN',
      values: { 'zh-CN': 'abcXdef', en: 'Distinct English title' }
    });
  });

  it('resets title language for a new authoritative target but preserves a same-target draft', async () => {
    const editContext = (id: string, title: unknown, targetGeneration: number) => ({
      type: 'context', targetGeneration, mode: 'edit', id,
      kinds: [{ id: 'theorem', name: 'Theorem', coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } }, numbering: 'theorem', style: 'default' }],
      entryPackages: ['_unpackaged'], existingIds: [], relationships: [], entryRevision: `rev-${targetGeneration}`,
      existing: { id, package: '_unpackaged', kind: 'theorem', title, content: {}, pointer: null }
    });
    const view = render(<CreateEntryApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: editContext('entry-a', {
        type: 'i18n', default_language: 'en', values: { en: 'Entry A', 'zh-CN': '条目 A' }
      }, 1)
    }));
    await view.findByDisplayValue('Entry A');
    fireEvent.click(view.getByLabelText('标题语言: English'));
    fireEvent.click(view.getByText('简体中文', { selector: 'span' }).closest('button')!);
    const title = view.getByLabelText('标题') as HTMLInputElement;
    fireEvent.input(title, { target: { value: '未保存的 A' } });

    window.dispatchEvent(new MessageEvent('message', {
      data: editContext('entry-a', {
        type: 'i18n', default_language: 'en', values: { en: 'External A', 'zh-CN': '外部 A' }
      }, 1)
    }));
    await waitFor(() => expect(title.value).toBe('未保存的 A'));
    expect(view.getByLabelText('标题语言: 简体中文')).toBeTruthy();

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'retarget', mode: 'edit', id: 'entry-b', targetGeneration: 2 }
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: editContext('entry-b', {
        type: 'i18n', default_language: 'en', values: { en: 'Entry B', 'zh-CN': '条目 B' }
      }, 2)
    }));

    await waitFor(() => expect((view.getByLabelText('标题') as HTMLInputElement).value).toBe('Entry B'));
    expect(view.getByLabelText('标题语言: English')).toBeTruthy();
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
