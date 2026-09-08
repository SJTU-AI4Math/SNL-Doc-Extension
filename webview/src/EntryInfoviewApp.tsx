// Per-entry SNL Infoview surface. Unlike App.tsx (the picker), this webview
// renders exactly one Entry — the host sends its details (plus the full entry
// pool for macro-source resolution) after we announce readiness.

import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import React,{ useEffect,useMemo,useState } from 'react';
import type {
EntryRelationshipSection,
EntryReturnRoute
} from '../../src/entryInfoviewRelationships';
import { isThemedKindColoring } from '../../src/kindColoring';
import { is_valid_i18n_string } from '../../src/localizedContent';
import type { MacroKind,MacroPackageEntry } from './PackagePanelApp';
import {
isEntryKindPayload,
type EntryData,
type EntryKind,
type EntryOption
} from './render/EntrySurface';
import type { MacroRecord } from './render/macroData';
import {
macroKindsToPalette,
type MacroKindPaletteSource
} from './render/macroKindPalette';
import { wireMacroEntriesToRenderable } from './render/macroWire';
import { resolveMarkdownAssetUrl } from './render/markdownAssets';
import { use_content_language } from './runtime/preferencesRuntime';
import { useVsCodeApiRef } from './vscodeApi';

import { EntryReader } from './reader/EntryReader';

/** One row in the Context / Dependencies collapsible lists (cat 2026-07-10 §2). */
type Incoming =
  | {
      type: 'entryDetails';
      entry: EntryData | null;
      kind: EntryKind | null;
      entries: EntryOption[];
      entryPackages?: Record<string, string>;
      macros?: Record<string, MacroPackageEntry>;
      macroKinds?: MacroKind[];
      relationshipSections?: EntryRelationshipSection[] | null;
      relatedEntries?: Array<{ entry: EntryData; kind: EntryKind | null }> | null;
      relationshipsError?: string;
      returnRoute?: EntryReturnRoute;
      assetBaseUri?: string;
    }
  | { type: 'entryDetailsError'; entryId: string; message: string }
  | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
const isEntryData = (value: unknown): value is EntryData =>
  isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string' &&
  (typeof value.title === 'string' || is_valid_i18n_string(value.title)) &&
  isRecord(value.content);
const isEntryOption = (value: unknown): value is EntryOption =>
  isRecord(value) && typeof value.id === 'string' &&
  (typeof value.title === 'string' || is_valid_i18n_string(value.title)) &&
  typeof value.hasContent === 'boolean' &&
  (value.package === undefined || typeof value.package === 'string') &&
  (value.snl === undefined || typeof value.snl === 'string');

const isMacroKindPaletteSource = (value: unknown): value is MacroKindPaletteSource =>
  isRecord(value) && typeof value.id === 'string' && isThemedKindColoring(value.coloring);
const isRelationshipSection = (value: unknown): value is EntryRelationshipSection =>
  isRecord(value) && typeof value.label === 'string' &&
  (value.direction === 'incoming' || value.direction === 'outgoing') &&
  Array.isArray(value.rows) && value.rows.every((row) =>
    isRecord(row) && typeof row.id === 'string' &&
    (typeof row.title === 'string' || is_valid_i18n_string(row.title)) &&
    typeof row.relationshipId === 'string' &&
    (row.kindId === undefined || typeof row.kindId === 'string') &&
    (row.package === undefined || typeof row.package === 'string'));
const isRelatedEntryDetails = (value: unknown): value is {
  entry: EntryData;
  kind: EntryKind | null;
} => isRecord(value) && isEntryData(value.entry) &&
  (value.kind === null || isEntryKindPayload(value.kind));
const isReturnRoute = (value: unknown): value is EntryReturnRoute => {
  if (!isRecord(value)) return false;
  if (value.kind === 'root') return true;
  if (value.kind === 'library') return typeof value.slug === 'string' &&
    (value.title === undefined || typeof value.title === 'string');
  if (value.kind === 'entry') return typeof value.entryId === 'string' &&
    (value.entryPackage === undefined || typeof value.entryPackage === 'string');
  return value.kind === 'chooseLibrary' && Array.isArray(value.libraries) &&
    value.libraries.every((library) => isRecord(library) &&
      typeof library.slug === 'string' && typeof library.title === 'string');
};
const isEntryDetails = (value: unknown): value is Exclude<Incoming, undefined | {
  type: 'entryDetailsError'; entryId: string; message: string;
}> => isRecord(value) && value.type === 'entryDetails' &&
  (value.entry === null || isEntryData(value.entry)) &&
  (value.kind === null || isEntryKindPayload(value.kind)) && Array.isArray(value.entries) &&
  value.entries.every(isEntryOption) &&
  (value.entryPackages === undefined || isStringRecord(value.entryPackages)) &&
  (value.macros === undefined || isRecord(value.macros)) &&
  (value.macroKinds === undefined ||
    (Array.isArray(value.macroKinds) && value.macroKinds.every(isMacroKindPaletteSource))) &&
  (value.relationshipSections === undefined || value.relationshipSections === null ||
    (Array.isArray(value.relationshipSections) &&
      value.relationshipSections.every(isRelationshipSection))) &&
  (value.relatedEntries === undefined || value.relatedEntries === null ||
    (Array.isArray(value.relatedEntries) && value.relatedEntries.every(isRelatedEntryDetails))) &&
  (value.relationshipsError === undefined || typeof value.relationshipsError === 'string') &&
  (value.returnRoute === undefined || isReturnRoute(value.returnRoute)) &&
  (value.assetBaseUri === undefined || typeof value.assetBaseUri === 'string');

export function EntryInfoviewApp(): React.ReactElement {
  const contentLanguage = use_content_language();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<{
    entry: EntryData;
    kind: EntryKind | null;
    entries: EntryOption[];
    entryPackages: Record<string, string>;
    relationshipSections: EntryRelationshipSection[] | null;
    relatedEntries: Array<{ entry: EntryData; kind: EntryKind | null }>;
    relationshipsError: string | null;
    returnRoute: EntryReturnRoute;
  } | null>(null);
  const [wireUserMacros, setWireUserMacros] = useState<Record<string, MacroPackageEntry> | undefined>(undefined);
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);
  const [assetBaseUri, setAssetBaseUri] = useState('');
  const apiRef = useVsCodeApiRef();

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const incoming: unknown = event.data;
      if (isRecord(incoming) && incoming.type === 'entryDetailsError' &&
          typeof incoming.entryId === 'string' && typeof incoming.message === 'string') {
        setLoaded(true);
        setState(null);
        setLoadError(incoming.message);
        return;
      }
      if (isEntryDetails(incoming)) {
        const msg = incoming;
        setLoaded(true);
        setLoadError(null);
        if (msg.macros && typeof msg.macros === 'object') {
          setWireUserMacros(msg.macros);
        }
        setKindPalette(macroKindsToPalette(msg.macroKinds));
        setMacroKinds(Array.isArray(msg.macroKinds) ? msg.macroKinds : []);
        setAssetBaseUri(typeof msg.assetBaseUri === 'string' ? msg.assetBaseUri : '');
        if (!msg.entry) {
          setState(null);
          return;
        }
        setState({
          entry: msg.entry,
          kind: msg.kind,
          entries: Array.isArray(msg.entries) ? msg.entries : [],
          entryPackages: msg.entryPackages && typeof msg.entryPackages === 'object'
            ? msg.entryPackages
            : {},
          relationshipSections: Array.isArray(msg.relationshipSections)
            ? msg.relationshipSections
            : null,
          relatedEntries: Array.isArray(msg.relatedEntries) ? msg.relatedEntries : [],
          relationshipsError: typeof msg.relationshipsError === 'string'
            ? msg.relationshipsError
            : null,
          returnRoute: msg.returnRoute ?? { kind: 'root' }
        });
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

  const postMessage = (message: unknown): void => {
    apiRef.current?.postMessage(message);
  };
  const markdownImageUrlTransform = React.useMemo(
    () => assetBaseUri
      ? (source: string) => resolveMarkdownAssetUrl(source, assetBaseUri)
      : undefined,
    [assetBaseUri]
  );

  return <EntryReader state={state} loaded={loaded} loadError={loadError}
    wireUserMacros={wireUserMacros} userMacros={userMacros} kindPalette={kindPalette}
    macroKinds={macroKinds} markdownImageUrlTransform={markdownImageUrlTransform}
    postMessage={postMessage} />;
}
