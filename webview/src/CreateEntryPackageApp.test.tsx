// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateEntryPackageApp } from './CreateEntryPackageApp';
import type { VsCodeApi } from './vscodeApi';

const postMessage = vi.fn();

beforeEach(() => {
  postMessage.mockClear();
  (globalThis as { __snlApi?: VsCodeApi }).__snlApi = { postMessage };
});
afterEach(() => {
  cleanup();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
  document.documentElement.lang = '';
});

describe('CreateEntryPackageApp', () => {
  it('submits a genuine Entry Package payload and provides Dashboard back navigation', async () => {
    render(<CreateEntryPackageApp />);
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(screen.queryByRole('button', { name: 'Refresh this panel from disk' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Package ID'), { target: { value: 'logic' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Logic' } });
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'Logical entries' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Entry Package' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Dashboard' }));
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'create', id: 'logic', name: 'Logic', description: 'Logical entries'
      });
      expect(postMessage).toHaveBeenCalledWith({ type: 'nav.openDashboard' });
    });
  });

  it('rejects invalid identities in the UI and localizes Simplified Chinese copy', () => {
    document.documentElement.lang = 'zh-CN';
    render(<CreateEntryPackageApp />);
    fireEvent.change(screen.getByLabelText('包 ID'), { target: { value: '../bad' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '名称' } });
    expect((screen.getByRole('button', { name: '创建条目包' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('稳定标识：字母、数字、点、下划线或连字符。')).toBeTruthy();
  });

  it.each([
    ['en', 'Package ID', 'Display name', 'Create Entry Package', 'Enter a valid Package ID.',
      'This Package ID is reserved by Windows.'],
    ['zh-CN', '包 ID', '显示名称', '创建条目包', '请输入有效的包 ID。',
      '此包 ID 是 Windows 保留名称。']
  ])('validates ordinary and Windows-reserved IDs in %s', async (
    language, idLabel, nameLabel, createLabel, invalidMessage, reservedMessage
  ) => {
    document.documentElement.lang = language;
    render(<CreateEntryPackageApp />);
    const idInput = screen.getByLabelText(idLabel);
    const nameInput = screen.getByLabelText(nameLabel);
    const createButton = screen.getByRole('button', { name: createLabel }) as HTMLButtonElement;
    fireEvent.change(nameInput, { target: { value: 'Logic' } });

    fireEvent.change(idInput, { target: { value: '../bad' } });
    expect(createButton.disabled).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'invalid', code: 'invalid-format' }
    }));
    expect((await screen.findByRole('alert')).textContent).toBe(invalidMessage);

    for (const reserved of ['con', 'PRN', 'LPT1']) {
      fireEvent.change(idInput, { target: { value: reserved } });
      expect(createButton.disabled, reserved).toBe(true);
    }
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'invalid', code: 'reserved-windows-name' }
    }));
    expect((await screen.findByRole('alert')).textContent).toBe(reservedMessage);

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'invalid', code: 'name-required' }
    }));
    expect((await screen.findByRole('alert')).textContent)
      .toBe(language === 'zh-CN' ? '显示名称为必填项。' : 'Display name is required.');

    fireEvent.change(idInput, { target: { value: 'logic.valid-1' } });
    expect(createButton.disabled).toBe(false);
  });
});
