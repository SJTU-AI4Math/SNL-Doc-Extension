// Per-entry SNL Infoview surface. Unlike App.tsx (the picker), this webview
// renders exactly one Entry — the host sends its details (plus the full entry
// pool for macro-source resolution) after we announce readiness.

import React, { useEffect, useRef, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import {
  EntryRender,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './render/EntryRender';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import type { SnlMacroDb } from '@snl-basics/react';

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
      macros?: SnlMacroDb;
      relatedEntries?: RelatedEntries | null;
    }
  | undefined;

export function EntryInfoviewApp(): React.ReactElement {
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<{
    entry: EntryData;
    kind: EntryKind | null;
    entries: EntryOption[];
    related: RelatedEntries;
  } | null>(null);
  const [userMacros, setUserMacros] = useState<SnlMacroDb | undefined>(undefined);
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

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={state?.entries ?? []}
      userMacros={userMacros}
    >
      <main style={{ ...PANEL_STYLE, position: 'relative' }}>
        {!loaded ? (
          <p style={{ opacity: 0.8 }}>Loading entry…</p>
        ) : !state ? (
          <p style={{ opacity: 0.8 }}>Entry not found in this workspace.</p>
        ) : (
          <>
            {/* Cat 2026-07-10 §2: right-aligned Edit button. Positioned
                absolute so it hovers over the top of the entry block
                without stealing horizontal space from the render. */}
            <button
              type="button"
              onClick={() =>
                postMessage({ type: 'editEntry', entryId: state.entry.id })
              }
              title="Open this entry in the Edit Entry panel"
              style={{
                position: 'absolute',
                top: '0.6rem',
                right: '0.8rem',
                zIndex: 10,
                padding: '0.25rem 0.7rem',
                fontFamily: 'inherit',
                fontSize: '0.8rem',
                border:
                  '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
                borderRadius: '3px',
                background:
                  'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
                color: 'inherit',
                cursor: 'pointer'
              }}
            >
              ✎ Edit
            </button>
            <EntryRender
              entry={state.entry}
              kind={state.kind}
              entries={state.entries}
              postMessage={postMessage}
              userMacros={userMacros}
              counterLabel={undefined}
              disableTitleJump={true}
            />
            <RelatedSection
              title="Context"
              description="Entries providing bindings this one uses (via x@srcEntry)."
              rows={state.related.context}
              postMessage={postMessage}
              emptyHint="No context bindings — this entry doesn't reference any x@srcEntry."
            />
            <RelatedSection
              title="Dependencies"
              description="Entries this one depends on (via macros whose source resolves in the pool). Ordered by title; lower entries depend on upper ones is only guaranteed for the graph view."
              rows={state.related.dependencies}
              postMessage={postMessage}
              emptyHint="No dependencies — every macro used here has no in-pool source entry."
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
  title,
  description,
  rows,
  postMessage,
  emptyHint,
  showAtomicBadge
}: {
  title: string;
  description: string;
  rows: RelatedRow[];
  postMessage: (m: unknown) => void;
  emptyHint: string;
  showAtomicBadge?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState<boolean>(true);
  const count = rows.length;
  return (
    <section
      style={{
        marginTop: '1.25rem',
        borderTop:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        paddingTop: '0.4rem'
      }}
    >
      <header
        onClick={() => setOpen((v) => !v)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.6rem',
          userSelect: 'none'
        }}
        title={description}
      >
        <span style={{ opacity: 0.7, fontFamily: 'monospace', width: '1em' }}>
          {open ? '▾' : '▸'}
        </span>
        <h2
          style={{
            margin: 0,
            fontSize: '1rem',
            fontWeight: 600
          }}
        >
          {title}
        </h2>
        <span style={{ opacity: 0.55, fontSize: '0.8rem' }}>({count})</span>
      </header>
      {open ? (
        <div style={{ padding: '0.35rem 0 0.4rem 1.6em' }}>
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
                  <button
                    type="button"
                    onClick={() =>
                      postMessage({
                        type: 'openEntryInfoview',
                        entryId: r.id
                      })
                    }
                    title={`Open Infoview for ${r.title || r.id} (${r.id})`}
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
                    <span>{r.title || <em>(untitled)</em>}</span>
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
                            ? 'Atomic dependency — no shorter compose path in the pool.'
                            : 'Composite dependency — this edge is redundant with a chain of others.'
                        }
                      >
                        {r.isAtomic ? 'atomic' : 'composite'}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
