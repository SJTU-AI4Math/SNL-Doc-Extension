// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('./vscodeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./vscodeApi')>()),
  getVsCodeApi: () => api,
  useVsCodeApiRef: () => ({ current: api })
}));

import { EntryInfoviewApp } from './EntryInfoviewApp';
import { set_content_language } from './runtime/preferencesRuntime';

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
  set_content_language('en');
  api.postMessage.mockReset();
});

describe('EntryInfoview relationship availability', () => {
  it('preserves v11 workspace Macros for the Basics 0.2.1 Entry renderer and reacts to language', async () => {
    set_content_language('zh-CN');
    render(<EntryInfoviewApp />);
    push({
      ...base,
      entry: { ...entry, content: { snl: 'Existing()' } },
      entries: [{ ...base.entries[0], snl: 'Existing()' }],
      macros: {
        Existing: {
          name: 'Existing', description: '', source: { entries: [], urls: [] },
          kind: 'const', dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: {
              type: 'i18n', default_language: 'en',
              values: {
                en: { mode: 'formula_inline', body: '\\text{INFOVIEW-EN}' },
                'zh-CN': { mode: 'text', body: 'INFOVIEW-ZH' }
              }
            }
          }]
        }
      },
      relationshipSections: [], returnRoute: { kind: 'root' }
    });
    await waitFor(() => expect(screen.getAllByText('INFOVIEW-ZH').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /Macros \(1\)/ }));
    expect(screen.getAllByText('Existing').length).toBeGreaterThan(0);
    act(() => set_content_language('en'));
    await waitFor(() => {
      expect(screen.getAllByText('INFOVIEW-EN').length).toBeGreaterThan(0);
      expect(screen.queryAllByText('INFOVIEW-ZH')).toHaveLength(0);
    });
  });

  it('accepts the host missing-entry payload when related Entries are null', () => {
    render(<EntryInfoviewApp />);
    push({
      ...base,
      entry: null,
      kind: null,
      relationshipSections: null,
      relatedEntries: null,
      returnRoute: { kind: 'root' }
    });
    expect(screen.getByText('Entry not found in this workspace.')).toBeTruthy();
  });

  it('keeps the UI fallback heading for an untitled Entry', () => {
    render(<EntryInfoviewApp />);
    push({
      ...base,
      entry: { ...entry, title: '' },
      relationshipSections: [],
      returnRoute: { kind: 'root' }
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Entry Infoview' })).toBeTruthy();
  });

  it('uses panel content language for the header and accepts localized relationship titles', () => {
    document.documentElement.lang = 'en';
    set_content_language('zh-CN');
    render(<EntryInfoviewApp />);
    push({
      ...base,
      entry: {
        ...entry,
        title: {
          type: 'i18n', default_language: 'en',
          values: { en: 'Entry One', 'zh-CN': '条目一' }
        }
      },
      relationshipSections: [{
        label: 'depends', direction: 'outgoing',
        rows: [{
          id: 'entry-2', package: 'logic', relationshipId: 'r-localized', metadata: null,
          title: {
            type: 'i18n', default_language: 'en',
            values: { en: 'Entry Two', 'zh-CN': '条目二' }
          }
        }]
      }],
      returnRoute: { kind: 'root' }
    });

    expect(screen.getByRole('heading', { level: 1, name: '条目一' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open Infoview for 条目二/ })).toBeTruthy();
    const edit = screen.getByRole('button', { name: 'Open this entry in the Edit Entry panel' });
    expect(edit.querySelector('svg[data-snl-icon="edit"]')).toBeTruthy();
    expect(edit.classList.contains('snl-panel-header__edit-action')).toBe(true);
  });

  it('accepts and reactively renders localized Entry Kind labels', async () => {
    const view = render(<EntryInfoviewApp />);
    push({
      ...base,
      kind: {
        id: 'definition',
        name: {
          type: 'i18n', default_language: 'en', values: { en: 'Definition', 'zh-CN': '定义' }
        },
        description: {
          type: 'i18n', default_language: 'en', values: { en: 'Introduces a term.', 'zh-CN': '引入一个术语。' }
        },
        coloring: {
          light: { stroke: '#111111', background: '#eeeeee' },
          dark: { stroke: '#dddddd', background: '#222222' }
        },
        defaultCounterName: 'definition', style: ''
      },
      relationshipSections: [], returnRoute: { kind: 'root' }
    });
    const readKindHeader = (): string =>
      view.container.querySelector<HTMLElement>('section[data-entry-id="entry-1"] header strong')?.textContent ?? '';
    expect(readKindHeader()).toContain('Definition');
    act(() => set_content_language('zh-CN'));
    await waitFor(() => expect(readKindHeader()).toContain('定义'));
    expect(readKindHeader()).not.toContain('Definition');
  });

  it('ignores malformed macro-kind arrays without replacing the last valid Entry', () => {
    render(<EntryInfoviewApp />);
    push({ ...base, relationshipSections: [], returnRoute: { kind: 'root' } });
    expect(screen.getByRole('heading', { level: 1, name: 'Entry One' })).toBeTruthy();

    expect(() => push({
      ...base,
      macroKinds: [null],
      relationshipSections: [],
      returnRoute: { kind: 'root' }
    })).not.toThrow();
    expect(screen.getByRole('heading', { level: 1, name: 'Entry One' })).toBeTruthy();
  });

  it('keeps the Entry body available when relationships are unreadable and retries only that region', () => {
    render(<EntryInfoviewApp />);
    push({
      ...base,
      kind: {
        id: 'definition',
        name: 'Definition',
        coloring: { light: { stroke: '#888888', background: '#222222' }, dark: { stroke: '#888888', background: '#222222' } },
        defaultCounterName: 'definition',
        style: ''
      },
      relationshipSections: null,
      relationshipsError: 'relationships.json has duplicate ids',
      returnRoute: { kind: 'root' }
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Entry One' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'Relationships unavailable: relationships.json has duplicate ids'
    );
    expect(screen.queryByText(/Could not load entry data/)).toBeNull();

    push({ type: 'entryDetails', entry: {}, entries: null, returnRoute: { kind: 'broken' } });
    expect(screen.getByRole('heading', { level: 1, name: 'Entry One' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('relationships.json has duplicate ids');

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
        { label: 'depends', direction: 'outgoing', rows: [{ id: 'entry-3', package: 'other', title: 'Entry Three', relationshipId: 'r2', metadata: null }] },
        { label: 'custom label', direction: 'outgoing', rows: [{ id: 'entry-4', title: 'Entry Four', relationshipId: 'r3', metadata: null }] }
      ],
      returnRoute: { kind: 'root' }
    });

    expect(screen.getByText('Dependencies · Incoming')).toBeTruthy();
    expect(screen.getByText('Dependencies · Outgoing')).toBeTruthy();
    const customDisclosure = screen.getByRole('button', { name: 'custom label · Outgoing' });
    const controlledId = customDisclosure.getAttribute('aria-controls') ?? '';
    expect(controlledId).not.toMatch(/\s/);
    expect(document.getElementById(controlledId)).toBeTruthy();
    api.postMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Open Infoview for Entry Two/ }));
    expect(api.postMessage).toHaveBeenCalledWith({
      type: 'navigateEntry', entryId: 'entry-2', entryPackage: 'logic'
    });
  });

  it('renders each related Entry as a full Entry block instead of a text row', async () => {
    const view = render(<EntryInfoviewApp />);
    push({
      ...base,
      entries: [
        ...base.entries,
        { id: 'entry-2', package: 'logic', title: 'Entry Two', hasContent: true, snl: 'RelatedContent' }
      ],
      relationshipSections: [{
        label: 'uses_context', direction: 'outgoing',
        rows: [{
          id: 'entry-2', package: 'logic', title: 'Entry Two', kindId: 'definition',
          relationshipId: 'r-related', metadata: null
        }]
      }],
      relatedEntries: [{
        entry: {
          id: 'entry-2', package: 'logic', title: 'Entry Two', kind: 'definition',
          content: { snl: 'RelatedContent' }, contribution_info: null, pointer: null
        },
        kind: {
          id: 'definition', name: 'Definition', style: '', defaultCounterName: 'definition',
          coloring: {
            light: { stroke: '#111111', background: '#eeeeee' },
            dark: { stroke: '#dddddd', background: '#222222' }
          }
        }
      }],
      returnRoute: { kind: 'root' }
    });

    const relatedBlock = view.container.querySelector('section[data-entry-id="entry-2"]');
    expect(relatedBlock).toBeTruthy();
    await waitFor(() => expect(relatedBlock?.textContent).toContain('RelatedContent'));
    expect(screen.queryByRole('button', { name: /Open Infoview for Entry Two/ })).toBeNull();
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
