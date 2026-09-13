import React, { useEffect, useInsertionEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SnooglApp } from '../SnooglApp';
import { SnlGraphApp } from '../SnlGraphApp';
import { BrowserMacroReader } from './BrowserMacroReader';
import { frozenRelationshipGraph, frozenSearchResults } from './browserDiscovery';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { Button } from '../components/Button';
import { LibraryLayer } from './LibraryReader';
import { EntryReader, type EntryReaderState } from './EntryReader';
import { ReaderCapabilitiesContext, READER_STYLE } from './ReaderCapabilities';
import { HoverPopoverProvider, useHoverPopovers } from '../render/HoverPopoverProvider';
import { use_localized } from '../runtime/useLocalized';
import { wireMacroEntriesToRenderable } from '../render/macroWire';
import { macroKindsToPalette } from '../render/macroKindPalette';
import { apply_preferences_snapshot, set_content_language, use_content_language } from '../runtime/preferencesRuntime';
import { installWorkspaceAssetBroker } from '../runtime/workspaceAssetBroker';
import { groupEntryRelationships } from '../../../src/entryInfoviewRelationships';
import type { FrozenReaderSnapshot, FrozenOutlineNode } from '../../../src/sharedReaderSnapshot';
import { decodeReaderRoute, encodeReaderRoute, frozenAssetReply, frozenImageUrl } from './browserPlatform';
import { installReaderPlatformApi } from '../runtime/readerPlatform';
import logoBlack from '../../../media/icons/logoCSS_black.svg';
import logoWhite from '../../../media/icons/logoCSS_white.svg';
import '../components/ui.css';

type BrowserHost = Window & typeof globalThis & {
  __SNL_READER__?: FrozenReaderSnapshot;
  __snlSources?: { pointers: Array<{ entryId: string }> };
  __snlExportSourceFollow?: () => void;
  __snlReaderRoutes?: Set<string>;
};
const host = window as BrowserHost;
const MESSAGES = defineUiMessages('browserDiscovery', {
  search: 'SNoogL', graph: 'Relationship graph', scope: 'Scope: this frozen export only.',
  unavailable: 'This destination is unavailable in this frozen export.', home: 'Library', back: '← Back',
  macroPreview: 'Read-only Macro preview', sourceEntries: 'Source Entries', sourceMissing: 'Not included in this export'
}, {
  search: 'SNoogL', graph: '关系图', scope: '范围：仅本次冻结导出。',
  unavailable: '此目的地在本次冻结导出中不可用。', home: '文档库', back: '← 返回',
  macroPreview: '宏只读预览', sourceEntries: '来源条目', sourceMissing: '未包含在本次导出中'
});
function RoutePopoverBoundary({ visible }: { visible: boolean }): null {
  const popovers = useHoverPopovers();
  useEffect(() => { if (!visible) popovers.dismissAll(); }, [visible, popovers.dismissAll]);
  return null;
}

/** Browser-only adapter. All reading, hover, relationships and controls below
 * are the same components mounted by the Extension panels. */
export function BrowserReader({ snapshot }: { snapshot: FrozenReaderSnapshot }): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [route, setRoute] = useState(() => decodeReaderRoute(location.hash));
  // Explicit navigation owns a fresh search session; local query edits only replace the URL.
  const [searchSession, setSearchSession] = useState(0);
  const contentLanguage = use_content_language();
  const sourceUnavailable = use_localized({type:'i18n',default_language:'en',values:{en:'Source is not included in this frozen export.','zh-CN':'此冻结导出未包含源码。'}});
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const entries = useMemo(() => snapshot.entries.map(entry => ({ id: entry.id, package: entry.package,
    title: entry.title, hasContent: !!entry.content.snl, snl: entry.content.snl })), [snapshot]);
  const byId = useMemo(() => new Map(snapshot.entries.map(entry => [entry.id, entry])), [snapshot]);
  const kinds = useMemo(() => new Map(snapshot.entryKinds.map(kind => [kind.id, kind])), [snapshot]);
  const details = useMemo(() => Object.fromEntries(snapshot.entries.map(entry => [entry.id, { entry, kind: kinds.get(entry.kind) ?? null }])), [snapshot, kinds]);
  const userMacros = useMemo(() => wireMacroEntriesToRenderable(Object.entries(snapshot.macros), contentLanguage), [snapshot, contentLanguage]);
  const kindPalette = useMemo(() => macroKindsToPalette(snapshot.macroKinds), [snapshot]);
  const committed = useRef<((message: unknown) => void) | null>(null);
  const active = useRef(false);
  const postMessage = useMemo(() => (message: unknown): void => { committed.current?.(message); }, []);
  const api = useMemo(() => ({ postMessage }), [postMessage]);
  const preferences = useRef({ ...snapshot.preferences });
  const revision = useRef(0);
  const navigate = (hash: string, passive = false): void => {
    if (location.hash !== hash) (passive ? history.replaceState : history.pushState).call(history, { ...history.state }, '', hash);
    flushSync(() => { setRoute(decodeReaderRoute(hash)); setSearchSession(value => value + 1); });
  };
  const publishPreferences = (): void => {
    apply_preferences_snapshot({ type: 'snl.preferences/snapshot', generation: snapshot.renderSnapshotId,
      revision: ++revision.current, preferences: preferences.current, supported_languages: snapshot.languages });
    try { localStorage.setItem('snl-reader-preferences', JSON.stringify(preferences.current)); } catch { /* file:// privacy mode */ }
  };
  const handleMessage = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    const asset = frozenAssetReply(snapshot.resources, msg);
    if (asset) { queueMicrotask(() => { if (active.current) window.dispatchEvent(new MessageEvent('message', { data: asset })); }); return; }
    const reply = (data: unknown): void => { queueMicrotask(() => { if (active.current) window.dispatchEvent(new MessageEvent('message', { data })); }); };
    switch (msg.type) {
      case 'ready':
        if (route.kind === 'search') reply(frozenSearchResults(snapshot, route));
        if (route.kind === 'graph') reply(frozenRelationshipGraph(snapshot));
        break;
      case 'query':
        if (route.kind === 'search' && typeof msg.q === 'string' && (msg.mode === 'entry' || msg.mode === 'macro')) {
          const filters = msg.filters as { kindId?: string; counterpartId?: string } | undefined;
          const query: import('./browserDiscovery').FrozenSearchQuery = { q: msg.q, mode: msg.mode, filters: filters ?? {} };
          // Query changes replace the current search destination, never add caret/keystroke history.
          history.replaceState(history.state, '', encodeReaderRoute({ ...route, ...query }));
          reply(frozenSearchResults(snapshot, query));
        }
        break;
      case 'openMacro':
        if (typeof msg.name === 'string' && Object.hasOwn(snapshot.macros, msg.name)) navigate(encodeReaderRoute({ kind: 'macro', name: msg.name, returnHash: location.hash }));
        break;
      case 'openInfoviewGraph': case 'openInfoviewGraphForLibrary':
        navigate(encodeReaderRoute({ kind: 'graph', returnHash: location.hash || '#/library' })); break;
      case 'openEntry':
        if (typeof msg.id === 'string' && byId.has(msg.id)) navigate(encodeReaderRoute({ kind: 'entry', entryId: msg.id, returnHash: location.hash }));
        break;
      case 'navigateEntry':
      case 'openEntryInfoview':
        if (typeof msg.entryId === 'string' && byId.has(msg.entryId)) {
          const origin = msg.origin as { kind?: string; nodeId?: string } | undefined;
          const returnHash = origin?.kind === 'library' && origin.nodeId ? encodeReaderRoute({ kind: 'node', nodeId: origin.nodeId }) : location.hash || '#/library';
          navigate(encodeReaderRoute({ kind: 'entry', entryId: msg.entryId, returnHash }));
        }
        break;
      case 'back': case 'nav.openDashboard': case 'nav.openInfoview':
        navigate('returnHash' in route ? route.returnHash ?? '#/library' : '#/library'); break;
      case 'selectLibrary': case 'openInfoview': navigate('#/library'); break;
      case 'revealPointer': window.dispatchEvent(new CustomEvent('snl-reader-source', { detail: { entryId: msg.entryId } })); break;
      case 'snl.preferences/set-language':
        preferences.current.language = msg.language === 'auto' ? snapshot.preferences.language : String(msg.language); publishPreferences(); break;
      case 'snl.preferences/set-reading':
      case 'snl.preferences/update':
        Object.assign(preferences.current, msg.patch ?? msg.preferences ?? {}); publishPreferences(); break;
      case 'snl.content-language/changed': break;
      case 'snl.preferences/ready': publishPreferences(); break;
      case 'snl.reader/theme': preferences.current.color_scheme = String(msg.value); publishPreferences(); break;
      default: break;
    }
  };
  // Install before child layout effects, but never mutate a global port in render.
  useInsertionEffect(() => { committed.current = handleMessage; });
  useInsertionEffect(() => {
    active.current = true;
    const release = installReaderPlatformApi(api);
    return () => { active.current = false; committed.current = null; release(); };
  }, [api]);
  useEffect(() => {
    try { Object.assign(preferences.current, JSON.parse(localStorage.getItem('snl-reader-preferences') || '{}')); } catch { /* optional */ }
    publishPreferences();
    set_content_language(snapshot.contentLanguage);
    const broker = installWorkspaceAssetBroker(api);
    const changed = (): void => { flushSync(() => { setRoute(decodeReaderRoute(location.hash)); setSearchSession(value => value + 1); }); };
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    host.__snlExportSourceFollow = changed;
    return () => { broker.dispose(); window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed); if (host.__snlExportSourceFollow === changed) delete host.__snlExportSourceFollow; };
  }, [snapshot]);
  const selected = route.kind === 'entry' ? byId.get(route.entryId) : undefined;
  const state: EntryReaderState | null = selected ? {
    entry: selected, kind: kinds.get(selected.kind) ?? null, entries, entryPackages: snapshot.entryPackages,
    relationshipSections: groupEntryRelationships(selected.id, snapshot.relationships, byId),
    relatedEntries: snapshot.entries.filter(entry => entry.id !== selected.id).map(entry => details[entry.id]),
    relationshipsError: null, returnRoute: { kind: 'library', slug: snapshot.library.slug }
  } : null;
  const markdownImageUrlTransform = (source: string): string => frozenImageUrl(snapshot.resources, source);
  const sourceAvailable = (id: string): boolean => !!host.__snlSources?.pointers.some(pointer => pointer.entryId === id);
  return <ReaderCapabilitiesContext.Provider value={{ api, edit: false, graph: true, export: false, sourceAvailable,
    sourceUnavailableReason: sourceUnavailable }}>
    <nav aria-label={t('scope')} style={{ ...READER_STYLE, paddingBottom: 0, display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
      <Button onClick={() => navigate(encodeReaderRoute({ kind: 'search', q: '', mode: 'entry', filters: {}, returnHash: location.hash || '#/library' }))}>{t('search')}</Button>
      <Button onClick={() => navigate(encodeReaderRoute({ kind: 'graph', returnHash: location.hash || '#/library' }))}>{t('graph')}</Button>
    </nav>
    <div hidden={route.kind !== 'library' && route.kind !== 'node'}>
      <HoverPopoverProvider postMessage={postMessage} entries={entries} entryPackages={snapshot.entryPackages} userMacros={userMacros}
        kindPalette={kindPalette} localDetails={details} markdownImageUrlTransform={markdownImageUrlTransform}>
        <RoutePopoverBoundary visible={route.kind === 'library' || route.kind === 'node'} />
        <main style={READER_STYLE}>
          <LibraryLayer {...snapshot.library} ctx={{ postMessage, goBack: () => navigate('#/library'), entryPool: entries,
            entryPackages: snapshot.entryPackages, userMacros, kindPalette, markdownImageUrlTransform, exportHtml: () => {}, outlineRef,
            activeNodeId: route.kind === 'node' ? route.nodeId : undefined }} />
        </main>
      </HoverPopoverProvider>
    </div>
    {route.kind === 'search' ? <SnooglApp key={searchSession} /> : null}
    {route.kind === 'graph' ? <SnlGraphApp initialAtomicDependenciesOnly localDetails={details} markdownImageUrlTransform={markdownImageUrlTransform} /> : null}
    {route.kind === 'macro' ? Object.hasOwn(snapshot.macros, route.name)
      ? <BrowserMacroReader key={route.name} snapshot={snapshot} name={route.name} />
      : <main style={READER_STYLE}><p role="alert">{t('unavailable')}</p><Button onClick={() => navigate('#/library')}>{t('home')}</Button></main> : null}
    {route.kind === 'unavailable' ? <main style={READER_STYLE}><p role="alert">{t('unavailable')}</p><Button onClick={() => navigate('#/library')}>{t('home')}</Button></main> : null}
    {route.kind === 'entry' ? <EntryReader key={route.entryId} state={state} loaded loadError={null} wireUserMacros={snapshot.macros}
      userMacros={userMacros} macroKinds={snapshot.macroKinds} kindPalette={kindPalette} localDetails={details}
      markdownImageUrlTransform={markdownImageUrlTransform} postMessage={postMessage} /> : null}
    {!host.__snlSources ? <p role="note" style={{ padding: '0 1.5rem' }}>{sourceUnavailable}</p> : null}
  </ReaderCapabilitiesContext.Provider>;
}

export function mountBrowserReader(snapshot: FrozenReaderSnapshot): void {
  if (snapshot.version !== 1) throw new Error('Unsupported frozen reader snapshot version');
  const root = document.getElementById('snl-reader-root');
  if (!root) throw new Error('Shared reader root missing');
  document.documentElement.dataset.snlAssetBaseUri = 'https://snl-workspace-assets.invalid';
  document.documentElement.dataset.snlLogoBlack = logoBlack;
  document.documentElement.dataset.snlLogoWhite = logoWhite;
  const routes = new Set(snapshot.entries.map(entry => '#/entry/' + encodeURIComponent(entry.id)));
  const walk = (nodes: FrozenOutlineNode[]): void => { for (const node of nodes) { routes.add('#/node/' + encodeURIComponent(node.nodeId)); walk(node.children); } };
  walk(snapshot.library.outline); host.__snlReaderRoutes = routes;
  flushSync(() => createRoot(root).render(<BrowserReader snapshot={snapshot} />));
}
if (host.__SNL_READER__) mountBrowserReader(host.__SNL_READER__);
