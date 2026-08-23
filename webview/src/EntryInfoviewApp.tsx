// Per-entry SNL Infoview surface. Unlike App.tsx (the picker), this webview
// renders exactly one Entry — the host sends its details (plus the full entry
// pool for macro-source resolution) after we announce readiness.

import React, { useEffect, useMemo, useState } from 'react';
import { useVsCodeApiRef, PANEL_STYLE } from './vscodeApi';
import {
  EntrySurface,
  isEntryKindPayload,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './render/EntrySurface';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import type { MacroRecord } from './render/macroData';
import { wireMacroEntriesToRenderable } from './render/macroWire';
import {
  macroKindsToPalette,
  type MacroKindPaletteSource
} from './render/macroKindPalette';
import { Disclosure } from './components/Disclosure';
import { Button } from './components/Button';
import { PanelHeader } from './components/PanelHeader';
import { EntryMacroSection } from './components/EntryMacroSection';
import type { MacroKind, MacroPackageEntry } from './PackagePanelApp';
import { resolveMarkdownAssetUrl } from './render/markdownAssets';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import type {
  EntryRelationshipSection,
  EntryReturnRoute
} from '../../src/entryInfoviewRelationships';
import { is_valid_i18n_string, resolve_localized_string } from '../../src/localizedContent';
import { isThemedKindColoring } from '../../src/kindColoring';
import { use_content_language } from './runtime/preferencesRuntime';

const MESSAGES = defineUiMessages('entryInfoview', {
  title: 'Entry Infoview', edit: '✎ Edit', editTitle: 'Open this entry in the Edit Entry panel',
  loading: 'Loading entry…', notFound: 'Entry not found in this workspace.',
  loadError: 'Could not load entry data: {message}',
  back: 'Back', relationships: 'Relationships', incoming: 'Incoming', outgoing: 'Outgoing',
  dependsLabel: 'Dependencies', usesContextLabel: 'Context',
  relationshipsEmpty: 'No relationships involve this Entry.',
  relationshipsUnavailable: 'Relationships unavailable: {message}', retryRelationships: 'Retry relationships',
  chooseLibrary: 'Choose a Library to return to', chooseLibraryPlaceholder: 'Select a Library…',
  openEntry: 'Open Infoview for {title} ({id})', untitled: '(untitled)',
  atomic: 'atomic', composite: 'composite',
  atomicTitle: 'Atomic dependency — no shorter compose path in the pool.',
  compositeTitle: 'Composite dependency — this edge is redundant with a chain of others.'
}, {
  title: '条目信息视图', edit: '✎ 编辑', editTitle: '在“编辑条目”面板中打开此条目',
  loading: '正在加载条目……', notFound: '在此工作区中找不到该条目。',
  loadError: '无法加载条目数据：{message}',
  back: '返回', relationships: '关系', incoming: '传入', outgoing: '传出',
  dependsLabel: '依赖项', usesContextLabel: '上下文',
  relationshipsEmpty: '没有涉及此条目的关系。',
  relationshipsUnavailable: '关系不可用：{message}', retryRelationships: '重试关系',
  chooseLibrary: '选择返回的文档库', chooseLibraryPlaceholder: '选择文档库……',
  openEntry: '打开 {title}（{id}）的信息视图', untitled: '（无标题）', atomic: '原子', composite: '组合',
  atomicTitle: '原子依赖项——条目池中不存在更短的组合路径。',
  compositeTitle: '组合依赖项——此边与其他边组成的链重复。'
});

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
  const t = useUiMessages(MESSAGES);
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

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={state?.entries ?? []}
      entryPackages={state?.entryPackages ?? {}}
      userMacros={userMacros}
      kindPalette={kindPalette}
      markdownImageUrlTransform={markdownImageUrlTransform}
    >
      <main style={{ ...PANEL_STYLE, position: 'relative' }}>
        <PanelHeader
          vsApi={apiRef.current}
          title={state
            ? resolve_localized_string(state.entry.title, contentLanguage) || t('title')
            : t('title')}
          subtitle={state?.entry.id}
          showRefresh={false}
          back={state ? {
            label: t('back'),
            onClick: () => postMessage({ type: 'back' })
          } : undefined}
          edit={state ? {
            label: t('edit'),
            title: t('editTitle'),
            onClick: () => postMessage({ type: 'editEntry', entryId: state.entry.id })
          } : undefined}
        />
        {!loaded ? (
          <p style={{ opacity: 0.8 }}>{t('loading')}</p>
        ) : loadError ? (
          <p role="alert" style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>
            {t('loadError', { message: loadError })}
          </p>        ) : !state ? (
          <p style={{ opacity: 0.8 }}>{t('notFound')}</p>
        ) : (
          <>

            <EntrySurface
              entry={state.entry}
              kind={state.kind}
              entries={state.entries}
              postMessage={postMessage}
              userMacros={userMacros}
              kindPalette={kindPalette}
              markdownImageUrlTransform={markdownImageUrlTransform}
              counterLabel={undefined}
              disableTitleJump={true}
            />
            <EntryMacroSection
              snl={state.entry.content?.snl ?? ''}
              macros={wireUserMacros ?? {}}
              macroKinds={macroKinds}
              entryPoolIds={new Set(state.entries.map((entry) => entry.id))}
              postMessage={postMessage}
            />
            <RelationshipsRegion
              entryId={state.entry.id}
              sections={state.relationshipSections}
              relatedEntries={state.relatedEntries}
              entries={state.entries}
              userMacros={userMacros}
              kindPalette={kindPalette}
              markdownImageUrlTransform={markdownImageUrlTransform}
              error={state.relationshipsError}
              postMessage={postMessage}
            />
            {state.returnRoute.kind === 'chooseLibrary' ? (
              <label style={{ display: 'block', marginTop: '1rem' }}>
                {t('chooseLibrary')}
                <select
                  aria-label={t('chooseLibrary')}
                  defaultValue=""
                  onChange={(event) => {
                    if (event.target.value) postMessage({ type: 'returnToLibrary', slug: event.target.value });
                  }}
                >
                  <option value="" disabled>{t('chooseLibraryPlaceholder')}</option>
                  {state.returnRoute.libraries.map((library) => (
                    <option key={library.slug} value={library.slug}>{library.title}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        )}
      </main>
    </HoverPopoverProvider>
  );
}

/**
 * Collapsible groups of related Entries. Each relationship renders the
 * counterpart through the canonical Entry surface; Ctrl/Cmd-clicking that
 * Entry title navigates within the current Infoview stack.
 */
function RelationshipsRegion({
  entryId,
  sections,
  relatedEntries,
  entries,
  userMacros,
  kindPalette,
  markdownImageUrlTransform,
  error,
  postMessage
}: {
  entryId: string;
  sections: EntryRelationshipSection[] | null;
  relatedEntries: Array<{ entry: EntryData; kind: EntryKind | null }>;
  entries: EntryOption[];
  userMacros: MacroRecord | undefined;
  kindPalette: KindPalette | undefined;
  markdownImageUrlTransform: ((source: string) => string) | undefined;
  error: string | null;
  postMessage: (m: unknown) => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const relatedById = useMemo(
    () => new Map(relatedEntries.map((item) => [item.entry.id, item])),
    [relatedEntries]
  );
  const sectionLabel = (label: string): string =>
    label === 'depends'
      ? t('dependsLabel')
      : label === 'uses_context'
        ? t('usesContextLabel')
        : label;
  if (error) {
    return (
      <section style={{ marginTop: '1.25rem' }}>
        <h2>{t('relationships')}</h2>
        <p role="alert">{t('relationshipsUnavailable', { message: error })}</p>
        <Button type="button" onClick={() => postMessage({ type: 'retryRelationships' })}>
          {t('retryRelationships')}
        </Button>
      </section>
    );
  }
  if (!sections || sections.length === 0) {
    return (
      <section style={{ marginTop: '1.25rem' }}>
        <h2>{t('relationships')}</h2>
        <p>{t('relationshipsEmpty')}</p>
      </section>
    );
  }
  return (
    <section aria-label={t('relationships')}>
      {sections.map((section, index) => (
        <RelatedSection
          key={`${entryId}:${section.label}:${section.direction}`}
          id={`relationship-section-${index}`}
          title={`${sectionLabel(section.label)} · ${t(section.direction)}`}
          rows={section.rows}
          relatedById={relatedById}
          entries={entries}
          userMacros={userMacros}
          kindPalette={kindPalette}
          markdownImageUrlTransform={markdownImageUrlTransform}
          postMessage={postMessage}
        />
      ))}
    </section>
  );
}

function relationshipAtomicState(metadata: unknown): boolean | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as { isAtomic?: unknown }).isAtomic;
  return typeof value === 'boolean' ? value : null;
}

function RelatedSection({
  id,
  title,
  rows,
  relatedById,
  entries,
  userMacros,
  kindPalette,
  markdownImageUrlTransform,
  postMessage
}: {
  id: string;
  title: string;
  rows: EntryRelationshipSection['rows'];
  relatedById: ReadonlyMap<string, { entry: EntryData; kind: EntryKind | null }>;
  entries: EntryOption[];
  userMacros: MacroRecord | undefined;
  kindPalette: KindPalette | undefined;
  markdownImageUrlTransform: ((source: string) => string) | undefined;
  postMessage: (m: unknown) => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const contentLanguage = use_content_language();
  const [open, setOpen] = useState<boolean>(false);
  const count = rows.length;
  const panelId = `related-${id}`;
  return (
    <section
      style={{
        marginTop: '1.25rem',
        borderTop:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        paddingTop: '0.4rem'
      }}
    >
      <Disclosure
        expanded={open}
        controls={panelId}
        onToggle={() => setOpen((v) => !v)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          width: '100%',
          alignItems: 'baseline',
          gap: '0.6rem',
          userSelect: 'none',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left'
        }}
        aria-label={title}
        title={title}
      >
        <span style={{ opacity: 0.7, fontFamily: 'monospace', width: '1em' }}>
          {open ? '▾' : '▸'}
        </span>
        <span
          role="heading"
          aria-level={2}
          style={{
            margin: 0,
            fontSize: '1rem',
            fontWeight: 600
          }}
        >
          {title}
        </span>
        <span style={{ opacity: 0.55, fontSize: '0.8rem' }}>({count})</span>
      </Disclosure>
      {open ? (
        <div id={panelId} style={{ padding: '0.35rem 0 0.4rem 1.6em' }}>
          <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem'
              }}
            >
              {rows.map((r) => {
                const rowTitle = resolve_localized_string(r.title, contentLanguage);
                const related = relatedById.get(r.id);
                const atomic = relationshipAtomicState(r.metadata);
                return (
                  <li key={r.relationshipId} data-relationship-id={r.relationshipId}>
                    {atomic !== null ? (
                      <div
                        title={atomic ? t('atomicTitle') : t('compositeTitle')}
                        style={{ marginBottom: '0.3rem', opacity: 0.7, fontSize: '0.78rem' }}
                      >
                        {atomic ? t('atomic') : t('composite')}
                      </div>
                    ) : null}
                    {related ? (
                      <EntrySurface
                        entry={related.entry}
                        kind={related.kind}
                        entries={entries}
                        postMessage={postMessage}
                        userMacros={userMacros}
                        kindPalette={kindPalette}
                        markdownImageUrlTransform={markdownImageUrlTransform}
                        counterLabel={undefined}
                        onTitleCtrlClick={() => postMessage({
                          type: 'navigateEntry',
                          entryId: r.id,
                          entryPackage: r.package
                        })}
                      />
                    ) : (
                      <Button
                        type="button"
                        onClick={() => postMessage({
                          type: 'navigateEntry',
                          entryId: r.id,
                          entryPackage: r.package
                        })}
                        aria-label={t('openEntry', { title: rowTitle || r.id, id: r.id })}
                        title={t('openEntry', { title: rowTitle || r.id, id: r.id })}
                      >
                        {rowTitle || <em>{t('untitled')}</em>}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
        </div>
      ) : null}
    </section>
  );
}
