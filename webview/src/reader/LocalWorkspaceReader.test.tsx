import { act, StrictMode } from 'react';
import { BrowserReader } from './BrowserReader';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalWorkspaceReader } from './LocalWorkspaceReader';
import { decodeReaderRoute } from './readerRoute';
import { apply_preferences_snapshot, set_content_language } from '../runtime/preferencesRuntime';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = (libraries: Array<{ slug: string; title: string; entryCount?: number | null; relationshipCount?: number | null }> = [{ slug: 'A', title: 'Library A' }, { slug: 'B', title: 'Library B' }], name = 'My workspace') => ({
  id: 'local', name, root: '/folder', libraries, capabilities: { edit: false }
});
const snapshot = (slug: string, body = `${slug} content`): FrozenReaderSnapshot => {
  const entry = { id: 'Shared', package: 'P', kind: 'lemma', title: 'Shared title', content: { markdown: body }, pointer: null };
  return { version: 1, renderSnapshotId: slug + body,
    library: { slug, title: `Library ${slug}`, warnings: [], outline: [{ nodeId: 'same', entry, kind: null, counterLabel: null, children: [] }] },
    entries: [entry], entryKinds: [], entryPackages: { Shared: 'P' },
    macros: { symbol: { name: 'symbol', kind: 'symbol', description: '', dynamic_arity: false, tags: [], source: { entries: ['Shared'], urls: [] }, styles: [{ style_name: 'default', tags: [], template: { mode: 'formula_inline', body: 'x' } }] } },
    macroKinds: [], relationships: [],
    preferences: { language: 'en', color_scheme: 'light', motion: 'reduced' }, contentLanguage: 'en',
    languages: [{ id: 'en', display_name: 'English' }], resources: {}
  };
};
const bilingualSnapshot = (body = 'original'): FrozenReaderSnapshot => {
  const value = snapshot('A');
  value.entries[0].content.markdown = {
    type: 'i18n', default_language: 'en',
    values: { en: `English reading ${body}`, 'zh-CN': `中文正文 ${body}` }
  };
  value.languages.push({ id: 'zh-CN', display_name: '简体中文' });
  return value;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const reply = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body } as Response);
// Only the browser transport is doubled: all reader/search/graph rendering stays real.
class TestEventSource {
  static instances: TestEventSource[] = [];
  listeners = new Map<string, EventListener>();
  close = vi.fn();
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener); }
  removeEventListener(type: string, listener: EventListener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  emit(type: string, data: unknown = {}) { this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) })); }
}
const events = () => TestEventSource.instances[0];
const emit = async (type: string, data?: unknown) => { await act(async () => events().emit(type, data)); };
const tick = async () => { await act(async () => vi.advanceTimersByTimeAsync(300)); };
let element: HTMLDivElement;
let root: Root;
let requests: Array<{ url: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }>;
beforeEach(() => {
  localStorage.clear(); document.documentElement.lang = 'en'; history.replaceState(null, '', '/');
  apply_preferences_snapshot({ type: 'snl.preferences/snapshot', generation: 'fresh-test-document', revision: 0, preferences: { language: 'en', color_scheme: 'light', motion: 'reduced' } });
  requests = []; TestEventSource.instances = [];
  vi.stubGlobal('EventSource', TestEventSource);
  vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => {
    const response = deferred<Response>();
    requests.push({ url, signal: options.signal!, response });
    return response.promise;
  }));
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => root.render(<LocalWorkspaceReader />)); };
const resolve = async (index: number, value: unknown, ok = true) => { await act(async () => requests[index].response.resolve(reply(value, ok))); };
const go = async (hash: string) => { await act(async () => { history.replaceState(null, '', hash); window.dispatchEvent(new PopStateEvent('popstate')); }); };
const button = (label: string) => Array.from(element.querySelectorAll('button')).find(node => !node.closest('[hidden]') && (node.textContent === label || node.getAttribute('aria-label') === label))!;
const visibleHeaders = () => Array.from(element.querySelectorAll('nav, :scope > header')).filter(node => !node.closest('[hidden]'));

it('subscribes locally and folds the initial event/bursts into bounded catalog refreshes', async () => {
  vi.useFakeTimers();
  await mount();
  expect(TestEventSource.instances.map(source => source.url)).toEqual(['/__snl/api/events']);
  await emit('change', { revision: 'initial' });
  await tick();
  expect(requests).toHaveLength(1); // Initial read is not repeatedly aborted.
  await resolve(0, workspace()); await tick();
  expect(requests).toHaveLength(2); // Even the first event closes the fetch/subscription gap.
  await emit('change', { revision: 'initial' }); await tick();
  expect(requests).toHaveLength(2);
  await emit('change', { revision: 'next' });
  await emit('change', { revision: 'latest' }); await tick();
  expect(requests).toHaveLength(2); // At most one trailing pass while a read is in flight.
  await resolve(1, workspace()); await tick();
  expect(requests).toHaveLength(3);
  await resolve(2, workspace([{ slug: 'C', title: 'Created library', entryCount: 8 }]));
  expect(element.querySelector('table')?.textContent).toContain('Created library');
  expect(element.querySelector('table')?.textContent).not.toContain('Library A');
  await emit('change', { revision: 'latest' }); await tick();
  expect(requests).toHaveLength(3);
});

it.each(['search', 'graph'] as const)('republishes the real %s model on automatic snapshot adoption without losing the route', async kind => {
  vi.useFakeTimers();
  // Title rendering now requires a real-sized graph canvas. Geometry is the
  // only additional browser seam; graph/model adoption remains production code.
  if (kind === 'graph') vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 700));
  const hash = `#/${kind}?library=A&q=Shared&return=%23%2Fnode%2Fsame%3Flibrary%3DA`;
  await go(hash); await mount();
  const data = (title: string) => {
    const value = snapshot('A');
    value.entries[0].title = title;
    value.entries.push({ ...value.entries[0], id: 'Other', title: 'Other entry' });
    value.relationships = [{ id: 'edge', from: 'Shared', to: 'Other', label: 'explains', metadata: {} }];
    return value; // Deliberately same snapshot ID: adoption, not ID guesswork, owns publication.
  };
  await resolve(0, workspace()); await resolve(1, data('Shared old title'));
  const visible = () => Array.from(element.querySelectorAll('main')).find(node => !node.closest('[hidden]'))!;
  const control = visible().querySelector('input[type="text"]');
  if (kind === 'graph') {
    const nodes = visible().querySelector<HTMLSelectElement>('select[aria-label="Nodes"]');
    expect(nodes).not.toBeNull();
    await act(async () => { nodes!.value = 'always-title'; nodes!.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  expect(visible().textContent?.replace(/\s/g, ' ')).toContain('Shared old title');
  await emit('change', { revision: 'r1' }); await tick();
  expect(visible().textContent?.replace(/\s/g, ' ')).toContain('Shared old title');
  await resolve(2, workspace()); await resolve(3, data('Shared new title'));
  expect(visible().textContent?.replace(/\s/g, ' ')).toContain('Shared new title');
  expect(visible().textContent?.replace(/\s/g, ' ')).not.toContain('Shared old title');
  expect(location.hash).toBe(hash);
  if (kind === 'search') expect(visible().querySelector('input[type="text"]')).toBe(control);
  expect(TestEventSource.instances).toHaveLength(1);
});

const watchStatus = () => element.querySelector<HTMLElement>('[data-snl-local-watch-status]')!;
it.each(['error', 'unavailable'] as const)('shows localized %s and revalidates even the same revision on recovery', async failure => {
  vi.useFakeTimers(); await mount(); await resolve(0, workspace());
  await emit('change', { revision: 'same' }); await tick(); await resolve(1, workspace());
  expect(watchStatus().dataset.snlLocalWatchStatus).toBe('connected');
  await emit(failure, { message: 'watch stopped' });
  expect(watchStatus().dataset.snlLocalWatchStatus).toBe(failure === 'error' ? 'reconnecting' : 'unavailable');
  expect(watchStatus().textContent).toContain('manually');
  await click(element.querySelector('[aria-label^="Interface language"]')!);
  await click(element.querySelector('[data-language="zh-CN"]')!);
  expect(watchStatus().textContent).toContain('仍可手动刷新');
  await emit('change', { revision: 'same' }); await tick();
  expect(requests).toHaveLength(3);
  await resolve(2, workspace([{ slug: 'recovered', title: 'Recovered' }]));
  expect(watchStatus().dataset.snlLocalWatchStatus).toBe('connected');
  expect(watchStatus().textContent).toBe('自动更新已连接。');
  expect(element.querySelector('table')?.textContent).toContain('Recovered');
  await emit('change', { revision: 'same' }); await tick(); expect(requests).toHaveLength(3);
});

it.each(['unsupported', 'constructor', 'listener'] as const)('keeps manual reading usable when EventSource is %s', async failure => {
  if (failure === 'unsupported') vi.stubGlobal('EventSource', undefined);
  else if (failure === 'constructor') vi.stubGlobal('EventSource', class { constructor() { throw new Error('blocked'); } });
  else vi.stubGlobal('EventSource', class extends TestEventSource {
    addEventListener(type: string, listener: EventListener) { super.addEventListener(type, listener); if (type === 'unavailable') throw new Error('cannot listen'); }
  });
  await mount(); await resolve(0, workspace());
  expect(watchStatus().dataset.snlLocalWatchStatus).toBe(failure === 'unsupported' ? 'unsupported' : 'unavailable');
  expect(watchStatus().textContent).toContain('Refresh');
  if (failure === 'listener') { expect(events().close).toHaveBeenCalledOnce(); expect(events().listeners.size).toBe(0); }
  await click(button('Refresh this panel from disk'));
  await resolve(1, workspace(undefined, 'Manual still works'));
  expect(element.textContent).toContain('Manual still works');
});

it('retains accepted content on automatic loading/failure and recovers on a later change', async () => {
  vi.useFakeTimers(); await go('#/entry/Shared?library=A&return=%23%2Flibrary%3Flibrary%3DA'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  const main = Array.from(element.querySelectorAll('main')).find(node => !node.closest('[hidden]'))!;
  const hash = location.hash;
  await emit('change', { revision: 'r1' }); await tick();
  expect(main.isConnected).toBe(true); expect(main.textContent).toContain('A content');
  expect(element.querySelector('[data-snl-local-read-status="updating"]')).not.toBeNull();
  await resolve(2, {}, false); await resolve(3, {}, false);
  expect(main.textContent).toContain('A content');
  expect(element.querySelector('[data-snl-local-read-error="snapshot"]')?.textContent).toContain('500');
  await emit('change', { revision: 'r2' }); await tick();
  expect(element.querySelector('[role="alert"]')).not.toBeNull(); // Error remains explicit until success.
  await resolve(4, workspace()); await resolve(5, snapshot('A', 'Recovered content'));
  expect(main.isConnected).toBe(true); expect(main.textContent).toContain('Recovered content');
  expect(element.querySelector('[role="alert"]')).toBeNull();
  expect(element.querySelector('[data-snl-local-read-status]')).toBeNull();
  expect(location.hash).toBe(hash);
});

it.each(['success', 'error'] as const)('discards late automatic A %s after navigation to B, and drains only the current library', async outcome => {
  vi.useFakeTimers(); await go('#/library?library=A'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  await emit('change', { revision: 'r1' }); await tick();
  await emit('change', { revision: 'r2' });
  await go('#/library?library=B'); expect(requests[3].signal.aborted).toBe(true);
  await resolve(4, snapshot('B')); await resolve(2, workspace()); await tick();
  expect(requests.slice(5).map(request => request.url)).toEqual(['/__snl/api/workspace', '/__snl/api/snapshot?library=B']);
  if (outcome === 'success') await resolve(3, snapshot('A', 'Late A data'));
  else await act(async () => requests[3].response.reject(new Error('Late A error')));
  expect(element.textContent).toContain('B content'); expect(element.textContent).not.toContain('Late A');
  await resolve(5, workspace()); await resolve(6, snapshot('B', 'Fresh B'));
  expect(element.textContent).toContain('Fresh B'); expect(TestEventSource.instances).toHaveLength(1);
});

it.each(['timer', 'read'] as const)('retires stream listeners and late events after unmount with pending %s', async phase => {
  vi.useFakeTimers(); await go('#/library?library=A'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  const retained = new Map(events().listeners);
  expect([...retained.keys()].sort()).toEqual(['change', 'error', 'unavailable']);
  await emit('change', { revision: 'pending' });
  if (phase === 'read') { await tick(); await emit('change', { revision: 'trailing' }); }
  const count = requests.length;
  await act(async () => root.unmount());
  expect(events().close).toHaveBeenCalledOnce(); expect(events().listeners.size).toBe(0);
  await act(async () => {
    retained.get('error')!(new Event('error'));
    retained.get('unavailable')!(new MessageEvent('unavailable', { data: '{"message":"late"}' }));
    retained.get('change')!(new MessageEvent('change', { data: '{"revision":"late"}' }));
  });
  if (phase === 'read') {
    expect(requests[2].signal.aborted).toBe(true); expect(requests[3].signal.aborted).toBe(true);
    await resolve(2, workspace()); await resolve(3, snapshot('A', 'Late content'));
  }
  await tick(); expect(requests).toHaveLength(count); expect(element.textContent).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

it('does not scroll back to an unchanged node anchor on automatic content refresh', async () => {
  vi.useFakeTimers();
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    await go('#/node/same?library=A'); await mount(); await resolve(0, workspace()); await resolve(1, snapshot('A'));
    const card = element.querySelector('[data-snl-route-id="same"]');
    const calls = scroll.mock.calls.length; expect(calls).toBeGreaterThan(0);
    await emit('change', { revision: 'r1' }); await tick();
    await resolve(2, workspace()); await resolve(3, snapshot('A', 'Updated in place'));
    expect(element.querySelector('[data-snl-route-id="same"]')).toBe(card);
    expect(element.textContent).toContain('Updated in place');
    expect(scroll).toHaveBeenCalledTimes(calls);
  } finally { HTMLElement.prototype.scrollIntoView = original; }
});

it('does not connect a frozen reader to workspace events', async () => {
  await go('#/library'); await act(async () => root.render(<BrowserReader snapshot={snapshot('A')} />));
  expect(element.textContent).toContain('A content');
  expect(TestEventSource.instances).toHaveLength(0); expect(requests).toHaveLength(0);
  expect(element.querySelector('[data-snl-local-watch-status]')).toBeNull();
});

it('replays its subscription safely in StrictMode and ignores the retired stream', async () => {
  vi.useFakeTimers(); await act(async () => root.render(<StrictMode><LocalWorkspaceReader /></StrictMode>));
  expect(TestEventSource.instances).toHaveLength(2); expect(events().close).toHaveBeenCalledOnce();
  expect(events().listeners.size).toBe(0); expect(requests[0].signal.aborted).toBe(true);
  await act(async () => TestEventSource.instances[1].emit('change', { revision: 'initial' }));
  await resolve(0, workspace([], 'Retired')); await resolve(1, workspace()); await tick();
  expect(requests).toHaveLength(3); await resolve(2, workspace([], 'Live'));
  expect(element.textContent).toContain('Live'); expect(element.textContent).not.toContain('Retired');
});

it('keeps language controls live after rereading an identical snapshot', async () => {
  vi.useFakeTimers(); await go('#/library?library=A'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  await click(element.querySelector('[aria-label^="Interface language"]')!);
  await click(element.querySelector('[data-language="zh-CN"]')!);
  expect(watchStatus().textContent).toContain('正在连接');
  await emit('change', { revision: 'same' }); await tick();
  await resolve(2, workspace()); await resolve(3, snapshot('A'));
  await click(element.querySelector('[aria-label^="界面语言"]')!);
  await click(element.querySelector('[data-language="en"]')!);
  expect(watchStatus().textContent).toBe('Automatic updates connected.');
});

it.each(['same', 'different'] as const)('preserves the chosen reading language through SSE adoption with a %s snapshot ID', async identity => {
  vi.useFakeTimers(); await go('#/library?library=A'); await mount();
  const initial = bilingualSnapshot();
  await resolve(0, workspace()); await resolve(1, initial);
  const main = element.querySelector('main')!;
  expect(main.textContent).toContain('English reading original');
  await click(button('Content language: English'));
  await click(button('简体中文'));
  expect(main.textContent).toContain('中文正文 original');
  expect(main.textContent).not.toContain('English reading original');
  const hash = location.hash;
  await emit('change', { revision: 'next' }); await tick();
  expect(main.textContent).toContain('中文正文 original');
  const next = bilingualSnapshot('updated');
  if (identity === 'different') next.renderSnapshotId += ':next';
  expect(next.renderSnapshotId === initial.renderSnapshotId).toBe(identity === 'same');
  await resolve(2, workspace()); await resolve(3, next);
  expect(main.isConnected).toBe(true);
  expect(main.textContent).toContain('中文正文 updated');
  expect(main.textContent).not.toContain('English reading updated');
  expect(button('Content language: 简体中文')).toBeDefined();
  expect(document.documentElement.lang).toBe('en');
  expect(location.hash).toBe(hash);
  // The replacement preference adapter must still let users change the language.
  await click(button('Content language: 简体中文'));
  await click(button('English'));
  expect(main.textContent).toContain('English reading updated');
  expect(main.textContent).not.toContain('中文正文 updated');
});

it('initializes frozen HTML reading language from its snapshot independently of interface language', async () => {
  set_content_language('en');
  const initial = bilingualSnapshot(); initial.contentLanguage = 'zh-CN';
  await go('#/library'); await act(async () => root.render(<StrictMode><BrowserReader snapshot={initial} /></StrictMode>));
  expect(element.textContent).toContain('中文正文 original');
  expect(element.textContent).not.toContain('English reading original');
  expect(button('Content language: 简体中文')).toBeDefined();
  expect(document.documentElement.lang).toBe('en');
  expect(TestEventSource.instances).toHaveLength(0); expect(requests).toHaveLength(0);
});

it('refreshes search against the latest typed query while preserving focus, input, and return hash', async () => {
  vi.useFakeTimers(); await go('#/search?library=A&q=old&return=%23%2Fnode%2Fsame%3Flibrary%3DA'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  const input = element.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Shared');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tick(); const hash = location.hash; expect(decodeReaderRoute(hash)).toMatchObject({ q: 'Shared' });
  await emit('change', { revision: 'r1' }); await tick();
  const next = snapshot('A'); next.entries[0].title = 'Shared changed';
  await resolve(2, workspace()); await resolve(3, next);
  expect(element.querySelector('[role="option"]')?.textContent).toContain('Shared changed');
  expect(input.value).toBe('Shared'); expect(document.activeElement).toBe(input); expect(location.hash).toBe(hash);
  await click(element.querySelector('[role="option"]')!);
  await click(button('Back')); expect(location.hash).toBe(hash);
});

it('renders a read-only Libraries table from catalog summaries without fetching snapshots', async () => {
  await mount();
  await resolve(0, workspace([
    { slug: 'A', title: 'Library A', entryCount: 12, relationshipCount: 4 },
    { slug: 'B', title: 'Library B', entryCount: 0, relationshipCount: null },
    { slug: 'legacy', title: '' }
  ]));
  const table = element.querySelector('table')!;
  expect(table).not.toBeNull();
  expect(Array.from(table.querySelectorAll('th'), th => th.textContent)).toEqual(['Title', 'Slug', 'Entries', 'Relationships']);
  expect(Array.from(table.querySelectorAll('tbody tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent)))
    .toEqual([['Library A', 'A', '12', '4'], ['Library B', 'B', '0', '—'], ['legacy', 'legacy', '—', '—']]);
  expect(table.querySelectorAll('button')).toHaveLength(3);
  expect(table.querySelector('[aria-label*="Edit"], [aria-label*="Delete"], input')).toBeNull();
  expect(element.querySelector('[aria-label*="Create"]')).toBeNull();
  expect(requests.map(request => request.url)).toEqual(['/__snl/api/workspace']);
  const open = table.querySelector<HTMLButtonElement>('button[aria-label="Open library A"]')!;
  expect(open).not.toBeNull();
  expect(open.type).toBe('button');
  expect(open.disabled).toBe(false);
  await act(async () => open.focus());
  expect(document.activeElement).toBe(open);
  await click(open);
  expect(decodeReaderRoute(location.hash)).toEqual({ kind: 'library', librarySlug: 'A' });
  expect(requests.map(request => request.url)).toEqual(['/__snl/api/workspace', '/__snl/api/snapshot?library=A']);
  await go('#/workspace');
  await click(element.querySelector('table tbody tr:nth-child(2) td:nth-child(2)')!);
  expect(decodeReaderRoute(location.hash)).toEqual({ kind: 'library', librarySlug: 'B' });
  expect(requests[2].url).toBe('/__snl/api/snapshot?library=B');
});

it('contains long catalog text in the shared table scrollport while retaining Panel layout', async () => {
  const title = 'A long library title '.repeat(20);
  const slug = 'long-slug-'.repeat(20);
  await mount(); await resolve(0, workspace([{ title, slug }]));
  const main = element.querySelector('main')!;
  expect(main.style.width).toBe('100%');
  expect(main.style.minWidth).toBe('0px');
  expect(main.style.boxSizing).toBe('border-box');
  const scrollport = element.querySelector<HTMLElement>('.snl-libraries-table-scroll')!;
  expect(scrollport.style.overflowX).toBe('auto');
  expect(scrollport.style.maxWidth).toBe('100%');
  const table = scrollport.querySelector('table')!;
  expect(table.style.tableLayout).toBe('fixed');
  expect(table.style.minWidth).toBe('40rem');
  const cells = table.querySelectorAll('td');
  expect(cells[0].textContent).toBe(title);
  expect(cells[1].textContent).toBe(slug);
  expect(cells[1].style.overflowWrap).toBe('anywhere');
  expect(cells[0].querySelector('button')!.style.whiteSpace).toBe('normal');
  expect(cells[0].querySelector('button')!.style.overflowWrap).toBe('anywhere');
  // Actual browser geometry and native Enter/Space activation are the host acceptance gate.
});

it('uses one real PanelHeader for workspace loading, home, library loading and failures', async () => {
  await mount();
  const check = () => {
    expect(visibleHeaders()).toHaveLength(1);
    expect(visibleHeaders()[0].classList.contains('snl-panel-header')).toBe(true);
    expect(visibleHeaders()[0].querySelector('svg[data-snl-icon="refresh"]')).not.toBeNull();
    expect(visibleHeaders()[0].textContent).toContain('Read-only');
    expect(visibleHeaders()[0].querySelector('[aria-label^="Interface language"]')).not.toBeNull();
    expect(visibleHeaders()[0].querySelector('[aria-label^="Content language"]')).not.toBeNull();
    expect(visibleHeaders()[0].querySelector('[aria-label="Reading preferences"]')).not.toBeNull();
  };
  check();
  await resolve(0, workspace()); check();
  await go('#/library?library=A'); check();
  await resolve(1, {}, false); check();
});

it('merges local navigation into each route header without duplicate Back or graph actions', async () => {
  await go('#/library?library=A'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  const check = () => {
    expect(visibleHeaders()).toHaveLength(1);
    const header = visibleHeaders()[0];
    expect(header.classList.contains('snl-panel-header')).toBe(true);
    expect(header.querySelectorAll('svg[data-snl-icon="chevron-left"]')).toHaveLength(1);
    expect(header.querySelectorAll('svg[data-snl-icon="graph"]')).toHaveLength(1);
    expect(header.querySelectorAll('svg[data-snl-icon="search"]')).toHaveLength(1);
    expect(header.querySelectorAll('svg[data-snl-icon="refresh"]')).toHaveLength(1);
    expect(header.textContent).not.toContain('View Graph');
  };
  check();
  for (const route of ['#/node/same?library=A', '#/entry/Shared?library=A', '#/entry/missing?library=A', '#/search?library=A&q=Shared', '#/graph?library=A', '#/macro/symbol?library=A', '#/macro/missing?library=A', '#/unavailable?library=A']) {
    await go(route); check();
  }
});
const click = async (node: Element) => { expect(node).toBeDefined(); await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };

it('applies workspace header preferences immediately and keeps them across reading and return', async () => {
  await mount(); await resolve(0, workspace());
  await click(element.querySelector('[aria-label^="Interface language"]')!);
  await click(element.querySelector('[data-language="zh-CN"]')!);
  expect(visibleHeaders()[0].getAttribute('aria-label')).toBe('面板导航');
  expect(visibleHeaders()[0].textContent).toContain('只读');
  expect(Array.from(element.querySelectorAll('.snl-libraries-table th'), cell => cell.textContent)).toEqual(['标题', '标识名', '条目数', '关系数']);
  expect(element.querySelector('.snl-libraries-table button[aria-label="打开库 A"]')).not.toBeNull();
  expect(element.querySelector('.snl-libraries-table button[aria-label*="编辑"]')).toBeNull();
  await click(element.querySelector('[aria-label="阅读偏好"]')!);
  const theme = element.querySelector<HTMLSelectElement>('select[aria-label="主题"]')!;
  await act(async () => { theme.value = 'dark'; theme.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.documentElement.dataset.snlColorScheme).toBe('dark');
  await go('#/library?library=A'); await resolve(1, snapshot('A'));
  expect(visibleHeaders()[0].getAttribute('aria-label')).toBe('面板导航');
  expect(document.documentElement.dataset.snlColorScheme).toBe('dark');
  await click(button('工作区'));
  expect(visibleHeaders()[0].getAttribute('aria-label')).toBe('面板导航');
});

it('loads an empty workspace home without inventing a Library and refreshes its catalog', async () => {
  await mount();
  expect(requests.map(r => r.url)).toEqual(['/__snl/api/workspace']);
  await resolve(0, workspace([]));
  expect(element.textContent).toContain('My workspace');
  expect(element.textContent).toContain('/folder');
  expect(element.textContent).toContain('No libraries');
  expect(element.textContent).not.toContain('frozen export');
  await click(button('Refresh this panel from disk'));
  expect(requests.map(r => r.url)).toEqual(['/__snl/api/workspace', '/__snl/api/workspace']);
  await resolve(1, workspace(undefined, 'Renamed workspace'));
  expect(element.textContent).toContain('Renamed workspace');
  await click(element.querySelector('table.snl-libraries-table tr[data-row-id="A"] button[aria-label="Open library A"]')!);
  expect(decodeReaderRoute(location.hash)).toEqual({ kind: 'library', librarySlug: 'A' });
  expect(requests[2].url).toBe('/__snl/api/snapshot?library=A');
  await resolve(2, snapshot('A'));
  expect(element.textContent).toContain('A content');
  expect(element.textContent).toContain('Source navigation is not connected');
  expect(element.querySelector('[title*="frozen export"]')).toBeNull();
  await click(button('Workspace'));
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
  await click(button('Refresh this panel from disk'));
  expect(requests.slice(3).map(r => r.url)).toEqual(['/__snl/api/workspace', '/__snl/api/snapshot?library=B']);
  await resolve(4, snapshot('B', 'B refreshed'));
  await resolve(3, workspace(undefined, 'Fresh catalog'));
  expect(element.textContent).toContain('B refreshed');
  expect(element.textContent).not.toContain('B content');
  await click(button('Workspace'));
  expect(element.textContent).toContain('Fresh catalog');
  await go('#/library?library=A');
  expect(requests[5].url).toBe('/__snl/api/snapshot?library=A');
  await resolve(5, snapshot('A', 'A reread'));
  expect(element.textContent).toContain('A reread');
});

it('discards superseded same-library refreshes, including the catalog, and aborts reads on unmount', async () => {
  await go('#/library?library=A'); await mount();
  await resolve(0, workspace()); await resolve(1, snapshot('A'));
  await click(button('Refresh this panel from disk'));
  await click(button('Refresh this panel from disk'));
  expect(requests[2].signal.aborted).toBe(true);
  expect(requests[3].signal.aborted).toBe(true);
  await resolve(4, workspace(undefined, 'Newest catalog')); await resolve(5, snapshot('A', 'Newest snapshot'));
  await resolve(2, workspace(undefined, 'Stale catalog')); await resolve(3, snapshot('A', 'Stale snapshot'));
  expect(element.textContent).toContain('Newest snapshot');
  expect(element.textContent).not.toContain('Stale snapshot');
  await click(button('Workspace'));
  expect(element.textContent).toContain('Newest catalog');
  await click(button('Refresh this panel from disk'));
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
  await click(button('Refresh this panel from disk'));
  await resolve(2, workspace()); await resolve(3, snapshot('other'));
  expect(element.querySelector('[role="alert"]')?.textContent).toContain('library');
  expect(element.textContent).not.toContain('other content');
  await click(button('Workspace'));
  expect(Array.from(element.querySelectorAll('table.snl-libraries-table tbody button'), node => node.getAttribute('aria-label'))).toEqual(['Open library A', 'Open library B']);
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
  await click(main.querySelector('.snl-panel-header button[aria-label="Back"]')!);
  expect(location.hash).toBe(hash);
  expect(requests).toHaveLength(2);
});
