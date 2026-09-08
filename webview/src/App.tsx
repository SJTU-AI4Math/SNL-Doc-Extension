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
import React,{ useEffect,useMemo,useRef,useState } from 'react';
import type { RelationshipData } from '../../src/snlDoc';
import { harvestLibraryHtml } from './export/htmlExport';
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
          setView({
            kind: 'libraries',
            libraries: Array.isArray(msg.libraries) ? msg.libraries : []
          });
          break;
        case 'librariesError':
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
          renderSnapshotRef.current = msg.renderSnapshotId;
          exportGenerationRef.current++;
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

  /**
   * Export the Library the reader is currently looking at.
   *
   * We harvest the live DOM instead of re-rendering: by this point every Entry
   * has settled (SNL context resolved, KaTeX painted), so the snapshot is
   * exactly what the reader sees. A fresh render would have to redo that
   * asynchronous work and could not be captured synchronously anyway —
   * `renderToStaticMarkup` cannot render this tree at all, because the hover
   * popover layer mounts a portal.
   *
   * Callers must expand the outline first: collapse is rendered by *omitting*
   * the subtree, so a collapsed branch is absent from the DOM and would be
   * silently dropped from the export.
   */
  const exportHtml = (slug: string, title: string, _entryCount: number): void => {
    // Interactive exports freeze raw host data; they never wait for DOM/SVG capture.
    const harvested = outlineRef.current ? harvestLibraryHtml(outlineRef.current, assetBaseUri, userMacros) : { html: '', assets: [] };
    postMessage({ type: 'exportLibraryHtml', renderSnapshotId: renderSnapshotRef.current,
      locale: get_content_language(), slug, title, body: harvested.html, assets: harvested.assets });
  };
  const markdownImageUrlTransform = React.useMemo(
    () => assetBaseUri
      ? (source: string) => resolveMarkdownAssetUrl(source, assetBaseUri)
      : undefined,
    [assetBaseUri]
  );

  const goBack = (): void => {
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

