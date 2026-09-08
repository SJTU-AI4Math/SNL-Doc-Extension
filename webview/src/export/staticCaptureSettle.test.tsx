import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { installReaderPlatformApi } from '../runtime/readerPlatform';
import { get_content_language, set_content_language } from '../runtime/preferencesRuntime';
import { hasPendingExportSurface, waitForExportSurfaces } from './htmlExport';

const api = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('../vscodeApi', async (original) => ({
  ...await original<typeof import('../vscodeApi')>(),
  useVsCodeApiRef: () => ({ current: api })
}));
const artwork = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="2" y="20">Settled artwork</text></svg>';
let identity = 0;
let releasePlatform: () => void;
let previousLanguage: ReturnType<typeof get_content_language>;
let previousDocumentLanguage: string;
const messages = (type: string) => api.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type);
const send = (data: unknown) => act(() => window.dispatchEvent(new MessageEvent('message', { data })));
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
function library(slug = `library-${++identity}`) {
  return {
    type: 'libraryEntries', slug, title: slug, renderSnapshotId: `snapshot-${slug}`, entries: [],
    outline: [{ nodeId: 'parent', entry: null, kind: null, counterLabel: null, children: [{
      nodeId: 'child', entry: { id: 'child', kind: '', title: { type: 'i18n', default_language: 'en', values: { en: 'English child', 'zh-CN': '中文子条目' } }, content: { snl: 'Diagram' }, pointer: null },
      kind: null, counterLabel: null, children: []
    }] }],
    macros: { Diagram: { name: 'Diagram', description: '', source: { entries: [], urls: [] }, dynamic_arity: false, tags: [], styles: [{ style_name: 'default', tags: [], template: {
      mode: 'block', body: '', block_template_name: 'svg_template', svg_template: {
        asset: { source: 'assets/proof.svg', base_identity: slug, revision: 'sha256:02acc6eebf05004077bd159dea685ab45f13523b8f099013138a5663a87543b8', request_epoch: 1 },
        generation: 1, producer_revision: 'test-v1', accessibility: { label: 'Proof diagram' }
      }
    } }] } }
  };
}
async function start() {
  const view = render(<App />);
  const data = library(); send(data);
  expect(view.container.querySelector('[data-snl-route-id="child"]')).toBeNull();
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
  await advance(0);
  expect(messages('snl.assets/read-svg')).toHaveLength(1);
  const request = messages('snl.assets/read-svg')[0];
  expect(view.container.querySelector('.snl-svg-template-loading')).not.toBeNull();
  expect(hasPendingExportSurface(view.container)).toBe(true);
  return { ...view, data, request };
}
async function release(request: object) {
  send({ ...request, type: 'snl.assets/svg-source', value: artwork });
  // Commit the promise-driven renderer update before driving the quiet frames.
  await advance(0);
  await advance(48);
}
beforeEach(() => {
  previousLanguage = get_content_language();
  previousDocumentLanguage = document.documentElement.lang;
  releasePlatform = installReaderPlatformApi(api);
  document.documentElement.lang = 'en';
  set_content_language('zh-CN');
  api.postMessage.mockClear();
});
afterEach(() => {
  cleanup(); vi.useRealTimers();
  set_content_language(previousLanguage);
  document.documentElement.lang = previousDocumentLanguage;
  releasePlatform(); api.postMessage.mockClear();
});

describe('shared reader static fallback capture settlement', () => {
  it.each(['unchanged attributes', 'changing text'])('measures semantic quietness amid %s', async activity => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.setAttribute('data-state', 'positioned');
    const text = root.appendChild(document.createTextNode('0'));
    document.body.appendChild(root);
    const controller = new AbortController();
    let settled = false, generation = 0;
    const repeat = setInterval(() => {
      if (activity === 'unchanged attributes') root.setAttribute('data-state', 'positioned');
      else text.nodeValue = String(++generation);
    }, 8);
    const waiting = waitForExportSurfaces(root, { signal: controller.signal }).then(() => { settled = true; }, () => {});
    try {
      await advance(80);
      expect(settled).toBe(activity === 'unchanged attributes');
      clearInterval(repeat);
      await advance(64);
      expect(settled).toBe(true);
    } finally {
      clearInterval(repeat); controller.abort(); await waiting; root.remove();
    }
  });

  it.each([false, true])('disposes the wait deadline/frame when aborted (pre-aborted: %s)', async preAborted => {
    vi.useFakeTimers();
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const waiting = waitForExportSurfaces(document.createElement('div'), { signal: controller.signal });
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures only the new render snapshot after a same-slug refresh', async () => {
    const { data, request } = await start();
    const next = library(data.slug);
    next.renderSnapshotId = 'new-snapshot';
    next.macros.Diagram.styles[0].template.svg_template.asset.request_epoch = 2;
    send(next);
    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
    await advance(0);
    const requests = messages('snl.assets/read-svg');
    expect(requests).toHaveLength(2);
    await release(requests[1]);
    await release(request);
    expect(messages('exportLibraryHtml')).toHaveLength(1);
    expect(messages('exportLibraryHtml')[0].renderSnapshotId).toBe('new-snapshot');
    expect(messages('exportLibraryHtmlError')).toHaveLength(0);
  });

  it('times out without publishing a half-rendered fallback, and permits a settled retry', async () => {
    const { request } = await start();
    await advance(5100);
    expect(messages('exportLibraryHtml')).toHaveLength(0);
    expect(messages('exportLibraryHtmlError')).toHaveLength(1);
    expect(messages('exportLibraryHtmlError')[0].error).toMatch(/timed out/i);
    await release(request);
    expect(messages('exportLibraryHtml')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
    await advance(100);
    expect(messages('exportLibraryHtml')).toHaveLength(1);
  });

  it('only publishes the newest of repeated requests', async () => {
    const { request } = await start();
    fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));
    await advance(200);
    expect(messages('exportLibraryHtml')).toHaveLength(0);
    await release(request);
    expect(messages('exportLibraryHtml')).toHaveLength(1);
    expect(messages('exportLibraryHtmlError')).toHaveLength(0);
  });

  it.each(['replacement', 'root', 'back', 'unmount', 'locale'])('cancels capture on %s and rejects late completion', async change => {
    const { request, unmount } = await start();
    if (change === 'replacement') send(library());
    if (change === 'root') send({ type: 'libraries', libraries: [] });
    if (change === 'back') fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    if (change === 'unmount') unmount();
    if (change === 'locale') act(() => set_content_language('en'));
    await release(request);
    await advance(5100);
    expect(messages('exportLibraryHtml')).toHaveLength(0);
    expect(messages('exportLibraryHtmlError')).toHaveLength(0);
    expect(get_content_language()).toBe(change === 'locale' ? 'en' : 'zh-CN');
  });

  it('does not publish if the user removes outline branches while capture is pending', async () => {
    const { request } = await start();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    await release(request);
    expect(messages('exportLibraryHtml')).toHaveLength(0);
    expect(messages('exportLibraryHtmlError')).toHaveLength(1);
  });

  it('waits for a delayed real Basics SVG after expanding omitted children, without changing locale', async () => {
    const { container, data, request } = await start();
    await advance(200);
    expect(messages('exportLibraryHtml')).toHaveLength(0);
    expect(get_content_language()).toBe('zh-CN');
    await release(request);
    expect(hasPendingExportSurface(container)).toBe(false);
    const [payload] = messages('exportLibraryHtml');
    expect(messages('exportLibraryHtml')).toHaveLength(1);
    expect(payload).toMatchObject({ slug: data.slug, renderSnapshotId: data.renderSnapshotId, locale: 'zh-CN' });
    expect(payload.body).toContain('snl-svg-template-artwork');
    expect(payload.body).toContain('Settled artwork');
    expect(payload.body).toContain('中文子条目');
    expect(payload.body).not.toContain('snl-svg-template-loading');
    expect(messages('snl.content-language/changed')).toHaveLength(0);
  });
});
