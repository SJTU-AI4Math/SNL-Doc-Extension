// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vscodeApi')>()),
  getVsCodeApi: () => api,
  useVsCodeApiRef: () => ({ current: api })
}));

import { EntryInfoviewApp } from './EntryInfoviewApp';

const entry = { id: 'entry-1', package: 'logic', title: 'Entry One', kind: 'definition', content: { snl: 'x' } };
const base = {
  type: 'entryDetails', entry, kind: null, entries: [{ id: 'entry-1', package: 'logic', title: 'Entry One', hasContent: true, snl: 'x' }],
  entryPackages: { 'entry-1': 'logic', 'entry-2': 'logic' }, macros: {}, macroKinds: []
};

function push(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

afterEach(() => {
  cleanup();
  document.documentElement.lang = 'en';
  api.postMessage.mockReset();
});

describe('EntryInfoview relationship availability', () => {
  it('keeps the Entry body available when relationships are unreadable and retries only that region', () => {
    render(<EntryInfoviewApp />);
    push({ ...base, relationshipSections: null, relationshipsError: 'relationships.json has duplicate ids', returnRoute: { kind: 'root' } });

    expect(screen.getByRole('heading', { level: 1, name: 'Entry One' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'Relationships unavailable: relationships.json has duplicate ids'
    );
    expect(screen.queryByText(/Could not load entry data/)).toBeNull();

    api.postMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Retry relationships' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'retryRelationships' });
  });

  it('renders localized sections for every label and direction and navigates in-panel', () => {
    render(<EntryInfoviewApp />);
    push({
      ...base,
      relationshipSections: [
        { label: 'depends', direction: 'incoming', rows: [{ id: 'entry-2', package: 'logic', title: 'Entry Two', relationshipId: 'r1', metadata: null }] },
        { label: 'depends', direction: 'outgoing', rows: [{ id: 'entry-3', package: 'other', title: 'Entry Three', relationshipId: 'r2', metadata: null }] }
      ],
      returnRoute: { kind: 'root' }
    });

    expect(screen.getByText('Dependencies · Incoming')).toBeTruthy();
    expect(screen.getByText('Dependencies · Outgoing')).toBeTruthy();
    api.postMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Open Infoview for Entry Two/ }));
    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'navigateEntry', entryId: 'entry-2', entryPackage: 'logic'
    });
  });
});

describe('EntryInfoview Back', () => {
  it('returns to the protocol-owned prior Entry route', () => {
    render(<EntryInfoviewApp />);
    push({ ...base, relationshipSections: [], returnRoute: { kind: 'entry', entryId: 'previous', entryPackage: 'logic' } });
    api.postMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'back' });
  });

  it('offers a localized chooser when the Entry belongs to many Libraries', () => {
    document.documentElement.lang = 'zh-CN';
    render(<EntryInfoviewApp />);
    push({
      ...base,
      relationshipSections: [],
      returnRoute: { kind: 'chooseLibrary', libraries: [{ slug: 'algebra', title: '代数' }, { slug: 'logic', title: '逻辑' }] }
    });
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByLabelText('选择返回的文档库')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('选择返回的文档库'), { target: { value: 'logic' } });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'returnToLibrary', slug: 'logic' });
  });
});
