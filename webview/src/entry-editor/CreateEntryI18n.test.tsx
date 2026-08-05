import React from 'react';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import type { VsCodeApi } from '../vscodeApi';

const api: VsCodeApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

function sendCreateContext(): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      type: 'context',
      mode: 'create',
      id: 'new-entry',
      kinds: [{
        id: 'theorem',
        name: 'Theorem',
        coloring: { stroke: '#888', background: '#222' },
        numbering: 'theorem',
        style: 'default'
      }],
      packages: ['core'],
      existingIds: [],
      relationships: []
    }
  }));
}

beforeEach(() => {
  document.documentElement.lang = 'zh-CN';
});

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('CreateEntryApp localization', () => {
  it('renders the create form and secondary sections in Simplified Chinese', async () => {
    const view = render(<CreateEntryApp />);
    sendCreateContext();

    await waitFor(() => expect(view.getByRole('heading', { name: '创建条目' })).toBeTruthy());
    expect(view.getByLabelText('标题').getAttribute('placeholder')).toBe('例如：勾股定理');
    expect(view.getByLabelText('ID').getAttribute('placeholder')).toBe('例如：pythagorean-theorem');
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
});
