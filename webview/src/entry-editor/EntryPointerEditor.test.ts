// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import type { VsCodeApi } from '../vscodeApi';

it('explains higher priority then smaller final scope in the Chinese priority title', async () => {
  const previousLanguage = document.documentElement.lang;
  const host = globalThis as { acquireVsCodeApi?: () => VsCodeApi };
  const previousApi = host.acquireVsCodeApi;
  let state: unknown;
  host.acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => state,
    setState: (next: unknown) => { state = next; }
  });
  document.documentElement.lang = 'zh-CN';
  try {
    const view = render(createElement(CreateEntryApp));
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'context', mode: 'edit', entryRevision: 'pointer-title-revision',
      id: 'thm-1', kinds: [{
        id: 'theorem', name: 'Theorem', numbering: 'theorem', style: 'default',
        coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } }
      }],
      existingIds: [{ id: 'thm-1', title: 'Theorem One' }],
      existing: {
        id: 'thm-1', title: 'Theorem One', kind: 'theorem',
        content: { snl: 'statement' }, contribution_info: null,
        pointer: { file: 'src/a.ts', mode: 'lines', line: 3 }
      }, relationships: []
    } }));
    await waitFor(() => expect((view.getByLabelText('标题') as HTMLInputElement).value).toBe('Theorem One'));
    const button = view.getByText('指针', { selector: 'span[role="heading"]' }).closest('button');
    if (!button) throw new Error('Missing Pointer disclosure');
    fireEvent.click(button);
    const priority = view.getByLabelText('优先级（可选）') as HTMLInputElement;
    expect(priority.title).toContain('优先级较高者优先');
    expect(priority.title).toContain('其次选择最终范围较小者');
  } finally {
    cleanup();
    document.documentElement.lang = previousLanguage;
    if (previousApi) host.acquireVsCodeApi = previousApi;
    else delete host.acquireVsCodeApi;
  }
});
