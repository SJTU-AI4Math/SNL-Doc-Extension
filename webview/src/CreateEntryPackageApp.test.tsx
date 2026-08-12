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
});
