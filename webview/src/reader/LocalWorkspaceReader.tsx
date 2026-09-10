import React, { useEffect, useRef, useState } from 'react';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
import { BrowserReader } from './BrowserReader';
import { Button } from '../components/Button';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { READER_STYLE } from './ReaderCapabilities';
import { encodeReaderRoute } from './readerRoute';
import { navigateReaderHash, useReaderLocation } from './readerHistory';

export interface LocalReaderWorkspace {
  id: 'local';
  name: string;
  root: string;
  libraries: Array<{ slug: string; title: string }>;
  capabilities: { edit: false };
}
const MESSAGES = defineUiMessages('localWorkspaceReader', {
  title: 'Local workspace', workspace: '← Workspace', refresh: 'Refresh', loading: 'Loading…',
  scope: 'Scope: all entries, macros and relationships in this local workspace (read-only).',
  readonly: 'Read-only folder data source', empty: 'No libraries in this workspace.',
  source: 'Source navigation is not connected to the local server yet.',
  unavailable: 'This destination is unavailable in this workspace.',
  missing: 'Not found in this workspace', graphEmpty: 'No relationships to display with the current filters.',
  failed: 'Could not read workspace data: {message}'
}, {
  title: '本地工作区', workspace: '← 工作区', refresh: '刷新', loading: '正在加载……',
  scope: '范围：本地工作区的全部条目、宏和关系（只读）。', readonly: '只读文件夹数据源', empty: '此工作区暂无文档库。',
  source: '源码定位尚未接入本地服务。', unavailable: '此目的地在工作区中不可用。', missing: '工作区中未找到',
  graphEmpty: '当前筛选下无可显示的关系。', failed: '无法读取工作区数据：{message}'
});
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The shell only chooses a snapshot. Routing, search, graph and reading belong to BrowserReader. */
export function LocalWorkspaceReader(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const { route } = useReaderLocation();
  const librarySlug = route.kind === 'workspace' ? undefined : route.librarySlug;
  const [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<{ value?: LocalReaderWorkspace; error?: string; loading: boolean }>({ loading: true });
  const [reading, setReading] = useState<{ slug: string; refresh: number; snapshot?: FrozenReaderSnapshot; error?: string; generation: number }>();
  const catalogGeneration = useRef(0);
  const snapshotGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++catalogGeneration.current;
    let active = true;
    setCatalog(current => ({ value: current.value, loading: true }));
    void getJson<LocalReaderWorkspace>('/__snl/api/workspace', controller.signal).then(value => {
      if (active && generation === catalogGeneration.current) setCatalog({ value, loading: false });
    }, error => {
      if (active && generation === catalogGeneration.current) setCatalog(current => ({ value: current.value, error: errorMessage(error), loading: false }));
    });
    return () => { active = false; controller.abort(); };
  }, [refresh]);
  useEffect(() => {
    const generation = ++snapshotGeneration.current;
    if (librarySlug === undefined) { setReading(undefined); return; }
    const slug = librarySlug;
    const controller = new AbortController();
    let active = true;
    setReading({ slug, refresh, generation });
    void getJson<FrozenReaderSnapshot>('/__snl/api/snapshot?' + new URLSearchParams({ library: slug }), controller.signal).then(snapshot => {
      if (snapshot.version !== 1 || snapshot.library?.slug !== slug) throw new Error('Invalid snapshot version or library identity');
      if (active && generation === snapshotGeneration.current) setReading({ slug, refresh, generation, snapshot });
    }).catch(error => {
      if (active && generation === snapshotGeneration.current) setReading({ slug, refresh, generation, error: errorMessage(error) });
    });
    return () => { active = false; controller.abort(); };
  }, [librarySlug, refresh]);
  // Guard the render preceding effect cleanup too: A data must never be presented under B's URL.
  const current = reading?.slug === librarySlug && reading?.refresh === refresh ? reading : undefined;
  const home = () => navigateReaderHash(encodeReaderRoute({ kind: 'workspace' }));
  return <>
    <header style={{ ...READER_STYLE, paddingBottom: 0 }}>
      <Button onClick={() => setRefresh(value => value + 1)}>{t('refresh')}</Button>
      {librarySlug !== undefined && !current?.snapshot ? <Button onClick={home}>{t('workspace')}</Button> : null}
      <p>{t('readonly')}</p>
      {catalog.error ? <p role="alert">{t('failed', { message: catalog.error })}</p> : null}
    </header>
    {librarySlug === undefined ? <main style={READER_STYLE}>
      <h1>{catalog.value?.name ?? t('title')}</h1>
      {catalog.value ? <>
        <p><code>{catalog.value.root}</code></p>
        {catalog.value.libraries.length ? <ul>{catalog.value.libraries.map(library => <li key={library.slug}>
          <a href={encodeReaderRoute({ kind: 'library', librarySlug: library.slug })} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); navigateReaderHash(encodeReaderRoute({ kind: 'library', librarySlug: library.slug }));
          }}>{library.title || library.slug}</a>
        </li>)}</ul> : <p>{t('empty')}</p>}
      </> : null}
      {catalog.loading ? <p role="status">{t('loading')}</p> : null}
    </main> : current?.snapshot ? <BrowserReader key={`${librarySlug}:${current.generation}`} snapshot={current.snapshot} hostContext={{
      librarySlug, scope: t('scope'), sourceUnavailableReason: t('source'), unavailable: t('unavailable'),
      missingEntry: t('missing'), graphEmpty: t('graphEmpty'), workspaceLabel: t('workspace'), onWorkspace: home
    }} /> : <main style={READER_STYLE}>
      {current?.error ? <p role="alert">{t('failed', { message: current.error })}</p> : <p role="status">{t('loading')}</p>}
    </main>}
  </>;
}
