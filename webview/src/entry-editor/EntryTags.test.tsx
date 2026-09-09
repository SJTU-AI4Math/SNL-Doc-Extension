import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CreateEntryApp } from '../CreateEntryApp';
import type { VsCodeApi } from '../vscodeApi';
const posted: Array<{ type: string; entry?: { tags?: string[] } }> = [];
let state: unknown;
const api: VsCodeApi = { postMessage: m => { posted.push(m as typeof posted[number]); }, getState: () => state, setState: s => { state = s; } };
(globalThis as { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi = () => api;
function context(tags?: string[]) {
  window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'context', mode: 'edit', targetState: 'found', id: 'entry-a', entryRevision: 'rev-a',
    kinds: [{ id: 'theorem', name: 'Theorem', coloring: { light: { stroke: '#888', background: '#222' }, dark: { stroke: '#888', background: '#222' } } }],
    entryPackages: ['_unpackaged'], existingIds: [{ id: 'entry-a', title: 'Entry' }], relationships: [],
    existing: { id: 'entry-a', package: '_unpackaged', kind: 'theorem', title: 'Entry', content: {}, pointer: null, ...(tags === undefined ? {} : { tags }) }
  }}));
}
beforeEach(() => { cleanup(); posted.length = 0; state = undefined; document.documentElement.lang = 'en'; });
afterEach(cleanup);
it('edits exact raw tag rows, adds/removes and keeps a dirty draft across refresh/remount', async () => {
  let view = render(<CreateEntryApp />);
  context(['', ' a,b ', '__proto__', '__proto__']);
  fireEvent.click(await waitFor(() => view.getByRole('button', { name: 'Tags' })));
  let section = within(view.getByTestId('entry-tags-editor'));
  expect(section.getAllByRole('textbox').map(e => (e as HTMLInputElement).value)).toEqual(['', ' a,b ', '__proto__', '__proto__']);
  fireEvent.change(section.getAllByRole('textbox')[0], { target: { value: ' 中文, \n ' } });
  fireEvent.click(section.getByRole('button', { name: 'Add tag' }));
  fireEvent.click(section.getAllByRole('button', { name: /Remove tag/ })[1]);
  const expected = [' 中文, \n ', '__proto__', '__proto__', ''];
  context(['external']);
  await waitFor(() => expect(section.getAllByRole('textbox').map(e => (e as HTMLTextAreaElement).value)).toEqual(expected));
  await waitFor(() => expect(JSON.stringify(state)).toContain('__proto__'));
  view.unmount(); view = render(<CreateEntryApp />); context(['external']);
  fireEvent.click(await waitFor(() => view.getByRole('button', { name: 'Tags' })));
  section = within(view.getByTestId('entry-tags-editor'));
  await waitFor(() => expect(section.getAllByRole('textbox').map(e => (e as HTMLTextAreaElement).value)).toEqual(expected));
  fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
  expect(posted.find(m => m.type === 'update')?.entry?.tags).toEqual(expected);
});
it('removing every row submits []', async () => {
  const view = render(<CreateEntryApp />); context(['one']);
  fireEvent.click(await waitFor(() => view.getByRole('button', { name: 'Tags' })));
  fireEvent.click(within(view.getByTestId('entry-tags-editor')).getByRole('button', { name: /Remove tag/ }));
  fireEvent.click(view.getByRole('button', { name: 'Update Entry' }));
  expect(posted.find(m => m.type === 'update')?.entry?.tags).toEqual([]);
});
it('keeps existing tags on an unrelated metadata save', async () => {
  const view = render(<CreateEntryApp />); context(['', '__proto__', ' a,b ', 'a', 'a']);
  fireEvent.click(await waitFor(() => view.getByRole('button', { name: 'Update Entry' })));
  expect(posted.find(m => m.type === 'update')?.entry?.tags).toEqual(['', '__proto__', ' a,b ', 'a', 'a']);
});
it('does not add tags to untouched absent-tag entries', async () => {
  const view = render(<CreateEntryApp />); context();
  fireEvent.click(await waitFor(() => view.getByRole('button', { name: 'Update Entry' })));
  expect(Object.hasOwn(posted.find(m => m.type === 'update')!.entry!, 'tags')).toBe(false);
});
