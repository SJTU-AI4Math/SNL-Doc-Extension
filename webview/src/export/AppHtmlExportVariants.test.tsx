// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, type OutlineNode } from '../App';
import type { EntryData, EntryKind } from '../render/EntryRender';
import { apply_preferences_snapshot } from '../runtime/preferencesRuntime';
import type { VsCodeApi } from '../vscodeApi';

const postMessage = vi.fn();
const api: VsCodeApi = { postMessage, getState: () => undefined, setState: () => undefined };

const parentEntry: EntryData = {
  id: 'entry-parent',
  kind: 'definition',
  title: { type: 'i18n' as const, default_language: 'en', values: { en: 'Parent Entry', 'zh-CN': '父条目' } },
  content: { snl: 'Right(Ref(x), Ref(y))' },
  contribution_info: null,
  pointer: null
};
const childEntry: EntryData = {
  id: 'child',
  kind: 'definition',
  title: { type: 'i18n' as const, default_language: 'en', values: { en: 'Child Entry', 'zh-CN': '子条目' } },
  content: {
    text: { type: 'i18n' as const, default_language: 'en', values: { en: 'English child body', 'zh-CN': '中文子条目正文' } }
  },
  contribution_info: null,
  pointer: null
};
const formulaEntry: EntryData = {
  id: 'formula-child',
  kind: 'definition',
  title: 'Formula child',
  content: { snl: 'Ref(z)' },
  contribution_info: null,
  pointer: null
};

const kind: EntryKind = {
  id: 'definition',
  name: { type: 'i18n' as const, default_language: 'en', values: { en: 'Definition', 'zh-CN': '定义' } },
  coloring: {
    light: { stroke: '#123456', background: '#edf4ff' },
    dark: { stroke: '#fedcba', background: '#1a2433' }
  },
  style: 'default'
};
const outline: OutlineNode[] = [{
  nodeId: 'parent-node', entry: parentEntry, kind, counterLabel: '1', children: [{
    nodeId: 'child-node', entry: childEntry, kind, counterLabel: '1.1', children: []
  }, {
    nodeId: 'formula-node', entry: formulaEntry, kind, counterLabel: '1.2', children: []
  }]
}];

afterEach(() => {
  cleanup();
  postMessage.mockReset();
  delete (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
});

describe('Infoview HTML export snapshot handoff', () => {
  it('captures one static fallback and hands off the host snapshot token without changing live language', async () => {
    (globalThis as { __snlApi?: VsCodeApi }).__snlApi = api;
    apply_preferences_snapshot({
      type: 'snl.preferences/snapshot',
      generation: `export-variants-${Date.now()}`,
      revision: 1,
      preferences: { language: 'en', color_scheme: 'high-contrast-light', motion: 'full' },
      supported_languages: [
        { id: 'en', display_name: 'English' },
        { id: 'zh-CN', display_name: '简体中文' }
      ]
    });
    render(<App />);
    act(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'libraryEntries',
      renderSnapshotId: 'frozen-render-A',
      slug: 'demo',
      title: 'Demo',
      entries: [
        { id: 'entry-parent', title: parentEntry.title, hasContent: true, snl: 'Right(Ref(x), Ref(y))' },
        { id: 'child', title: childEntry.title, hasContent: true, snl: '@x' },
        { id: 'formula-child', title: formulaEntry.title, hasContent: true, snl: 'Ref(z)' },
        { id: 'outside', title: 'Outside Library', hasContent: true }
      ],
      entryRecords: [parentEntry, childEntry, formulaEntry],
      entryKinds: [kind],
      relationships: [{
        id: 'rel-1', from: 'entry-parent', to: 'child', label: 'uses_context', metadata: null
      }],
      macros: {
        Ref: {
          name: 'Ref', description: 'Entry reference',
          source: { entries: ['outside'], urls: [] },
          kind: 'const', dynamic_arity: false, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: { mode: 'formula_inline', body: '#0' }
          }]
        },
        Right: {
          name: 'Right', description: 'Right-aligned block',
          source: { entries: [], urls: [] },
          kind: 'const', dynamic_arity: true, tags: [],
          styles: [{
            style_name: 'default', tags: [],
            template: { mode: 'block', body: '#*', block_template_name: 'right' }
          }]
        }
      },
      outline
    } })));
    await waitFor(() => expect(document.querySelector('.snl-block-right')).not.toBeNull());
    postMessage.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
    await waitFor(() => {
      expect(postMessage.mock.calls.some(([message]) => message?.type === 'exportLibraryHtml')).toBe(true);
    }, { timeout: 8000 });

    const payload = postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.type === 'exportLibraryHtml');
    expect(payload.renderSnapshotId).toBe('frozen-render-A');
    expect(payload.locale).toBe('en');
    expect(payload.slug).toBe('demo');
    expect(payload.variants).toBeUndefined();
    expect(payload.popovers).toBeUndefined();
    expect(payload.readerSnapshot).toBeUndefined(); // raw data is owned and attached by the host
    expect(payload.body).toContain('Parent Entry');
    expect(payload.body).toContain('Child Entry');
    expect(payload.body).toContain('Formula child');
    expect(payload.body).toContain('English child body');
    expect(payload.body).not.toContain('父条目');
    expect(payload.body).toContain('snl-block-right');
    expect(payload.body).toContain('data-src="outside"');
    // This body is the non-interactive fallback, not the interactive runtime.
    // Accessible keyboard activation is exercised on BrowserReader above the raw snapshot.

    expect(postMessage.mock.calls.some(([message]) => message?.type === 'requestEntryDetails')).toBe(false);
    expect(postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === 'snl.content-language/changed')).toEqual([]);
    expect(postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message?.type === 'exportLibraryHtml')).toHaveLength(1);
    expect(document.documentElement.dataset.snlColorScheme).toBe('high-contrast-light');
  });
});
