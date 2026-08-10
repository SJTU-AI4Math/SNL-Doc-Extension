import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KindEditorApp } from './KindEditorApp';
import { InitKindsApp } from './InitKindsApp';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('Kind panel localization', () => {
  it('renders the entry Kind editor in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<KindEditorApp domain="entry" />);
    expect(view.getByRole('heading', { name: '创建条目类型' })).toBeTruthy();
    expect(view.getByText('显示名称')).toBeTruthy();
    expect(view.getByText('默认计数器名称')).toBeTruthy();
    expect(view.getByText('浅色主题')).toBeTruthy();
    expect(view.getByText('深色主题')).toBeTruthy();
    expect(view.getByLabelText('浅色描边颜色值')).toBeTruthy();
    expect(view.getByLabelText('深色背景颜色值')).toBeTruthy();
    expect(view.getAllByText(/预览/)).toHaveLength(2);
    expect(view.getByRole('button', { name: '创建条目类型' })).toBeTruthy();
  });

  it('renders the Kind preset loading state in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<InitKindsApp domain="macro" />);
    expect(view.getByRole('heading', { name: '初始化宏类型' })).toBeTruthy();
    expect(view.getByText('正在加载预设…')).toBeTruthy();
  });
});
