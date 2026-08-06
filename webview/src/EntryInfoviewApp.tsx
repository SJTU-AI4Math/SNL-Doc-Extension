// Per-entry SNL Infoview surface. Unlike App.tsx (the picker), this webview
// renders exactly one Entry — the host sends its details (plus the full entry
// pool for macro-source resolution) after we announce readiness.

import React, { useEffect, useState } from 'react';
import { useVsCodeApiRef, PANEL_STYLE } from './vscodeApi';
import {
  EntrySurface,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './render/EntrySurface';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import type { KindPalette } from '@sjtu-ai4math/snl-basics';
import type { MacroRecord } from './render/macroData';
import {
  macroKindsToPalette
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

const MESSAGES = defineUiMessages('entryInfoview', {
  title: 'Entry Infoview', edit: '✎ Edit', editTitle: 'Open this entry in the Edit Entry panel',
  loading: 'Loading entry…', notFound: 'Entry not found in this workspace.',
  loadError: 'Could not load entry data: {message}',
  back: 'Back', relationships: 'Relationships', incoming: 'Incoming', outgoing: 'Outgoing',
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
      macros?: MacroRecord;
      macroKinds?: MacroKind[];
      relationshipSections?: EntryRelationshipSection[] | null;
      relationshipsError?: string;
      returnRoute?: EntryReturnRoute;
      assetBaseUri?: string;
    }
  | { type: 'entryDetailsError'; entryId: string; message: string }
  | undefined;

export function EntryInfoviewApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<{
    entry: EntryData;
    kind: EntryKind | null;
    entries: EntryOption[];
    entryPackages: Record<string, string>;
    relationshipSections: EntryRelationshipSection[] | null;
    relationshipsError: string | null;
    returnRoute: EntryReturnRoute;
  } | null>(null);
  const [userMacros, setUserMacros] = useState<MacroRecord | undefined>(undefined);
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);
  const [assetBaseUri, setAssetBaseUri] = useState('');
  const apiRef = useVsCodeApiRef();

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      if (msg.type === 'entryDetailsError') {
        setLoaded(true);
        setState(null);
        setLoadError(msg.message);
        return;
      }
      if (msg.type === 'entryDetails') {
        setLoaded(true);
        setLoadError(null);
        if (msg.macros && typeof msg.macros === 'object') {
          setUserMacros(msg.macros);
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
          title={state?.entry.title || t('title')}
          subtitle={state?.entry.id}
          showRefresh={false}
          back={state ? {
            label: t('back'),
            onClick: () => postMessage({ type: 'back' })
          } : undefined}
          actions={state ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => postMessage({ type: 'editEntry', entryId: state.entry.id })}
              title={t('editTitle')}
            >
              {t('edit')}
            </Button>
          ) : null}
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
              macros={(userMacros ?? {}) as Record<string, MacroPackageEntry>}
              macroKinds={macroKinds}
              entryPoolIds={new Set(state.entries.map((entry) => entry.id))}
              postMessage={postMessage}
            />
            <RelationshipsRegion
              sections={state.relationshipSections}
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
 * Collapsible list of related-entry rows (Context or Dependencies).
 * Click the row title → open that entry's own Infoview panel.
 * Ctrl+click same → identical (redundant with plain click here; the
 * graph is where the plain/Ctrl distinction actually diverges).
 */
function RelationshipsRegion({ sections, error, postMessage }: {
  sections: EntryRelationshipSection[] | null;
  error: string | null;
  postMessage: (m: unknown) => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
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
      {sections.map((section) => (
        <RelatedSection
          key={`${section.label}:${section.direction}`}
          id={`${section.label}-${section.direction}`}
          title={`${section.label} · ${t(section.direction)}`}
          rows={section.rows}
          postMessage={postMessage}
        />
      ))}
    </section>
  );
}

function RelatedSection({
  id,
  title,
  rows,
  postMessage
}: {
  id: string;
  title: string;
  rows: EntryRelationshipSection['rows'];
  postMessage: (m: unknown) => void;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [open, setOpen] = useState<boolean>(true);
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
                gap: '0.15rem'
              }}
            >
              {rows.map((r) => (
                <li key={r.id}>
                  <Button
                    type="button"
                    onClick={() =>
                      postMessage({
                        type: 'navigateEntry',
                        entryId: r.id,
                        entryPackage: r.package
                      })
                    }
                    title={t('openEntry', { title: r.title || r.id, id: r.id })}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--vscode-textLink-foreground, #4ea3f5)',
                      cursor: 'pointer',
                      padding: '0.1rem 0.2rem',
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: '0.5rem',
                      fontFamily: 'inherit',
                      fontSize: '0.9rem',
                      textDecoration: 'underline'
                    }}
                  >
                    <span>{r.title || <em>{t('untitled')}</em>}</span>
                    {r.kindId ? (
                      <span
                        style={{
                          opacity: 0.55,
                          fontSize: '0.75rem',
                          fontFamily: 'monospace',
                          textDecoration: 'none'
                        }}
                      >
                        [{r.kindId}]
                      </span>
                    ) : null}

                  </Button>
                </li>
              ))}
            </ul>
        </div>
      ) : null}
    </section>
  );
}
