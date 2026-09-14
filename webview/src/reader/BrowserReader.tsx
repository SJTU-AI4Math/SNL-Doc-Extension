import React, { useEffect, useInsertionEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SnooglApp } from '../SnooglApp';
import { SnlGraphApp } from '../SnlGraphApp';
import { BrowserMacroReader } from './BrowserMacroReader';
import { frozenRelationshipGraph, frozenSearchResults } from './browserDiscovery';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';
import { IconButton } from '../components/IconButton';
import { PanelHeader, type PanelHeaderHost } from '../components/PanelHeader';
import { LibraryLayer } from './LibraryReader';
import { EntryReader, type EntryReaderState } from './EntryReader';
import { ReaderCapabilitiesContext, READER_STYLE } from './ReaderCapabilities';
import { HoverPopoverProvider, useHoverPopovers } from '../render/HoverPopoverProvider';
import { use_localized } from '../runtime/useLocalized';
import { wireMacroEntriesToRenderable } from '../render/macroWire';
import { macroKindsToPalette } from '../render/macroKindPalette';
import { set_content_language, use_content_language } from '../runtime/preferencesRuntime';
import { installWorkspaceAssetBroker } from '../runtime/workspaceAssetBroker';
import { groupEntryRelationships } from '../../../src/entryInfoviewRelationships';
import type { FrozenReaderSnapshot, FrozenOutlineNode } from '../../../src/sharedReaderSnapshot';
import { decodeReaderRoute, encodeReaderRoute, readerRouteInLibrary, frozenAssetReply, frozenImageUrl } from './browserPlatform';
import { navigateReaderHash, notifyReaderLocation, useReaderLocation } from './readerHistory';
import { createBrowserPreferences } from './browserPreferences';
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
  readonly: 'Read-only', search: 'SNoogL', graph: 'Relationship graph', scope: 'Scope: this frozen export only.',
  unavailable: 'This destination is unavailable in this frozen export.', home: 'Library', back: 'Back',
  macroPreview: 'Read-only Macro preview', sourceEntries: 'Source Entries', sourceMissing: 'Not included in this export'
}, {
  readonly: '只读', search: 'SNoogL', graph: '关系图', scope: '范围：仅本次冻结导出。',
  unavailable: '此目的地在本次冻结导出中不可用。', home: '文档库', back: '返回',
  macroPreview: '宏只读预览', sourceEntries: '来源条目', sourceMissing: '未包含在本次导出中'
});
function RoutePopoverBoundary({ visible }: { visible: boolean }): null {
  const popovers = useHoverPopovers();
  useEffect(() => { if (!visible) popovers.dismissAll(); }, [visible, popovers.dismissAll]);
  return null;
}

/** Browser-only adapter. All reading, hover, relationships and controls below
 * are the same components mounted by the Extension panels. */
export interface BrowserReaderHostContext {
  librarySlug: string;
  scope: string;
  sourceUnavailableReason: string;
  unavailable: string;
  missingEntry: string;
  graphEmpty: string;
  workspaceLabel: string;
  onWorkspace(): void;
  onRefresh?(): void;
}

export function BrowserReader({ snapshot, hostContext }: { snapshot: FrozenReaderSnapshot; hostContext?: BrowserReaderHostContext }): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const { route: currentRoute, session: searchSession } = useReaderLocation();
  const librarySlug = hostContext?.librarySlug ?? (currentRoute.kind === 'workspace' ? undefined : currentRoute.librarySlug);
  const route = readerRouteInLibrary(currentRoute, librarySlug);
  const routeHash = (destination: import('./readerRoute').ReaderRoute): string => encodeReaderRoute(readerRouteInLibrary(destination, librarySlug));
  const libraryHash = routeHash({ kind: 'library' });
  const contentLanguage = use_content_language();
  const frozenSourceUnavailable = use_localized({type:'i18n',default_language:'en',values:{en:'Source is not included in this frozen export.','zh-CN':'此冻结导出未包含源码。'}});
  const sourceUnavailable = hostContext?.sourceUnavailableReason ?? frozenSourceUnavailable;
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
  const preferences = useMemo(() => createBrowserPreferences(snapshot.preferences, snapshot.renderSnapshotId, snapshot.languages), [snapshot]);
  const navigate = (hash: string, passive = false): void => {
    navigateReaderHash(hostContext ? routeHash(decodeReaderRoute(hash)) : hash, passive);
  };
  const handleMessage = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    if (preferences.handle(msg)) return;
    const asset = frozenAssetReply(snapshot.resources, msg);
    if (asset) { queueMicrotask(() => { if (active.current) window.dispatchEvent(new MessageEvent('message', { data: asset })); }); return; }
    const reply = (data: unknown): void => { queueMicrotask(() => { if (active.current) window.dispatchEvent(new MessageEvent('message', { data })); }); };
    switch (msg.type) {
      case 'nav.refresh': hostContext?.onRefresh?.(); break;
      case 'ready':
        if (route.kind === 'search') reply(frozenSearchResults(snapshot, route));
        if (route.kind === 'graph') reply(frozenRelationshipGraph(snapshot));
        break;
      case 'query':
        if (route.kind === 'search' && typeof msg.q === 'string' && (msg.mode === 'entry' || msg.mode === 'macro')) {
          const filters = msg.filters as { kindId?: string; counterpartId?: string } | undefined;
          const query: import('./browserDiscovery').FrozenSearchQuery = { q: msg.q, mode: msg.mode, filters: filters ?? {} };
          // Query changes replace the current search destination, never add caret/keystroke history.
          history.replaceState(history.state, '', routeHash({ ...route, ...query }));
          reply(frozenSearchResults(snapshot, query));
        }
        break;
      case 'openMacro':
        if (typeof msg.name === 'string' && Object.hasOwn(snapshot.macros, msg.name)) navigate(routeHash({ kind: 'macro', name: msg.name, returnHash: location.hash }));
        break;
      case 'openInfoviewGraph': case 'openInfoviewGraphForLibrary':
        navigate(routeHash({ kind: 'graph', returnHash: location.hash || libraryHash })); break;
      case 'openEntry':
        if (typeof msg.id === 'string' && byId.has(msg.id)) navigate(routeHash({ kind: 'entry', entryId: msg.id, returnHash: location.hash }));
        break;
      case 'navigateEntry':
      case 'openEntryInfoview':
        if (typeof msg.entryId === 'string' && byId.has(msg.entryId)) {
          const origin = msg.origin as { kind?: string; nodeId?: string } | undefined;
          const returnHash = origin?.kind === 'library' && origin.nodeId ? routeHash({ kind: 'node', nodeId: origin.nodeId }) : location.hash || libraryHash;
          navigate(routeHash({ kind: 'entry', entryId: msg.entryId, returnHash }));
        }
        break;
      case 'back': case 'nav.openDashboard': case 'nav.openInfoview':
        navigate('returnHash' in route ? route.returnHash ?? libraryHash : libraryHash); break;
      case 'selectLibrary': case 'openInfoview': navigate(libraryHash); break;
      case 'revealPointer': window.dispatchEvent(new CustomEvent('snl-reader-source', { detail: { entryId: msg.entryId } })); break;
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
    preferences.load();
    set_content_language(snapshot.contentLanguage);
    const broker = installWorkspaceAssetBroker(api);
    const changed = (): void => { flushSync(notifyReaderLocation); };
    host.__snlExportSourceFollow = changed;
    return () => { broker.dispose(); if (host.__snlExportSourceFollow === changed) delete host.__snlExportSourceFollow; };
  }, [snapshot]);
  const selected = route.kind === 'entry' ? byId.get(route.entryId) : undefined;
  const state: EntryReaderState | null = selected ? {
    entry: selected, kind: kinds.get(selected.kind) ?? null, entries, entryPackages: snapshot.entryPackages,
    relationshipSections: groupEntryRelationships(selected.id, snapshot.relationships, byId),
    relatedEntries: snapshot.entries.filter(entry => entry.id !== selected.id).map(entry => details[entry.id]),
    relationshipsError: null, returnRoute: { kind: 'library', slug: snapshot.library.slug }
  } : null;
  const markdownImageUrlTransform = (source: string): string => frozenImageUrl(snapshot.resources, source);
  const sourceAvailable = (id: string): boolean => !hostContext && !!host.__snlSources?.pointers.some(pointer => pointer.entryId === id);
  const isLibrary = route.kind === 'library' || route.kind === 'node';
  const panelHeader: PanelHeaderHost = {
    showRefresh: !!hostContext?.onRefresh,
    status: t('readonly'), statusTitle: hostContext?.scope ?? t('scope'),
    back: isLibrary
      ? hostContext ? { label: hostContext.workspaceLabel, onClick: hostContext.onWorkspace }
        : route.kind === 'node' ? { label: t('back'), onClick: () => navigate(libraryHash) } : undefined
      : { label: t('back'), onClick: () => handleMessage({ type: 'back' }) },
    actions: <>
      {hostContext && !isLibrary ? <IconButton icon="book" label={hostContext.workspaceLabel} variant="secondary" size="md" onClick={hostContext.onWorkspace} /> : null}
      <IconButton icon="search" label={t('search')} variant="secondary" size="md" onClick={() => navigate(routeHash({ kind: 'search', q: '', mode: 'entry', filters: {}, returnHash: location.hash || libraryHash }))} />
      <IconButton icon="graph" label={t('graph')} variant="secondary" size="md" onClick={() => navigate(routeHash({ kind: 'graph', returnHash: location.hash || libraryHash }))} />
    </>
  };
  const unavailable = <main style={READER_STYLE}>
    <PanelHeader vsApi={api} host={panelHeader} title={t('home')} />
    <p role="alert">{hostContext?.unavailable ?? t('unavailable')}</p>
  </main>;
  return <ReaderCapabilitiesContext.Provider value={{ api, edit: false, graph: true, export: false, sourceAvailable, panelHeader,
    sourceUnavailableReason: sourceUnavailable, scopeDescription: hostContext?.scope,
    graphEmptyDescription: hostContext?.graphEmpty, missingEntryDescription: hostContext?.missingEntry }}>
    <div hidden={route.kind !== 'library' && route.kind !== 'node'}>
      <HoverPopoverProvider postMessage={postMessage} entries={entries} entryPackages={snapshot.entryPackages} userMacros={userMacros}
        kindPalette={kindPalette} localDetails={details} markdownImageUrlTransform={markdownImageUrlTransform}>
        <RoutePopoverBoundary visible={route.kind === 'library' || route.kind === 'node'} />
        <main style={READER_STYLE}>
          <LibraryLayer {...snapshot.library} ctx={{ postMessage, goBack: hostContext?.onWorkspace ?? (() => navigate(libraryHash)), entryPool: entries,
            entryPackages: snapshot.entryPackages, userMacros, kindPalette, markdownImageUrlTransform, exportHtml: () => {}, outlineRef,
            activeNodeId: route.kind === 'node' ? route.nodeId : undefined }} />
        </main>
      </HoverPopoverProvider>
    </div>
    {route.kind === 'search' ? <SnooglApp key={searchSession} /> : null}
    {route.kind === 'graph' ? <SnlGraphApp initialAtomicDependenciesOnly localDetails={details} markdownImageUrlTransform={markdownImageUrlTransform} /> : null}
    {route.kind === 'macro' ? Object.hasOwn(snapshot.macros, route.name)
      ? <BrowserMacroReader key={route.name} snapshot={snapshot} name={route.name} />
      : unavailable : null}
    {route.kind === 'unavailable' ? unavailable : null}
    {route.kind === 'entry' ? <EntryReader key={route.entryId} state={state} loaded loadError={null} wireUserMacros={snapshot.macros}
      userMacros={userMacros} macroKinds={snapshot.macroKinds} kindPalette={kindPalette} localDetails={details}
      markdownImageUrlTransform={markdownImageUrlTransform} postMessage={postMessage} /> : null}
    {hostContext || !host.__snlSources ? <p role="note" style={{ padding: '0 1.5rem' }}>{sourceUnavailable}</p> : null}
  </ReaderCapabilitiesContext.Provider>;
}

export function initializeBrowserReaderDocument(): void {
  document.documentElement.dataset.snlAssetBaseUri = 'https://snl-workspace-assets.invalid';
  document.documentElement.dataset.snlLogoBlack = logoBlack;
  document.documentElement.dataset.snlLogoWhite = logoWhite;
}

export function mountBrowserReader(snapshot: FrozenReaderSnapshot): void {
  if (snapshot.version !== 1) throw new Error('Unsupported frozen reader snapshot version');
  const root = document.getElementById('snl-reader-root');
  if (!root) throw new Error('Shared reader root missing');
  initializeBrowserReaderDocument();
  const routes = new Set(snapshot.entries.map(entry => '#/entry/' + encodeURIComponent(entry.id)));
  const walk = (nodes: FrozenOutlineNode[]): void => { for (const node of nodes) { routes.add('#/node/' + encodeURIComponent(node.nodeId)); walk(node.children); } };
  walk(snapshot.library.outline); host.__snlReaderRoutes = routes;
  flushSync(() => createRoot(root).render(<BrowserReader snapshot={snapshot} />));
}
if (host.__SNL_READER__) mountBrowserReader(host.__SNL_READER__);
