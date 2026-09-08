import React, { useEffect, useInsertionEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
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
function RoutePopoverBoundary({ visible }: { visible: boolean }): null {
  const popovers = useHoverPopovers();
  useEffect(() => { if (!visible) popovers.dismissAll(); }, [visible, popovers.dismissAll]);
  return null;
}

/** Browser-only adapter. All reading, hover, relationships and controls below
 * are the same components mounted by the Extension panels. */
export function BrowserReader({ snapshot }: { snapshot: FrozenReaderSnapshot }): React.ReactElement {
  const [route, setRoute] = useState(() => decodeReaderRoute(location.hash));
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
    flushSync(() => setRoute(decodeReaderRoute(hash)));
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
    switch (msg.type) {
      case 'navigateEntry':
      case 'openEntryInfoview':
        if (typeof msg.entryId === 'string' && byId.has(msg.entryId)) {
          const origin = msg.origin as { kind?: string; nodeId?: string } | undefined;
          const returnHash = origin?.kind === 'library' && origin.nodeId ? encodeReaderRoute({ kind: 'node', nodeId: origin.nodeId }) : location.hash || '#/library';
          navigate(encodeReaderRoute({ kind: 'entry', entryId: msg.entryId, returnHash }));
        }
        break;
      case 'back': navigate(route.kind === 'entry' ? route.returnHash ?? '#/library' : '#/library'); break;
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
    const changed = (): void => { flushSync(() => setRoute(decodeReaderRoute(location.hash))); };
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
  return <ReaderCapabilitiesContext.Provider value={{ api, edit: false, graph: false, export: false, sourceAvailable,
    sourceUnavailableReason: sourceUnavailable }}>
    <div hidden={route.kind === 'entry'}>
      <HoverPopoverProvider postMessage={postMessage} entries={entries} entryPackages={snapshot.entryPackages} userMacros={userMacros}
        kindPalette={kindPalette} localDetails={details} markdownImageUrlTransform={markdownImageUrlTransform}>
        <RoutePopoverBoundary visible={route.kind !== 'entry'} />
        <main style={READER_STYLE}>
          <LibraryLayer {...snapshot.library} ctx={{ postMessage, goBack: () => navigate('#/library'), entryPool: entries,
            entryPackages: snapshot.entryPackages, userMacros, kindPalette, markdownImageUrlTransform, exportHtml: () => {}, outlineRef,
            activeNodeId: route.kind === 'node' ? route.nodeId : undefined }} />
        </main>
      </HoverPopoverProvider>
    </div>
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
