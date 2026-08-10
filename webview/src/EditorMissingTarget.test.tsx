import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from './CreateEntryApp';
import { CreateLibraryApp } from './CreateLibraryApp';
import { CreateMacroApp } from './CreateMacroApp';
import { CreateMacroPackageApp } from './CreateMacroPackageApp';
import { CreateRelationshipApp } from './CreateRelationshipApp';
import { KindEditorApp } from './KindEditorApp';
import type { VsCodeApi } from './vscodeApi';

const posted: unknown[] = [];
const api: VsCodeApi = {
  postMessage: (message: unknown) => { posted.push(message); },
  getState: () => undefined,
  setState: () => undefined
};

beforeAll(() => {
  (globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => api;
});
beforeEach(() => {
  posted.splice(0);
  document.documentElement.lang = 'en';
});
afterEach(() => cleanup());

async function send(data: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

function expectTerminalMissing(view: ReturnType<typeof render>, id: string): void {
  expect(view.getByRole('alert').textContent).toContain(id);
  expect(view.queryByRole('button', { name: /create|update|save changes/i })).toBeNull();
  expect(view.getByRole('button', { name: /dashboard/i })).not.toBeNull();
  expect(view.getByRole('button', { name: /refresh/i })).not.toBeNull();
}

describe('editor missing-target terminal states', () => {
  it('terminates a missing Library edit, blocks save, and recovers when it reappears', async () => {
    const view = render(<CreateLibraryApp />);
    const base = { type: 'context', mode: 'edit', slug: 'library-gone' };
    await send({ ...base, targetState: 'notFound', existing: null });
    await waitFor(() => expectTerminalMissing(view, 'library-gone'));

    const beforeShortcut = posted.length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    expect(posted.slice(beforeShortcut)).not.toContainEqual(expect.objectContaining({ type: 'update' }));

    await send({
      ...base,
      targetState: 'found',
      libraryRevision: 'fresh-revision',
      existing: { slug: 'library-gone', title: 'Restored' }
    });
    expect(await view.findByDisplayValue('Restored')).not.toBeNull();
    expect(view.queryByRole('alert')).toBeNull();

    await send({ ...base, targetState: 'notFound', existing: null });
    await waitFor(() => expectTerminalMissing(view, 'library-gone'));
  });

  it('replaces an Entry form when a watcher reports that the target was deleted', async () => {
    const view = render(<CreateEntryApp />);
    const base = {
      type: 'context', mode: 'edit', id: 'entry-gone', targetState: 'found',
      kinds: [{ id: 'theorem', name: 'Theorem', coloring: { light: { stroke: '#000', background: '#fff' }, dark: { stroke: '#000', background: '#fff' } } }],
      macros: {}, macroKinds: [], macroOrigin: {}, entryPackages: ['_unpackaged'],
      existingIds: [], relationships: []
    };
    await send({ ...base, existing: { id: 'entry-gone', title: 'Before', kind: 'theorem', content: { snl: '' } } });
    expect(await view.findByLabelText('Title')).not.toBeNull();
    await send({ ...base, targetState: 'notFound', existing: null });
    await waitFor(() => expectTerminalMissing(view, 'entry-gone'));
  });

  it('replaces a Macro form when a watcher reports that the target was deleted', async () => {
    const view = render(<CreateMacroApp />);
    const base = {
      type: 'context', mode: 'edit', file: 'pkg.json', packageName: 'Pkg',
      targetState: 'found', existingNames: ['macro-gone'], macroCandidates: [],
      workspaceMacros: {}, macroKinds: [], entries: [], prefill: null
    };
    await send({ ...base, existing: {
      name: 'macro-gone', description: '', source: { entries: [], urls: [] }, dynamic_arity: false, styles: [{ style_name: 'default', mode: 'text', template: '', tags: [] }], tags: []
    } });
    expect(await view.findByLabelText(/Name/)).not.toBeNull();
    await send({ ...base, targetState: 'notFound', existing: null });
    await waitFor(() => expectTerminalMissing(view, 'macro-gone'));
  });

  it('renders an initial missing Macro Package without mutation controls', async () => {
    const view = render(<CreateMacroPackageApp />);
    await send({ type: 'context', mode: 'edit', file: 'pkg-gone', targetState: 'notFound', existing: null });
    await waitFor(() => expectTerminalMissing(view, 'pkg-gone'));
  });

  it('replaces a Relationship form when a watcher reports deletion', async () => {
    const view = render(<CreateRelationshipApp />);
    const base = { type: 'context', mode: 'edit', id: 'rel-gone', targetState: 'found', entryPool: [], existingIds: ['rel-gone'] };
    await send({ ...base, existing: { id: 'rel-gone', from: '', to: '', label: 'before', metadata: null } });
    expect(await view.findByLabelText('Label (required)')).not.toBeNull();
    await send({ ...base, targetState: 'notFound', existing: null });
    await waitFor(() => expectTerminalMissing(view, 'rel-gone'));
    await send({ ...base, targetState: 'found', existing: { id: 'rel-gone', from: '', to: '', label: 'restored', metadata: null } });
    expect(await view.findByLabelText('Label (required)')).not.toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('uses the same terminal state for a mutation-time not-found response', async () => {
    const view = render(<CreateMacroPackageApp />);
    await send({
      type: 'context', mode: 'edit', file: 'pkg-gone', targetState: 'found',
      existing: { file: 'pkg-gone', name: 'Package', description: '' }
    });
    expect(await view.findByLabelText('Display name')).not.toBeNull();
    await send({ type: 'notFound', file: 'pkg-gone', message: 'gone' });
    await waitFor(() => expectTerminalMissing(view, 'pkg-gone'));
  });

  for (const domain of ['entry', 'macro'] as const) {
    it(`replaces a deleted ${domain} kind form`, async () => {
      const id = `${domain}-kind-gone`;
      const view = render(<KindEditorApp domain={domain} />);
      const base = { type: 'context', mode: 'edit', id, targetState: 'found', existingIds: [] };
      await send({ ...base, existing: { id, name: 'Before', coloring: { light: { stroke: '#111', background: '#eee' }, dark: { stroke: '#111', background: '#eee' } } } });
      expect(await view.findByLabelText('Display name')).not.toBeNull();
      await send({ ...base, targetState: 'notFound', existing: null });
      await waitFor(() => expectTerminalMissing(view, id));
    });
  }

  it('localizes the missing target state without changing the recovery controls', async () => {
    document.documentElement.lang = 'zh-CN';
    const view = render(<CreateMacroPackageApp />);
    await send({ type: 'context', mode: 'edit', file: 'pkg-gone', targetState: 'notFound', existing: null });
    expect((await view.findByRole('alert')).textContent).toContain('pkg-gone');
    expect(view.getByRole('alert').textContent).toContain('不存在');
    expect(view.getByRole('button', { name: /仪表板/ })).not.toBeNull();
    expect(view.getByRole('button', { name: /刷新/ })).not.toBeNull();
  });
});
