// SNL Infoview: the READING surface. Three-layer drill-down per cat's
// 2026-07-06 design:
//
//   Layer 1 (Libraries)  ← default when opened
//   Layer 2 (Entries)    ← contents of one Library, from its graph.json
//   Layer 3 (Entry)      ← one entry rendered via @snl-basics/react
//
// Every layer has a "Edit in Dashboard" button (top-right) that jumps to
// the management surface — reader → editor handoff. Layers 2 & 3 also
// have a Back button that walks the stack up one step. Ctrl+clicking a
// rendered entry title still spawns the dedicated per-entry panel
// (`snlDoc.openEntryInfoview`) — that's an orthogonal, ad-hoc lookup.

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

interface LibraryEntry {
  slug: string;
  title: string;
  description?: string;
  hasMeta: boolean;
}

type Incoming =
  | { type: 'libraries'; libraries: LibraryEntry[] }
  | {
      type: 'libraryEntries';
      slug: string;
      title: string;
      description?: string;
      entries: EntryOption[];
      macros?: SnlMacroDb;
      warnings?: string[];
    }
  | {
      type: 'entryDetails';
      entry: EntryData;
      kind: EntryKind | null;
      entries?: EntryOption[];
      macros?: SnlMacroDb;
    }
  | undefined;

/** Current position in the 3-layer stack. */
type View =
  | { kind: 'loading' }
  | { kind: 'libraries'; libraries: LibraryEntry[] }
  | {
      kind: 'entries';
      slug: string;
      title: string;
      description?: string;
      entries: EntryOption[];
      warnings: string[];
    }
  | {
      kind: 'entry';
      /** Slug of the library the user drilled in from, so Back returns to
       *  the right entries list. `null` when the entry was opened without
       *  a library context (shouldn't happen in normal flow but be safe). */
      fromLibrarySlug: string | null;
      entry: EntryData;
      kind_: EntryKind | null;
      /** The library's title, cached so we can render the Back label without
       *  a round-trip. */
      fromLibraryTitle: string | null;
    };

export function App(): React.ReactElement {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [userMacros, setUserMacros] = useState<SnlMacroDb | undefined>(undefined);
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);
  // Cache the current library context across an entry render so `Back`
  // knows where to return.
  const currentLibraryRef = useRef<{ slug: string; title: string } | null>(null);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'libraries':
          currentLibraryRef.current = null;
          setView({
            kind: 'libraries',
            libraries: Array.isArray(msg.libraries) ? msg.libraries : []
          });
          break;
        case 'libraryEntries':
          currentLibraryRef.current = { slug: msg.slug, title: msg.title };
          if (msg.macros && typeof msg.macros === 'object') {
            setUserMacros(msg.macros);
          }
          setView({
            kind: 'entries',
            slug: msg.slug,
            title: msg.title,
            description: msg.description,
            entries: Array.isArray(msg.entries) ? msg.entries : [],
            warnings: Array.isArray(msg.warnings) ? msg.warnings : []
          });
          break;
        case 'entryDetails':
          if (msg.macros && typeof msg.macros === 'object') {
            setUserMacros(msg.macros);
          }
          if (Array.isArray(msg.entries)) {
            setEntryPool(msg.entries);
          }
          setView({
            kind: 'entry',
            fromLibrarySlug: currentLibraryRef.current?.slug ?? null,
            fromLibraryTitle: currentLibraryRef.current?.title ?? null,
            entry: msg.entry,
            kind_: msg.kind
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

  const postMessage = (message: unknown): void => {
    apiRef.current?.postMessage(message);
  };

  const goBack = (): void => {
    if (view.kind === 'entry') {
      // Back from entry → library entries. Re-request the library the user
      // came from; if we lost the context, fall back to the libraries root.
      const from = view.fromLibrarySlug;
      if (from) {
        postMessage({ type: 'selectLibrary', slug: from });
      } else {
        postMessage({ type: 'ready' });
      }
    } else if (view.kind === 'entries') {
      // Back from library entries → libraries root.
      postMessage({ type: 'ready' });
    }
  };

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={entryPool}
      userMacros={userMacros}
    >
      <main style={PANEL_STYLE}>
        {renderCurrentView(view, {
          postMessage,
          goBack,
          entryPool,
          userMacros
        })}
      </main>
    </HoverPopoverProvider>
  );
}

interface RenderCtx {
  postMessage: (m: unknown) => void;
  goBack: () => void;
  entryPool: EntryOption[];
  userMacros: SnlMacroDb | undefined;
}

function renderCurrentView(view: View, ctx: RenderCtx): React.ReactElement {
  switch (view.kind) {
    case 'loading':
      return <LoadingLayer />;
    case 'libraries':
      return <LibrariesLayer libraries={view.libraries} ctx={ctx} />;
    case 'entries':
      return (
        <EntriesLayer
          slug={view.slug}
          title={view.title}
          description={view.description}
          entries={view.entries}
          warnings={view.warnings}
          ctx={ctx}
        />
      );
    case 'entry':
      return (
        <EntryLayer
          entry={view.entry}
          kind={view.kind_}
          fromLibraryTitle={view.fromLibraryTitle}
          ctx={ctx}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Layer components
// ---------------------------------------------------------------------------

function LoadingLayer(): React.ReactElement {
  return (
    <>
      <TopBar title="SNL Infoview" />
      <p style={{ opacity: 0.7 }}>Loading libraries…</p>
    </>
  );
}

function LibrariesLayer({
  libraries,
  ctx
}: {
  libraries: LibraryEntry[];
  ctx: RenderCtx;
}): React.ReactElement {
  return (
    <>
      <TopBar
        title="SNL Infoview"
        subtitle={`${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}`}
        actions={
          <ToolbarButton
            label="Edit in Dashboard"
            title="Open the Dashboard (management surface)"
            onClick={() => ctx.postMessage({ type: 'openDashboard' })}
          />
        }
      />
      {libraries.length === 0 ? (
        <p style={{ opacity: 0.8 }}>
          No libraries yet. Create one via <code>SNL: Create Library</code>{' '}
          in the Dashboard, or paste an existing{' '}
          <code>.SNL_Doc/libraries/&lt;slug&gt;/</code> folder in.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {libraries.map((lib) => (
            <li key={lib.slug} style={{ marginBottom: '0.5rem' }}>
              <button
                type="button"
                onClick={() =>
                  ctx.postMessage({ type: 'selectLibrary', slug: lib.slug })
                }
                style={LIBRARY_CARD_STYLE}
              >
                <div style={{ fontWeight: 600, fontSize: '1rem' }}>
                  {lib.title}
                </div>
                <div
                  style={{
                    fontSize: '0.8rem',
                    opacity: 0.7,
                    fontFamily: 'var(--vscode-editor-font-family, monospace)'
                  }}
                >
                  {lib.slug}
                  {lib.hasMeta ? '' : ' · no meta.json'}
                </div>
                {lib.description ? (
                  <div
                    style={{
                      marginTop: '0.35rem',
                      fontSize: '0.85rem',
                      opacity: 0.85
                    }}
                  >
                    {lib.description}
                  </div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function EntriesLayer({
  slug,
  title,
  description,
  entries,
  warnings,
  ctx
}: {
  slug: string;
  title: string;
  description?: string;
  entries: EntryOption[];
  warnings: string[];
  ctx: RenderCtx;
}): React.ReactElement {
  return (
    <>
      <TopBar
        title={title}
        subtitle={`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${slug}`}
        actions={
          <>
            <ToolbarButton label="← Back" onClick={ctx.goBack} title="Back to libraries" />
            <ToolbarButton
              label="Edit in Dashboard"
              title="Open the Dashboard (management surface)"
              onClick={() => ctx.postMessage({ type: 'openDashboard' })}
            />
          </>
        }
      />
      {description ? (
        <p style={{ opacity: 0.85, marginTop: 0 }}>{description}</p>
      ) : null}
      {warnings.length > 0 ? <WarningBanner warnings={warnings} /> : null}
      {entries.length === 0 ? (
        <p style={{ opacity: 0.75, fontStyle: 'italic' }}>
          This library has no entries yet. Add some via the Dashboard.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {entries.map((e) => (
            <li key={e.id} style={{ marginBottom: '0.35rem' }}>
              <button
                type="button"
                onClick={() => ctx.postMessage({ type: 'selectEntry', id: e.id })}
                style={ENTRY_CARD_STYLE}
              >
                <span style={{ fontWeight: 500 }}>{e.title}</span>
                <span
                  style={{
                    fontSize: '0.75rem',
                    opacity: 0.6,
                    marginLeft: '0.5rem',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)'
                  }}
                >
                  ({e.id})
                </span>
                {!e.hasContent ? (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      opacity: 0.7,
                      marginLeft: '0.5rem',
                      fontStyle: 'italic'
                    }}
                  >
                    · empty
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function EntryLayer({
  entry,
  kind,
  fromLibraryTitle,
  ctx
}: {
  entry: EntryData;
  kind: EntryKind | null;
  fromLibraryTitle: string | null;
  ctx: RenderCtx;
}): React.ReactElement {
  const backLabel = fromLibraryTitle
    ? `← Back to ${fromLibraryTitle}`
    : '← Back';
  return (
    <>
      <TopBar
        title={entry.title}
        subtitle={entry.id}
        actions={
          <>
            <ToolbarButton label={backLabel} onClick={ctx.goBack} />
            <ToolbarButton
              label="Edit in Dashboard"
              title="Open this entry in the Dashboard editor"
              onClick={() =>
                ctx.postMessage({
                  type: 'openDashboardForEntry',
                  entryId: entry.id
                })
              }
            />
          </>
        }
      />
      <EntryRender
        entry={entry}
        kind={kind}
        entries={ctx.entryPool}
        postMessage={ctx.postMessage}
        userMacros={ctx.userMacros}
        counterLabel={undefined}
        disableTitleJump={false}
        onTitleCtrlClick={(entryId) =>
          ctx.postMessage({ type: 'openEntryInfoview', entryId })
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared UI bits
// ---------------------------------------------------------------------------

function TopBar({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '1rem',
        marginBottom: '1rem'
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <h1
          style={{
            margin: '0 0 0.15rem',
            fontSize: '1.25rem',
            wordBreak: 'break-word'
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <div
            style={{
              opacity: 0.7,
              fontSize: '0.85rem',
              fontFamily: 'var(--vscode-editor-font-family, monospace)'
            }}
          >
            {subtitle}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function ToolbarButton({
  label,
  title,
  onClick
}: {
  label: string;
  title?: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button type="button" title={title} onClick={onClick} style={TOOLBAR_BUTTON_STYLE}>
      {label}
    </button>
  );
}

function WarningBanner({ warnings }: { warnings: string[] }): React.ReactElement {
  return (
    <div
      role="status"
      style={{
        margin: '0 0 1rem',
        padding: '0.55rem 0.75rem',
        borderRadius: '5px',
        border:
          '1px solid var(--vscode-inputValidation-warningBorder, #b89500)',
        background:
          'var(--vscode-inputValidation-warningBackground, rgba(184, 149, 0, 0.15))',
        fontSize: '0.85rem'
      }}
    >
      <div style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
        ⚠️ {warnings.length} warning{warnings.length === 1 ? '' : 's'} in graph.json
      </div>
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {warnings.slice(0, 5).map((w, i) => (
          <li key={i}>{w}</li>
        ))}
        {warnings.length > 5 ? (
          <li style={{ opacity: 0.7 }}>… {warnings.length - 5} more</li>
        ) : null}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const LIBRARY_CARD_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.75rem 1rem',
  textAlign: 'left',
  color: 'inherit',
  background:
    'var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e))',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
  borderRadius: '6px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '1rem'
};

const ENTRY_CARD_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '0.45rem 0.75rem',
  textAlign: 'left',
  color: 'inherit',
  background: 'transparent',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
  borderRadius: '4px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '0.95rem'
};

const TOOLBAR_BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '0.35rem 0.75rem',
  fontFamily: 'inherit',
  fontSize: '0.85rem',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
  borderRadius: '4px',
  background:
    'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
  color: 'inherit',
  cursor: 'pointer'
};
