// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryPackagePanelApp } from './EntryPackagePanelApp';
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

const packageMessage = {
  type: 'entryPackage',
  package: { id: 'logic', name: 'Logic', description: 'Logical entries' },
  entries: [{ id: 'def-and', kind: 'definition', title: 'Conjunction', content: { snl: 'and' } }],
  entryKinds: [{
    id: 'definition', name: 'Definition', description: '',
    coloring: { light: { stroke: '#111111', background: '#eeeeee' }, dark: { stroke: '#eeeeee', background: '#111111' } },
    defaultCounterName: 'definition', style: ''
  }],
  metricMacroSources: {},
  metricThresholds: { structuralIndexRedBelow: 60, structuralIndexGreenAtLeast: 80 }
};

describe('EntryPackagePanelApp', () => {
  it('loads one package and routes create, edit, delete, refresh, and back actions', async () => {
    render(<EntryPackagePanelApp />);
    expect(screen.getByText('Loading Entry Package…')).toBeTruthy();
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });

    act(() => window.dispatchEvent(new MessageEvent('message', { data: packageMessage })));

    expect(await screen.findByRole('heading', { name: 'Logic' })).toBeTruthy();
    expect(screen.getByText('logic · 1 entry')).toBeTruthy();
    expect(screen.getByText('Conjunction')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create Entry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit entry Conjunction' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete entry def-and' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh this panel from disk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Dashboard' }));

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({ type: 'createEntry' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'editEntry', id: 'def-and' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'deleteEntry', id: 'def-and' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'nav.refresh' });
      expect(postMessage).toHaveBeenCalledWith({ type: 'nav.openDashboard' });
    });
  });

  it('renders empty, missing, and error states without stale rows', async () => {
    render(<EntryPackagePanelApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { ...packageMessage, entries: [] } })));
    expect(await screen.findByText('No entries yet — create the first one in this package.')).toBeTruthy();

    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'noEntryPackage', packageId: 'gone' } })));
    expect(await screen.findByText('Entry Package gone does not exist.')).toBeTruthy();
    expect(screen.queryByText('Conjunction')).toBeNull();

    act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'malformed envelope' } })));
    expect((await screen.findByRole('alert')).textContent).toContain('malformed envelope');
  });

  it('localizes package management controls in Simplified Chinese', async () => {
    document.documentElement.lang = 'zh-CN';
    render(<EntryPackagePanelApp />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { ...packageMessage, entries: [] } })));
    expect(await screen.findByRole('heading', { name: 'Logic' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建条目' })).toBeTruthy();
    expect(screen.getByText('logic · 0 个条目')).toBeTruthy();
    expect(screen.getByText('暂无条目——请在此包中创建第一个条目。')).toBeTruthy();
  });
});
