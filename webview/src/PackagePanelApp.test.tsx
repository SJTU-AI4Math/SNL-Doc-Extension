// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PackagePanelApp } from './PackagePanelApp';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();

describe('Macro package panel Chinese localization', () => {
  beforeEach(() => {
    document.documentElement.lang = 'zh-CN';
    (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
  });

  afterEach(() => {
    cleanup();
    postMessage.mockClear();
    document.documentElement.lang = '';
    delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
  });

  it('renders loading, package actions, and empty state in Simplified Chinese', async () => {
    render(<PackagePanelApp />);
    expect(screen.getByText('正在加载宏包…')).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回仪表板' })).toBeTruthy();

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'package',
        pkg: { version: '9', name: '示例包', description: '', macros: {} },
        file: 'sample', macros: [], workspaceMacros: {}, macroKinds: [],
        otherPackages: [], active: true, entryPoolIds: []
      }
    }));

    expect(await screen.findByText('暂无宏——请使用下方按钮创建第一个宏。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择' }).textContent).toContain('选择');
    const editPackage = screen.getByRole('button', { name: '编辑宏包' });
    expect(editPackage.getAttribute('title')).toBe('编辑宏包名称 / 说明');
    expect(screen.getByRole('button', { name: '创建宏' })).toBeTruthy();
    expect(screen.getByText('启用')).toBeTruthy();
    expect(screen.queryByText('No macros yet — use the bar below to create the first one.')).toBeNull();
  });

  it('localizes the batch transfer modal and validation', async () => {
    render(<PackagePanelApp />);
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'package',
        pkg: { version: '9', name: '示例包', macros: {} },
        file: 'sample',
        macros: [{
          name: 'alpha', description: 'dynamic data',
          source: { entries: [], urls: [] }, dynamic_arity: false,
          styles: [{ style_name: 'default', mode: 'formula_inline', template: '', tags: [] }],
          tags: []
        }],
        workspaceMacros: {}, macroKinds: [], otherPackages: [],
        active: true, entryPoolIds: []
      }
    }));

    fireEvent.click(await screen.findByRole('button', { name: '选择' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择宏 alpha' }));
    const transferButton = screen.getByRole('button', { name: '复制 / 移动…' });
    expect(transferButton.getAttribute('title')).toBe('将所选宏复制或移动到其他宏包');
    expect(transferButton.textContent).toContain('复制 / 移动…');
    fireEvent.click(transferButton);
    expect(screen.getByRole('heading', { name: '复制 / 移动宏' })).toBeTruthy();
    expect(screen.getByText('目标宏包')).toBeTruthy();
    const fileInput = screen.getByPlaceholderText('my_new_package');
    fireEvent.change(fileInput, { target: { value: 'bad name' } });
    expect(screen.getByText('只能使用字母、数字、连字符和下划线。')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '取消' })).toHaveLength(2);
  });
});
