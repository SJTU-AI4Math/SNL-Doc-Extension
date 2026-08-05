import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateMacroPackageApp } from './CreateMacroPackageApp';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('Macro package editor localization', () => {
  it('renders its create form in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<CreateMacroPackageApp />);
    expect(view.getByRole('heading', { name: '创建宏包' })).toBeTruthy();
    expect(view.getByText('文件名')).toBeTruthy();
    expect(view.getByText('显示名称')).toBeTruthy();
    expect(view.getByText('说明')).toBeTruthy();
    expect(view.getByRole('button', { name: '创建宏包' })).toBeTruthy();
  });
});
