// Per-entry SNL Infoview surface. Unlike App.tsx (the picker), this webview
// renders exactly one Entry — the host sends its details (plus the full entry
// pool for macro-source resolution) after we announce readiness.

import React, { useEffect, useRef, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
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

const MESSAGES = defineUiMessages('entryInfoview', {
  title: 'Entry Infoview', edit: '✎ Edit', editTitle: 'Open this entry in the Edit Entry panel',
  loading: 'Loading entry…', notFound: 'Entry not found in this workspace.',
  context: 'Context', contextDescription: 'Entries providing bindings this one uses (via x@srcEntry).',
  contextEmpty: "No context bindings — this entry doesn't reference any x@srcEntry.",
  dependencies: 'Dependencies',
  dependenciesDescription: 'Entries this one depends on (via macros whose source resolves in the pool). Ordered by title; lower entries depend on upper ones is only guaranteed for the graph view.',
  dependenciesEmpty: 'No dependencies — every macro used here has no in-pool source entry.',
  openEntry: 'Open Infoview for {title} ({id})', untitled: '(untitled)',
  atomic: 'atomic', composite: 'composite',
  atomicTitle: 'Atomic dependency — no shorter compose path in the pool.',
  compositeTitle: 'Composite dependency — this edge is redundant with a chain of others.'
}, {
  title: '条目信息视图', edit: '✎ 编辑', editTitle: '在“编辑条目”面板中打开此条目',
  loading: '正在加载条目……', notFound: '在此工作区中找不到该条目。',
  context: '上下文', contextDescription: '提供此条目所用绑定的条目（通过 x@srcEntry）。',
  contextEmpty: '无上下文绑定——此条目未引用任何 x@srcEntry。', dependencies: '依赖项',
  dependenciesDescription: '此条目依赖的条目（通过来源可在条目池中解析的宏）。按标题排序；仅关系图视图保证下方条目依赖上方条目。',
  dependenciesEmpty: '无依赖项——此处使用的所有宏都没有条目池内的来源条目。',
  openEntry: '打开 {title}（{id}）的信息视图', untitled: '（无标题）', atomic: '原子', composite: '组合',
  atomicTitle: '原子依赖项——条目池中不存在更短的组合路径。',
  compositeTitle: '组合依赖项——此边与其他边组成的链重复。'
});

/** One row in the Context / Dependencies collapsible lists (cat 2026-07-10 §2). */
interface RelatedRow {
  id: string;
  title: string;
  kindId?: string;
  /** Only meaningful for dependency rows; null for context / unknown. */
  isAtomic?: boolean | null;
}

interface RelatedEntries {
  context: RelatedRow[];
  dependencies: RelatedRow[];
}

type Incoming =
  | {
      type: 'entryDetails';
      entry: EntryData | null;
      kind: EntryKind | null;
      entries: EntryOption[];
      macros?: MacroRecord;
      macroKinds?: MacroKind[];
      relatedEntries?: RelatedEntries | null;
      assetBaseUri?: string;
    }
  | undefined;

export function EntryInfoviewApp(): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<{
    entry: EntryData;
    kind: EntryKind | null;
    entries: EntryOption[];
    related: RelatedEntries;
  } | null>(null);
  const [userMacros, setUserMacros] = useState<MacroRecord | undefined>(undefined);
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);
  const [assetBaseUri, setAssetBaseUri] = useState('');
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      if (msg.type === 'entryDetails') {
        setLoaded(true);
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
          related: msg.relatedEntries ?? { context: [], dependencies: [] }
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
        ) : !state ? (
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
            <RelatedSection
              id="context"
              title={t('context')}
              description={t('contextDescription')}
              rows={state.related.context}
              postMessage={postMessage}
              emptyHint={t('contextEmpty')}
            />
            <RelatedSection
              id="dependencies"
              title={t('dependencies')}
              description={t('dependenciesDescription')}
              rows={state.related.dependencies}
              postMessage={postMessage}
              emptyHint={t('dependenciesEmpty')}
              showAtomicBadge
            />
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
function RelatedSection({
  id,
  title,
  description,
  rows,
  postMessage,
  emptyHint,
  showAtomicBadge
}: {
  id: 'context' | 'dependencies';
  title: string;
  description: string;
  rows: RelatedRow[];
  postMessage: (m: unknown) => void;
  emptyHint: string;
  showAtomicBadge?: boolean;
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
        title={description}
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
          {count === 0 ? (
            <p style={{ opacity: 0.55, fontSize: '0.85rem', margin: 0, fontStyle: 'italic' }}>
              {emptyHint}
            </p>
          ) : (
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
                        type: 'openEntryInfoview',
                        entryId: r.id
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
                    {showAtomicBadge && r.isAtomic !== undefined && r.isAtomic !== null ? (
                      <span
                        style={{
                          opacity: 0.6,
                          fontSize: '0.7rem',
                          padding: '0 0.35em',
                          borderRadius: '2px',
                          background:
                            'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08))',
                          textDecoration: 'none'
                        }}
                        title={
                          r.isAtomic
                            ? t('atomicTitle')
                            : t('compositeTitle')
                        }
                      >
                        {r.isAtomic ? t('atomic') : t('composite')}
                      </span>
                    ) : null}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
