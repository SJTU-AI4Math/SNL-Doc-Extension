import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FrozenReaderSnapshot } from '../../../src/sharedReaderSnapshot';
import { BrowserReader } from './BrowserReader';
import { PanelHeader } from '../components/PanelHeader';
import { createBrowserPreferences } from './browserPreferences';
import { BUILT_IN_LANGUAGE_CATALOG } from '../../../src/languageCatalog';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { PANEL_STYLE } from '../vscodeApi';
import { LibrariesTable, type LibrarySummary } from '../components/LibrariesTable';
import { encodeReaderRoute } from './readerRoute';
import { navigateReaderHash, useReaderLocation } from './readerHistory';
import { useLocalWorkspaceEvents } from './useLocalWorkspaceEvents';

export interface LocalReaderWorkspace {
  id: 'local';
  name: string;
  root: string;
  libraries: LibrarySummary[];
  capabilities: { edit: false };
}
const MESSAGES = defineUiMessages('localWorkspaceReader', {
  title: 'Local workspace', workspace: 'Workspace', refresh: 'Refresh', loading: 'Loading…',
  scope: 'Scope: all entries, macros and relationships in this local workspace (read-only).',
  readonly: 'Read-only', empty: 'No libraries in this workspace.',
  source: 'Source navigation is not connected to the local server yet.',
  unavailable: 'This destination is unavailable in this workspace.',
  missing: 'Not found in this workspace', graphEmpty: 'No relationships to display with the current filters.',
  failed: 'Could not read workspace data: {message}',
  connecting: 'Connecting to automatic updates…', connected: 'Automatic updates connected.',
  reconnecting: 'Automatic update connection lost; reconnecting. You can still Refresh manually.',
  watchUnavailable: 'Workspace monitoring is unavailable. You can still Refresh manually.',
  watchDetail: 'Workspace monitoring is unavailable: {message}. You can still Refresh manually.',
  unsupported: 'Automatic updates are not supported in this browser. Use Refresh to reread the workspace.',
  updating: 'Updating workspace data… Previous content remains visible until the read succeeds.'
}, {
  title: '本地工作区', workspace: '工作区', refresh: '刷新', loading: '正在加载……',
  scope: '范围：本地工作区的全部条目、宏和关系（只读）。', readonly: '只读', empty: '此工作区暂无文档库。',
  source: '源码定位尚未接入本地服务。', unavailable: '此目的地在工作区中不可用。', missing: '工作区中未找到',
  graphEmpty: '当前筛选下无可显示的关系。', failed: '无法读取工作区数据：{message}',
  connecting: '正在连接自动更新……', connected: '自动更新已连接。',
  reconnecting: '自动更新连接已断开，正在重连。仍可手动刷新。',
  watchUnavailable: '工作区文件监控不可用。仍可手动刷新。',
  watchDetail: '工作区文件监控不可用：{message}。仍可手动刷新。',
  unsupported: '此浏览器不支持自动更新。请手动刷新以重新读取工作区。',
  updating: '正在更新工作区数据……读取成功前继续显示原内容。'
});
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const ANNOUNCEMENT_STYLE: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' };
const NOTICE_STYLE: React.CSSProperties = { position: 'fixed', bottom: 12, left: 12, right: 12, zIndex: 100, margin: 0, padding: '8px 12px', overflowWrap: 'anywhere', background: 'var(--vscode-editor-background, #fff)', border: '1px solid currentColor', borderRadius: 4 };

/** The shell only chooses a snapshot. Routing, search, graph and reading belong to BrowserReader. */
export function LocalWorkspaceReader(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const { route } = useReaderLocation();
  const librarySlug = route.kind === 'workspace' ? undefined : route.librarySlug;
  const [refresh, setRefresh] = useState(0);
  const [catalog, setCatalog] = useState<{ value?: LocalReaderWorkspace; error?: string; loading: boolean; refresh: number }>({ loading: true, refresh: 0 });
  const [reading, setReading] = useState<{ slug: string; refresh: number; snapshot?: FrozenReaderSnapshot; error?: string; loading: boolean }>();
  const refreshWorkspace = useCallback(() => setRefresh(value => value + 1), []);
  const busy = catalog.loading || catalog.refresh !== refresh || (librarySlug !== undefined &&
    (reading?.slug !== librarySlug || reading.refresh !== refresh || reading.loading));
  const watch = useLocalWorkspaceEvents(busy, refreshWorkspace);
  const catalogGeneration = useRef(0);
  const snapshotGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++catalogGeneration.current;
    let active = true;
    setCatalog(current => ({ ...current, loading: true, refresh }));
    void getJson<LocalReaderWorkspace>('/__snl/api/workspace', controller.signal).then(value => {
      if (active && generation === catalogGeneration.current) setCatalog({ value, loading: false, refresh });
    }, error => {
      if (active && generation === catalogGeneration.current) setCatalog(current => ({ value: current.value, error: errorMessage(error), loading: false, refresh }));
    });
    return () => { active = false; controller.abort(); };
  }, [refresh]);
  useEffect(() => {
    const generation = ++snapshotGeneration.current;
    if (librarySlug === undefined) { setReading(undefined); return; }
    const slug = librarySlug;
    const controller = new AbortController();
    let active = true;
    setReading(current => ({ slug, refresh, loading: true, snapshot: current?.slug === slug ? current.snapshot : undefined, error: current?.slug === slug ? current.error : undefined }));
    void getJson<FrozenReaderSnapshot>('/__snl/api/snapshot?' + new URLSearchParams({ library: slug }), controller.signal).then(snapshot => {
      if (snapshot.version !== 1 || snapshot.library?.slug !== slug) throw new Error('Invalid snapshot version or library identity');
      if (active && generation === snapshotGeneration.current) setReading({ slug, refresh, loading: false, snapshot });
    }).catch(error => {
      if (active && generation === snapshotGeneration.current) setReading(current => ({ slug, refresh, loading: false, snapshot: current?.slug === slug ? current.snapshot : undefined, error: errorMessage(error) }));
    });
    return () => { active = false; controller.abort(); };
  }, [librarySlug, refresh]);
  // Guard the render preceding effect cleanup too: A data must never be presented under B's URL.
  // Keep accepted same-library content mounted while rereading (also on read errors).
  const current = reading?.slug === librarySlug ? reading : undefined;
  const home = () => navigateReaderHash(encodeReaderRoute({ kind: 'workspace' }));
  return <>
    {/* Live status must not add a toolbar or move the reading position on every save. */}
    <aside style={watch.state !== 'connected' || (current?.snapshot && (current.error || catalog.error)) ? NOTICE_STYLE : ANNOUNCEMENT_STYLE}>
      <p data-snl-local-watch-status={watch.state} role="status" style={watch.state === 'connected' ? ANNOUNCEMENT_STYLE : { margin: 0 }}>
        {watch.state === 'unavailable' ? watch.message ? t('watchDetail', { message: watch.message }) : t('watchUnavailable') : t(watch.state)}
      </p>
      {current?.snapshot && current.error ? <p data-snl-local-read-error="snapshot" role="alert">{t('failed', { message: current.error })}</p> : null}
      {current?.snapshot && catalog.error ? <p data-snl-local-read-error="catalog" role="alert">{t('failed', { message: catalog.error })}</p> : null}
    </aside>
    {busy && (catalog.value || current?.snapshot) ? <p data-snl-local-read-status="updating" role="status" style={ANNOUNCEMENT_STYLE}>{t('updating')}</p> : null}
    {librarySlug === undefined ? <main style={PANEL_STYLE}>
      <WorkspaceHeader title={catalog.value?.name ?? t('title')} onRefresh={refreshWorkspace} />
      {catalog.error ? <p data-snl-local-read-error="catalog" role="alert">{t('failed', { message: catalog.error })}</p> : null}
      {catalog.value ? <>
        <p style={{ overflowWrap: 'anywhere' }}><code>{catalog.value.root}</code></p>
        {catalog.value.libraries.length ? <LibrariesTable
          libraries={catalog.value.libraries}
          readOnly
          onOpen={slug => navigateReaderHash(encodeReaderRoute({ kind: 'library', librarySlug: slug }))}
        /> : <p>{t('empty')}</p>}
      </> : null}
      {catalog.loading ? <p role="status">{t('loading')}</p> : null}
    </main> : current?.snapshot ? <BrowserReader key={librarySlug} snapshot={current.snapshot} hostContext={{
      librarySlug, scope: t('scope'), sourceUnavailableReason: t('source'), unavailable: t('unavailable'),
      missingEntry: t('missing'), graphEmpty: t('graphEmpty'), workspaceLabel: t('workspace'), onWorkspace: home, onRefresh: refreshWorkspace
    }} /> : <main style={PANEL_STYLE}>
      <WorkspaceHeader title={catalog.value?.name ?? t('title')} onWorkspace={home} onRefresh={refreshWorkspace} />
      {catalog.error ? <p data-snl-local-read-error="catalog" role="alert">{t('failed', { message: catalog.error })}</p> : null}
      {current?.error ? <p data-snl-local-read-error="snapshot" role="alert">{t('failed', { message: current.error })}</p> : <p role="status">{t('loading')}</p>}
    </main>}
  </>;
}

/** Only the browser I/O port differs; the actual header is the Extension component. */
function WorkspaceHeader({ title, onWorkspace, onRefresh }: { title: string; onWorkspace?: () => void; onRefresh(): void }): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [preferences] = useState(() => createBrowserPreferences({ language: document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en', color_scheme: 'light', motion: 'reduced' }, 'local-workspace', BUILT_IN_LANGUAGE_CATALOG.map(language => ({ id: language.id, display_name: language.display_name }))));
  useEffect(() => { preferences.load(); }, [preferences]);
  const api = { postMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'nav.refresh') onRefresh();
    else preferences.handle(msg);
  } };
  return <PanelHeader title={title} vsApi={api} host={{ showRefresh: true, status: t('readonly'), statusTitle: t('scope'),
    back: onWorkspace ? { label: t('workspace'), onClick: onWorkspace } : undefined }} />;
}
