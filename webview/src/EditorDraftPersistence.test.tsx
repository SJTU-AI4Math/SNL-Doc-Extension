import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateLibraryApp } from './CreateLibraryApp';
import { CreateRelationshipApp } from './CreateRelationshipApp';
import { KindEditorApp, type KindEditorDomain } from './KindEditorApp';
import { editorDraftKey, loadDraft } from './components/draftState';
import type { VsCodeApi } from './vscodeApi';
import { set_content_language } from './runtime/preferencesRuntime';

const posted: unknown[] = [];
let state: unknown;
const api: VsCodeApi = {
  postMessage(message: unknown): void { posted.push(message); },
  getState(): unknown { return state; },
  setState(next: unknown): void { state = next; }
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

function send(data: unknown): void {
  act(() => window.dispatchEvent(new MessageEvent('message', { data })));
}

function submission(type = 'update'): Record<string, unknown> | undefined {
  return posted.find((message): message is Record<string, unknown> =>
    typeof message === 'object' && message !== null &&
    (message as { type?: string }).type === type
  );
}

beforeEach(() => {
  cleanup();
  state = undefined;
  posted.length = 0;
  document.documentElement.lang = 'en';
});

afterEach(() => { cleanup(); set_content_language('en'); });

describe('identity-scoped editor draft persistence', () => {
  it('restores a library title and submits its original revision after a host refresh', async () => {
    const first = render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', slug: 'analysis', libraryRevision: 'library-rev-original',
      existing: { slug: 'analysis', title: 'Host title' }
    });
    send({
      type: 'graph', graphRevision: 'graph-rev-original', nodes: [], relationships: [],
      entries: [], kinds: [], metricMacroSources: {}, metricThresholds: {}, warnings: []
    });
    send({ type: 'countersLoaded', countersRevision: 'counter-rev-original', counters: [] });
    const title = await first.findByLabelText('Library title');
    fireEvent.change(title, { target: { value: 'Unsaved library title' } });

    const key = editorDraftKey('library', 'edit', 'analysis');
    await waitFor(() => expect(loadDraft(api, key)).toEqual({
      title: 'Unsaved library title',
      graph: { nodes: [], relationships: [] }, counters: [],
      expectedRevisions: {
        meta: 'library-rev-original', graph: 'graph-rev-original', counters: 'counter-rev-original'
      }
    }));
    first.unmount();

    const second = render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', slug: 'analysis', libraryRevision: 'library-rev-new',
      existing: { slug: 'analysis', title: 'Refreshed host title' }
    });
    send({
      type: 'graph', graphRevision: 'graph-rev-new', nodes: [], relationships: [],
      entries: [], kinds: [], metricMacroSources: {}, metricThresholds: {}, warnings: []
    });
    send({ type: 'countersLoaded', countersRevision: 'counter-rev-new', counters: [] });
    const restored = await second.findByLabelText('Library title') as HTMLInputElement;
    await waitFor(() => expect(restored.value).toBe('Unsaved library title'));
    fireEvent.click(second.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(submission('saveLibraryDraft')).toMatchObject({
      title: 'Unsaved library title',
      expectedRevisions: {
        meta: 'library-rev-original', graph: 'graph-rev-original', counters: 'counter-rev-original'
      }
    }));
    expect(loadDraft(api, key)).toBeTruthy();
    const requestId = submission('saveLibraryDraft')?.requestId;
    send({
      type: 'libraryDraftSaved', requestId, slug: 'analysis', title: 'Unsaved library title',
      revisions: { meta: 'library-rev-saved', graph: 'graph-rev-saved', counters: 'counter-rev-saved' }
    });
    await waitFor(() => expect(loadDraft(api, key)).toBeUndefined());
  });

  it('restores every relationship field and submits its original revision', async () => {
    const context = {
      type: 'context', mode: 'edit', id: 'rel-1', relationshipRevision: 'relationship-rev-original',
      existing: { id: 'rel-1', from: 'entry-a', to: 'entry-b', label: 'host label', metadata: { host: true } },
      entryPool: [
        { id: 'entry-a', title: 'A' }, { id: 'entry-b', title: 'B' },
        { id: 'entry-c', title: 'C' }, { id: 'entry-d', title: 'D' }
      ],
      existingIds: ['rel-1']
    };
    const first = render(<CreateRelationshipApp />);
    send(context);
    fireEvent.change(await first.findByLabelText('From (source entry)'), { target: { value: 'entry-c' } });
    fireEvent.change(first.getByLabelText('To (target entry)'), { target: { value: 'entry-d' } });
    fireEvent.change(first.getByLabelText('Label (required)'), { target: { value: 'draft label' } });
    fireEvent.change(first.getByLabelText('Metadata (optional, raw JSON — empty ⇒ null)'), {
      target: { value: '{"draft":true}' }
    });

    const key = editorDraftKey('relationship', 'edit', 'rel-1');
    await waitFor(() => expect(loadDraft(api, key)).toEqual({
      id: 'rel-1', from: 'entry-c', to: 'entry-d', label: 'draft label',
      metadata: '{"draft":true}', expectedRevision: 'relationship-rev-original'
    }));
    first.unmount();

    const second = render(<CreateRelationshipApp />);
    send({
      ...context,
      relationshipRevision: 'relationship-rev-new',
      existing: { ...context.existing, from: 'entry-a', to: 'entry-b', label: 'refreshed label', metadata: null }
    });
    await waitFor(() => expect((second.getByLabelText('Label (required)') as HTMLInputElement).value).toBe('draft label'));
    fireEvent.click(second.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(submission()).toMatchObject({
      relationship: {
        id: 'rel-1', from: 'entry-c', to: 'entry-d', label: 'draft label', metadata: { draft: true }
      },
      expectedRevision: 'relationship-rev-original'
    }));
    expect(loadDraft(api, key)).toBeTruthy();
    send({ type: 'updated', id: 'rel-1' });
    await waitFor(() => expect(loadDraft(api, key)).toBeUndefined());
  });

  it('persists the complete localized Kind map and scope across remount, remote revision, ACK and Style-only re-save', async () => {
    act(() => set_content_language('zh-CN'));
    const localized = (en: string, zh: string, ja: string) => ({
      type: 'i18n' as const, default_language: 'ja', values: { en, 'zh-CN': zh, ja }
    });
    const name = localized('Theorem', '原定理', '定理');
    const description = localized('Description', '原说明', '説明');
    const coloring = {
      light: { stroke: '#112233', background: '#ddeeff' },
      dark: { stroke: '#aabbcc', background: '#223344' }
    };
    const context = {
      type: 'context', mode: 'edit', id: 'localized-kind', kindRevision: 'original-revision',
      existingIds: [], languages: [
        { id: 'en', display_name: 'English' }, { id: 'zh-CN', display_name: '中文' },
        { id: 'ja', display_name: '日本語' }
      ], existing: { name, description, coloring, defaultCounterName: 'theorem', style: 'original-style' }
    };
    const first = render(<KindEditorApp domain="entry" />);
    send(context);
    const input = (view: typeof first, label: string) => view.getByLabelText(label) as HTMLInputElement;
    expect(input(first, 'Entry Kind language').value).toBe('zh-CN');
    fireEvent.change(input(first, 'Display name'), { target: { value: '草稿定理' } });
    fireEvent.change(input(first, 'Description'), { target: { value: '草稿说明' } });
    fireEvent.change(input(first, 'Entry Kind language'), { target: { value: 'en' } });
    fireEvent.change(input(first, 'Display name'), { target: { value: 'Draft theorem' } });
    fireEvent.change(input(first, 'Entry Kind language'), { target: { value: 'zh-CN' } });
    const expectedName = localized('Draft theorem', '草稿定理', '定理');
    const expectedDescription = localized('Description', '草稿说明', '説明');
    const key = editorDraftKey('entry-kind', 'edit', 'localized-kind');
    const expectedDraft = {
      id: 'localized-kind', name: expectedName, description: expectedDescription, editLanguage: 'zh-CN',
      lightStroke: '#112233', lightBackground: '#ddeeff', darkStroke: '#aabbcc', darkBackground: '#223344',
      defaultCounterName: 'theorem', style: 'original-style', expectedRevision: 'original-revision'
    };
    await waitFor(() => expect(loadDraft(api, key)).toEqual(expectedDraft));
    first.unmount();
    const second = render(<KindEditorApp domain="entry" />);
    send({ ...context, kindRevision: 'remote-revision', existing: {
      ...context.existing, name: localized('REMOTE', '远程', 'リモート'),
      description: localized('REMOTE DESCRIPTION', '远程说明', '遠隔説明'), style: 'remote-style'
    } });
    await waitFor(() => expect(input(second, 'Display name').value).toBe('草稿定理'));
    expect(input(second, 'Description').value).toBe('草稿说明');
    expect(input(second, 'Entry Kind language').value).toBe('zh-CN');
    expect(loadDraft(api, key)).toEqual(expectedDraft);
    const payload = { id: 'localized-kind', name: expectedName, description: expectedDescription,
      coloring, defaultCounterName: 'theorem', style: 'original-style' };
    fireEvent.click(second.getByRole('button', { name: 'Update Entry Kind' }));
    await waitFor(() => expect(submission()).toEqual({ type: 'update', payload, expectedRevision: 'original-revision' }));
    expect(loadDraft(api, key)).toEqual(expectedDraft);
    // Real host sends a scalar status name, followed by a complete authoritative context.
    send({ type: 'updated', kind: { id: 'localized-kind', name: '草稿定理' } });
    await waitFor(() => expect(loadDraft(api, key)).toBeUndefined());
    send({ ...context, kindRevision: 'saved-revision', existing: payload });
    expect(input(second, 'Entry Kind language').value).toBe('zh-CN');
    expect(input(second, 'Display name').value).toBe('草稿定理');
    expect(loadDraft(api, key)).toBeUndefined();
    posted.length = 0;
    fireEvent.change(input(second, 'Style tag'), { target: { value: 'style-only-edit' } });
    await waitFor(() => expect(loadDraft(api, key)).toEqual({
      ...expectedDraft, style: 'style-only-edit', expectedRevision: 'saved-revision'
    }));
    fireEvent.click(second.getByRole('button', { name: 'Update Entry Kind' }));
    await waitFor(() => expect(submission()).toEqual({
      type: 'update', payload: { ...payload, style: 'style-only-edit' }, expectedRevision: 'saved-revision'
    }));
  });

  for (const domain of ['entry', 'macro'] as KindEditorDomain[]) {
    it(`restores every ${domain} kind field and submits its original revision`, async () => {
      const id = `${domain}-kind-1`;
      const context = {
        type: 'context', mode: 'edit', id, kindRevision: `${domain}-rev-original`,
        existingIds: [{ id, title: 'Host kind', hasContent: false }],
        existing: {
          name: 'Host kind', description: 'host description', defaultCounterName: 'host-counter',
          style: 'host-style', coloring: {
            vendor: { keep: true },
            light: { stroke: '#111111', background: '#eeeeee', token: 'light-token' },
            dark: { stroke: '#dddddd', background: '#222222', token: 'dark-token' }
          }
        }
      };
      const first = render(<KindEditorApp domain={domain} />);
      send(context);
      fireEvent.change(await first.findByLabelText('Display name'), { target: { value: 'Draft kind' } });
      if (domain === 'entry') {
        fireEvent.change(first.getByLabelText('Default counter name'), { target: { value: 'draft-counter' } });
        fireEvent.change(first.getByLabelText('Style tag'), { target: { value: 'draft-style' } });
      } else {
        fireEvent.change(first.getByLabelText('Description'), { target: { value: 'draft description' } });
      }
      fireEvent.change(first.getByLabelText('Light stroke color value'), { target: { value: '#123456' } });
      fireEvent.change(first.getByLabelText('Light background color value'), { target: { value: '#abcdef' } });
      fireEvent.change(first.getByLabelText('Dark stroke color value'), { target: { value: '#fedcba' } });
      fireEvent.change(first.getByLabelText('Dark background color value'), { target: { value: '#654321' } });

      const key = editorDraftKey(`${domain}-kind`, 'edit', id);
      await waitFor(() => expect(loadDraft<Record<string, unknown>>(api, key)).toMatchObject({
        id,
        name: 'Draft kind',
        lightStroke: '#123456',
        lightBackground: '#abcdef',
        darkStroke: '#fedcba',
        darkBackground: '#654321',
        expectedRevision: `${domain}-rev-original`,
        ...(domain === 'entry'
          ? { description: 'host description', editLanguage: '__snl_general__', defaultCounterName: 'draft-counter', style: 'draft-style' }
          : { description: 'draft description' })
      }));
      first.unmount();

      const second = render(<KindEditorApp domain={domain} />);
      send({
        ...context,
        kindRevision: `${domain}-rev-new`,
        existing: { ...context.existing, name: 'Refreshed host kind' }
      });
      await waitFor(() => expect((second.getByLabelText('Display name') as HTMLInputElement).value).toBe('Draft kind'));
      fireEvent.click(second.getByRole('button', { name: `Update ${domain === 'entry' ? 'Entry' : 'Macro'} Kind` }));

      await waitFor(() => expect(submission()).toMatchObject({
        payload: {
          id,
          name: 'Draft kind',
          coloring: {
            vendor: { keep: true },
            light: { stroke: '#123456', background: '#abcdef', token: 'light-token' },
            dark: { stroke: '#fedcba', background: '#654321', token: 'dark-token' }
          },
          ...(domain === 'entry'
            ? { description: 'host description', defaultCounterName: 'draft-counter', style: 'draft-style' }
            : { description: 'draft description' })
        },
        expectedRevision: `${domain}-rev-original`
      }));
      expect(loadDraft(api, key)).toBeTruthy();
      send({ type: 'updated', kind: { id, name: 'Draft kind' } });
      await waitFor(() => expect(loadDraft(api, key)).toBeUndefined());
    });
  }
});
