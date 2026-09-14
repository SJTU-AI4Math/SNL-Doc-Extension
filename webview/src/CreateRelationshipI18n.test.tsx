import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateRelationshipApp } from './CreateRelationshipApp';

afterEach(() => {
  cleanup();
  delete (globalThis as { __snlApi?: unknown }).__snlApi;
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
  it.each([
    ['en', 'Saved relationship record — may differ from the current graph.', 'Metadata (optional, raw JSON — empty ⇒ null)'],
    ['zh-CN', '已保存的关系记录，可能不同于当前关系图。', '元数据（可选，原始 JSON；留空 ⇒ null）']
  ])('shows the saved source and original witness in %s', (language, source, metadataLabel) => {
    document.documentElement.lang = language;
    const view = render(<CreateRelationshipApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', source: 'saved', mode: 'edit', id: 'dep.A.B', readOnly: true,
      existing: { id: 'dep.A.B', from: 'A', to: 'B', label: 'depends', metadata: { generator: 'macro-source-scan', macros: ['oldWitness'] } },
      entryPool: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }], existingIds: ['dep.A.B']
    } })));
    expect(view.getByText(source)).toBeTruthy();
    expect((view.getByLabelText(metadataLabel) as HTMLTextAreaElement).value).toContain('oldWitness');
    expect(view.container.querySelector('fieldset[disabled]')).toBeTruthy();
  });
  it('keeps saved manual edits and CAS while isolating current drafts and rejecting unknown sources', () => {
    const postMessage = vi.fn();
    (globalThis as { __snlApi?: unknown }).__snlApi = {
      postMessage,
      getState: () => ({ 'editor-draft:relationship:edit:manual': { id: 'manual', from: 'B', to: 'A', label: 'WRONG CURRENT DRAFT', metadata: '', expectedRevision: 'wrong' } }),
      setState: vi.fn()
    };
    const view = render(<CreateRelationshipApp />);
    const context = { type: 'context', source: 'saved', mode: 'edit', id: 'manual', readOnly: false, relationshipRevision: 'saved-revision',
      existing: { id: 'manual', from: 'A', to: 'B', label: 'manual label', metadata: null },
      entryPool: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }], existingIds: ['manual'] };
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { ...context, source: 'invented' } })));
    expect(view.getByText('Loading relationship context…')).toBeTruthy();
    act(() => window.dispatchEvent(new MessageEvent('message', { data: context })));
    expect((view.getByLabelText('Label (required)') as HTMLInputElement).value).toBe('manual label');
    expect(view.container.querySelector('fieldset[disabled]')).toBeNull();
    fireEvent.change(view.getByLabelText('Label (required)'), { target: { value: 'edited' } });
    fireEvent.click(view.getByRole('button', { name: 'Save Changes' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'update', relationship: { id: 'manual', from: 'A', to: 'B', label: 'edited', metadata: null }, expectedRevision: 'saved-revision' });
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
