import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateRelationshipApp } from './CreateRelationshipApp';
import { CreateLibraryApp } from './CreateLibraryApp';
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
beforeEach(() => posted.splice(0));
afterEach(() => cleanup());

function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

describe('editor optimistic concurrency', () => {
  it('preserves a dirty Relationship draft and its original revision', async () => {
    const view = render(<CreateRelationshipApp />);
    const entryPool = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ];
    send({
      type: 'context', mode: 'edit', id: 'r', relationshipRevision: 'revision-1',
      existing: { id: 'r', from: 'a', to: 'b', label: 'before', metadata: null },
      entryPool, existingIds: ['r']
    });
    const label = await view.findByLabelText('Label (required)') as HTMLInputElement;
    fireEvent.change(label, { target: { value: 'unsaved' } });
    send({
      type: 'context', mode: 'edit', id: 'r', relationshipRevision: 'revision-2',
      existing: { id: 'r', from: 'a', to: 'b', label: 'external', metadata: null },
      entryPool, existingIds: ['r']
    });
    await waitFor(() => expect(label.value).toBe('unsaved'));
    fireEvent.click(view.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'update', expectedRevision: 'revision-1',
      relationship: expect.objectContaining({ label: 'unsaved' })
    })));
  });

  it('accepts Library watcher refreshes while the title is clean', async () => {
    const view = render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', slug: 'logic', libraryRevision: 'revision-1',
      existing: { slug: 'logic', title: 'Logic' }
    });
    await waitFor(() => expect(
      (view.getByLabelText('Library title') as HTMLInputElement).value
    ).toBe('Logic'));
    await act(async () => {
      send({
        type: 'context', mode: 'edit', slug: 'logic', libraryRevision: 'revision-2',
        existing: { slug: 'logic', title: 'External library' }
      });
    });
    expect((view.getByLabelText('Library title') as HTMLInputElement).value)
      .toBe('External library');
    fireEvent.click(view.getByRole('button', { name: 'Update Title' }));
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'update', title: 'External library', expectedRevision: 'revision-2'
    })));
  });

  it('preserves a dirty Library title and its original revision', async () => {
    const view = render(<CreateLibraryApp />);
    send({
      type: 'context', mode: 'edit', slug: 'logic', libraryRevision: 'revision-1',
      existing: { slug: 'logic', title: 'Logic' }
    });
    await waitFor(() => expect(
      (view.getByLabelText('Library title') as HTMLInputElement).value
    ).toBe('Logic'));
    const title = view.getByLabelText('Library title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Unsaved library' } });
    await act(async () => {
      send({
        type: 'context', mode: 'edit', slug: 'logic', libraryRevision: 'revision-2',
        existing: { slug: 'logic', title: 'External library' }
      });
    });
    expect(title.value).toBe('Unsaved library');
    fireEvent.click(view.getByRole('button', { name: 'Update Title' }));
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'update', title: 'Unsaved library', expectedRevision: 'revision-1'
    })));
  });

  it('preserves a dirty Kind draft and its original revision', async () => {
    const view = render(<KindEditorApp domain="entry" />);
    send({
      type: 'context', mode: 'edit', id: 'definition', kindRevision: 'revision-1',
      existing: {
        id: 'definition', name: 'Definition',
        coloring: { light: { stroke: '#111111', background: '#eeeeee' }, dark: { stroke: '#111111', background: '#eeeeee' } },
        defaultCounterName: '', style: ''
      },
      existingIds: [{ id: 'definition', title: 'Definition', hasContent: true }]
    });
    const name = await view.findByLabelText('Display name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Unsaved kind' } });
    send({
      type: 'context', mode: 'edit', id: 'definition', kindRevision: 'revision-2',
      existing: {
        id: 'definition', name: 'External kind',
        coloring: { light: { stroke: '#222222', background: '#dddddd' }, dark: { stroke: '#222222', background: '#dddddd' } },
        defaultCounterName: '', style: ''
      },
      existingIds: [{ id: 'definition', title: 'External kind', hasContent: true }]
    });
    await waitFor(() => expect(name.value).toBe('Unsaved kind'));
    fireEvent.click(view.getByRole('button', { name: 'Update Entry Kind' }));
    await waitFor(() => expect(posted).toContainEqual(expect.objectContaining({
      type: 'update', expectedRevision: 'revision-1',
      payload: expect.objectContaining({
        name: 'Unsaved kind'
      })
    })));
  });
});
