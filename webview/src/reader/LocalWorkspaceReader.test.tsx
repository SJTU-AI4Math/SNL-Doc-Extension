import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalWorkspaceReader } from './LocalWorkspaceReader';
import { decodeReaderRoute } from './readerRoute';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = (libraries = [{ slug: 'A', title: 'Library A' }, { slug: 'B', title: 'Library B' }], name = 'My workspace') => ({
  id: 'local', name, root: '/folder', libraries, capabilities: { edit: false }
});
const snapshot = (slug: string, body = `${slug} content`): FrozenReaderSnapshot => {
  const entry = { id: 'Shared', package: 'P', kind: 'lemma', title: 'Shared title', content: { markdown: body }, pointer: null };
  return { version: 1, renderSnapshotId: slug + body,
    library: { slug, title: `Library ${slug}`, warnings: [], outline: [{ nodeId: 'same', entry, kind: null, counterLabel: null, children: [] }] },
    entries: [entry], entryKinds: [], entryPackages: { Shared: 'P' }, macros: {}, macroKinds: [], relationships: [],
    preferences: { language: 'en', color_scheme: 'light', motion: 'reduced' }, contentLanguage: 'en',
    languages: [{ id: 'en', display_name: 'English' }], resources: {}
  };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reply = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body } as Response);
let element: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }>;
beforeEach(() => {
  localStorage.clear(); history.replaceState(null, '', '/');
  requests = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => {
    const response = deferred<Response>();
    requests.push({ url, signal: options.signal!, response });
    return response.promise;
  }));
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => root.render(<LocalWorkspaceReader />)); };
const resolve = async (index: number, value: unknown, ok = true) => { await act(async () => requests[index].response.resolve(reply(value, ok))); };
const go = async (hash: string) => { await act(async () => { history.replaceState(null, '', hash); window.dispatchEvent(new PopStateEvent('popstate')); }); };
const button = (label: string) => Array.from(element.querySelectorAll('button')).find(node => node.textContent === label)!;
const click = async (node: Element) => { expect(node).toBeDefined(); await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };

it('loads an empty workspace home without inventing a Library and refreshes its catalog', async () => {
  await mount();
  expect(requests.map(r => r.url)).toEqual(['/__snl/api/workspace']);
  await resolve(0, workspace([]));
  expect(element.textContent).toContain('My workspace');
  expect(element.textContent).toContain('/folder');
  expect(element.textContent).toContain('No libraries');
  expect(element.textContent).not.toContain('frozen export');
  await click(button('Refresh'));
  expect(requests.map(r => r.url)).toEqual(['/__snl/api/workspace', '/__snl/api/workspace']);
  await resolve(1, workspace(undefined, 'Renamed workspace'));
  expect(element.textContent).toContain('Renamed workspace');
  await click(element.querySelector('a[href="#/library?library=A"]')!);
  expect(decodeReaderRoute(location.hash)).toEqual({ kind: 'library', librarySlug: 'A' });
  expect(requests[2].url).toBe('/__snl/api/snapshot?library=A');
  await resolve(2, snapshot('A'));
  expect(element.textContent).toContain('A content');
  expect(element.textContent).toContain('Source navigation is not connected');
  expect(element.querySelector('[title*="frozen export"]')).toBeNull();
  await click(button('← Workspace'));
  expect(decodeReaderRoute(location.hash)).toEqual({ kind: 'workspace' });
  expect(element.textContent).toContain('Renamed workspace');
});

it.each(['success', 'error'] as const)('isolates a late A %s from B and reloads only the current snapshot plus catalog', async outcome => {
  await go('#/library?library=A'); await mount();
  expect(requests.map(r => r.url)).toEqual(['/__snl/api/workspace', '/__snl/api/snapshot?library=A']);
  await resolve(0, workspace());
  await go('#/library?library=B');
  expect(requests[1].signal.aborted).toBe(true);
  expect(element.textContent).not.toContain('A content');
  expect(requests[2].url).toBe('/__snl/api/snapshot?library=B');
  await resolve(2, snapshot('B'));
  expect(element.textContent).toContain('B content');
  if (outcome === 'success') await resolve(1, snapshot('A'));
  else await act(async () => requests[1].response.reject(new Error('A failed late')));
  expect(element.textContent).toContain('B content');
  expect(element.textContent).not.toContain('A failed late');
  await click(button('Refresh'));
  expect(requests.slice(3).map(r => r.url)).toEqual(['/__snl/api/workspace', '/__snl/api/snapshot?library=B']);
  await resolve(4, snapshot('B', 'B refreshed'));
  await resolve(3, workspace(undefined, 'Fresh catalog'));
  expect(element.textContent).toContain('B refreshed');
  expect(element.textContent).not.toContain('B content');
  await click(button('← Workspace'));
  expect(element.textContent).toContain('Fresh catalog');
  await go('#/library?library=A');
  expect(requests[5].url).toBe('/__snl/api/snapshot?library=A');
  await resolve(5, snapshot('A', 'A reread'));
  expect(element.textContent).toContain('A reread');
});

it('discards superseded same-library refreshes, including the catalog, and aborts reads on unmount', async () => {
  await go('#/library?library=A'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  await click(button('Refresh'));
  await click(button('Refresh'));
  expect(requests[2].signal.aborted).toBe(true);
  expect(requests[3].signal.aborted).toBe(true);
  await resolve(4, workspace(undefined, 'Newest catalog')); await resolve(5, snapshot('A', 'Newest snapshot'));
  await resolve(2, workspace(undefined, 'Stale catalog')); await resolve(3, snapshot('A', 'Stale snapshot'));
  expect(element.textContent).toContain('Newest snapshot');
  expect(element.textContent).not.toContain('Stale snapshot');
  await click(button('← Workspace'));
  expect(element.textContent).toContain('Newest catalog');
  await click(button('Refresh'));
  await act(async () => root.unmount());
  expect(requests[6].signal.aborted).toBe(true);
  await resolve(6, workspace());
  expect(element.textContent).toBe('');
});

it('reports failed reads and rejects mismatched library snapshots without trapping navigation', async () => {
  await go('#/entry/Shared?library=missing'); await mount();
  await resolve(0, workspace());
  await resolve(1, {}, false);
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('500');
  await click(button('Refresh'));
  await resolve(2, workspace()); await resolve(3, snapshot('other'));
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('library');
  expect(element.textContent).not.toContain('other content');
  await click(button('← Workspace'));
  expect(element.querySelectorAll('a')).toHaveLength(2);
});

it('boots a search deep link into the existing shared panel and preserves its library on Entry Back', async () => {
  await go('#/search?library=B&q=Shared&return=%23%2Fnode%2Fsame%3Flibrary%3DB'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('B'));
  const input = element.querySelector<HTMLInputElement>('input[type="text"]')!;
  expect(input.value).toBe('Shared');
  expect(element.textContent).not.toContain('frozen export');
  const hash = location.hash;
  await click(element.querySelector('[role="option"]')!);
  expect(decodeReaderRoute(location.hash)).toMatchObject({ kind: 'entry', librarySlug: 'B', entryId: 'Shared' });
  const main = Array.from(element.querySelectorAll('main')).find(node => !node.closest('[hidden]'))!;
  await click(main.querySelector('button')!);
  expect(location.hash).toBe(hash);
  expect(requests).toHaveLength(2);
});
