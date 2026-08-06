import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import type { VsCodeApi } from '../vscodeApi';

const posted: unknown[] = [];
let state: unknown;
const api: VsCodeApi = {
  postMessage: (message) => { posted.push(message); },
  getState: () => state,
  setState: (next) => { state = next; }
};
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;

function context(id: string, contributor?: string): void {
  window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'context', mode: 'edit', targetState: 'found', id,
    entryRevision: `revision-${id}`,
    kinds: [{ id: 'theorem', name: 'Theorem', coloring: { stroke: '#888', background: '#222' } }],
    entryPackages: ['_unpackaged'], existingIds: [{ id, title: id }], relationships: [],
    existing: { id, package: '_unpackaged', kind: 'theorem', title: id, content: {}, contribution_info: contributor, pointer: null }
  }}));
}

beforeEach(() => { cleanup(); posted.length = 0; state = undefined; document.documentElement.lang = 'en'; });
afterEach(cleanup);

describe('temporary single-string Contributor editor', () => {
  it('loads, edits, and submits Contributor as one string', async () => {
    const view = render(<CreateEntryApp />);
    context('entry-a', 'Ada Lovelace');
    const toggle = await waitFor(() => view.getByRole('button', { name: /Contributor/ }));
    fireEvent.click(toggle);
    const section = view.getByTestId('entry-contributor-editor');
    const input = within(section).getByLabelText('Contributor') as HTMLInputElement;
    expect(input.value).toBe('Ada Lovelace');
    expect(within(section).getByText(/temporary single-string field/i)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'Grace Hopper' } });
    fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
    const update = posted.find((message): message is { type: string; entry: { contribution_info: unknown }; expectedRevision: string } =>
      !!message && typeof message === 'object' && (message as { type?: string }).type === 'update');
    expect(update?.entry.contribution_info).toBe('Grace Hopper');
    expect(update?.expectedRevision).toBe('revision-entry-a');
  });

  it('keeps Contributor in the identity-scoped draft', async () => {
    const view = render(<CreateEntryApp />);
    context('entry-a');
    fireEvent.click(await waitFor(() => view.getByRole('button', { name: /Contributor/ })));
    fireEvent.change(within(view.getByTestId('entry-contributor-editor')).getByLabelText('Contributor'), {
      target: { value: 'Draft Author' }
    });
    await waitFor(() => expect(JSON.stringify(state)).toContain('Draft Author'));
    expect(JSON.stringify(state)).toContain('createEntry:edit:entry-a');
  });
});
