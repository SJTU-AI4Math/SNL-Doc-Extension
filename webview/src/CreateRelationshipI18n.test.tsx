import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CreateRelationshipApp } from './CreateRelationshipApp';

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
});

describe('Relationship editor localization', () => {
  it('shows automatic dependency provenance and disables editing', () => {
    const view = render(<CreateRelationshipApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', id: 'dep.A.B', readOnly: true,
      existing: { id: 'dep.A.B', from: 'A', to: 'B', label: 'depends', metadata: { generator: 'macro-source-scan' } },
      entryPool: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }], existingIds: ['dep.A.B']
    } })));
    expect(view.getByText(/Automatic dependency.*read-only/i)).toBeTruthy();
    expect((view.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.querySelector('fieldset[disabled]')).toBeTruthy();
  });
  it('renders loading and form copy in Chinese', () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<CreateRelationshipApp />);
    expect(view.getByRole('heading', { name: '创建关系' })).toBeTruthy();
    expect(view.getByText('正在加载关系上下文…')).toBeTruthy();

    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'create', entryPool: [], existingIds: []
    } })));
    expect(view.getByText('ID（必填且唯一）')).toBeTruthy();
    expect(view.getByText('起点（源条目）')).toBeTruthy();
    expect(view.getByText('元数据（可选，原始 JSON；留空 ⇒ null）')).toBeTruthy();
    expect(view.getByRole('button', { name: '创建关系' })).toBeTruthy();
  });
});
