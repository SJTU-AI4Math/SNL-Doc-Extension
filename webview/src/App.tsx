// SNL Infoview: the READING surface. Two-layer drill-down per cat's
// 2026-07-07 revision:
//
//   Layer 1 (Libraries)  ← default when opened
//   Layer 2 (Library page) ← full outline of one Library, every Entry
//                            rendered inline with expand/collapse to hide
//                            subtrees. Ctrl+click on an entry title still
//                            opens a dedicated per-entry Infoview panel.
//
// Every layer has a "Edit in Dashboard" button (top-right) that jumps to
// the management surface — reader → editor handoff. Layer 2 also has a
// Back button that walks the stack up one step.

import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import React,{ useEffect,useLayoutEffect,useMemo,useRef,useState } from 'react';
import type { RelationshipData } from '../../src/snlDoc';
import { harvestLibraryHtml,waitForExportSurfaces } from './export/htmlExport';
import {
type EntryData,
type EntryKind,
type EntryOption
} from './render/EntrySurface';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import type { MacroRecord } from './render/macroData';
import {
macroKindsToPalette,
type MacroKindPaletteSource
} from './render/macroKindPalette';
import { wireMacroEntriesToRenderable,type WireMacro } from './render/macroWire';
import { resolveMarkdownAssetUrl } from './render/markdownAssets';
import {
get_content_language,
use_content_language
} from './runtime/preferencesRuntime';
import { PANEL_STYLE,useVsCodeApiRef } from './vscodeApi';

import { isCachedEntryMetrics, type CachedEntryMetrics } from '../../src/cachedEntryMetrics';
import { renderCurrentView,type OutlineNode,type View } from './reader/LibraryReader';
import { ReaderCapabilitiesContext } from './reader/ReaderCapabilities';
export { LibraryOutline,type OutlineNode } from './reader/LibraryReader';
interface LibraryEntry { slug: string; title: string; description?: string; hasMeta: boolean }
type Incoming =
  | { type: 'libraries'; libraries: LibraryEntry[] }
  | { type: 'librariesError'; message: string }
  | {
      type: 'libraryEntries';
      renderSnapshotId?: string;
      cachedEntryMetrics?: CachedEntryMetrics;
      slug: string;
      title: string;
      description?: string;
      entries: EntryOption[];
      entryRecords?: EntryData[];
      entryKinds?: EntryKind[];
      relationships?: RelationshipData[];
      entryPackages?: Record<string, string>;
      outline: OutlineNode[];
      macros?: Record<string, WireMacro>;
      macroKinds?: MacroKindPaletteSource[];
      assetBaseUri?: string;
      warnings?: string[];
    }
  | undefined;

export function App(): React.ReactElement {
  const contentLanguage = use_content_language();
  const [cachedEntryMetrics, setCachedEntryMetrics] = useState<CachedEntryMetrics | undefined>();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [wireUserMacros, setWireUserMacros] = useState<Record<string, WireMacro> | undefined>(undefined);
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);
  const [entryPackages, setEntryPackages] = useState<Record<string, string>>({});
  const [assetBaseUri, setAssetBaseUri] = useState('');
  const apiRef = useVsCodeApiRef();

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'libraries':
          cancelExport();
          setView({
            kind: 'libraries',
            libraries: Array.isArray(msg.libraries) ? msg.libraries : []
          });
          break;
        case 'librariesError':
          cancelExport();
          setView((current) => ({
            kind: 'librariesError',
            message: msg.message || '',
            previous:
              current.kind === 'libraries'
                ? current.libraries
                : current.kind === 'librariesError'
                  ? current.previous
                  : null
          }));
          break;
        case 'libraryEntries':
          setCachedEntryMetrics(isCachedEntryMetrics(msg.cachedEntryMetrics) ? msg.cachedEntryMetrics : undefined);
          renderSnapshotRef.current = msg.renderSnapshotId;
          cancelExport();
          if (msg.macros && typeof msg.macros === 'object') {
            setWireUserMacros(msg.macros);
          }
          setKindPalette(macroKindsToPalette(msg.macroKinds));
          setAssetBaseUri(typeof msg.assetBaseUri === 'string' ? msg.assetBaseUri : '');
          if (Array.isArray(msg.entries)) {
            setEntryPool(msg.entries);
          }
          setEntryPackages(msg.entryPackages && typeof msg.entryPackages === 'object'
            ? msg.entryPackages
            : {});
          setView({
            kind: 'library',
            slug: msg.slug,
            title: msg.title,
            description: msg.description,
            outline: Array.isArray(msg.outline) ? msg.outline : [],
            warnings: Array.isArray(msg.warnings) ? msg.warnings : []
          });
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const userMacros: MacroRecord | undefined = useMemo(
    () => wireUserMacros
      ? wireMacroEntriesToRenderable(Object.entries(wireUserMacros), contentLanguage)
      : undefined,
    [contentLanguage, wireUserMacros]
  );

  const outlineRef = useRef<HTMLDivElement | null>(null);
  const renderSnapshotRef = useRef<string | undefined>(undefined);

  const postMessage = (message: unknown): void => {
    apiRef.current?.postMessage(message);
  };

  const exportGenerationRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const cancelExport = React.useCallback((): void => {
    exportGenerationRef.current++;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
  }, []);
  // Retire the producer at commit/unmount, including same-slug refreshes and
  // locale changes. Host context messages and Back also cancel synchronously.
  useLayoutEffect(() => cancelExport, [cancelExport, view, contentLanguage, userMacros, assetBaseUri]);

  /**
   * Export the Library the reader is currently looking at.
   *
   * Harvest the shared reader only after its newly mounted Entry/SNL/SVG
   * surfaces settle. The options panel selects static/interactive later, so
   * both paths get one complete static fallback; interactive raw snapshot
   * ownership remains with the host. No locale projection or parallel DOM.
   *
   * Callers must expand the outline first: collapse is rendered by *omitting*
   * the subtree, so a collapsed branch is absent from the DOM and would be
   * silently dropped from the export.
   */
  const exportHtml = async (slug: string, title: string, entryCount: number): Promise<void> => {
    cancelExport();
    const generation = exportGenerationRef.current;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    const root = outlineRef.current;
    const renderSnapshotId = renderSnapshotRef.current;
    const locale = get_content_language();
    const isCurrent = (): boolean => !controller.signal.aborted &&
      generation === exportGenerationRef.current && root === outlineRef.current &&
      renderSnapshotId === renderSnapshotRef.current && locale === get_content_language();
    try {
      if (root) await waitForExportSurfaces(root, { signal: controller.signal });
      if (!isCurrent()) return;
      if ((root?.querySelectorAll('[data-snl-route-id]').length ?? 0) !== entryCount) {
        throw new Error('The outline changed during HTML capture. Please retry the export.');
      }
      const harvested = root ? harvestLibraryHtml(root, assetBaseUri, userMacros) : { html: '', assets: [] };
      postMessage({ type: 'exportLibraryHtml', renderSnapshotId,
        locale, slug, title, body: harvested.html, assets: harvested.assets });
    } catch (error) {
      if (isCurrent()) postMessage({ type: 'exportLibraryHtmlError',
        error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
    }
  };
  const markdownImageUrlTransform = React.useMemo(
    () => assetBaseUri
      ? (source: string) => resolveMarkdownAssetUrl(source, assetBaseUri)
      : undefined,
    [assetBaseUri]
  );

  const goBack = (): void => {
    cancelExport();
    if (view.kind === 'library') {
      // `ready` preserves a host-seeded Library slug so direct navigation can
      // survive the first handshake. Back is an explicit state transition:
      // clear that slug on the host and request the Libraries root.
      postMessage({ type: 'back' });
    }
  };

  return (
    <ReaderCapabilitiesContext.Provider value={{ api: apiRef.current, edit: true, graph: true, export: true }}>
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={entryPool}
      entryPackages={entryPackages}
      userMacros={userMacros}
      kindPalette={kindPalette}
      markdownImageUrlTransform={markdownImageUrlTransform}
    >
      <main style={PANEL_STYLE}>
        {renderCurrentView(view, {
          postMessage,
          cachedEntryMetrics,
          goBack,
          entryPool,
          entryPackages,
          userMacros,
          kindPalette,
          markdownImageUrlTransform,
          exportHtml,
          outlineRef
        })}
      </main>
    </HoverPopoverProvider>
    </ReaderCapabilitiesContext.Provider>
  );
}
