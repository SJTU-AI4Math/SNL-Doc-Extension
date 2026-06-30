// SNL Dashboard webview: project overview + library management.
//
// The Dashboard mirrors the management/reading split: this is the *manage*
// surface (compare with the Infoview which is the *read* surface). On
// mount it asks the host for an overview; the host re-pushes whenever
// `.SNL_Doc/(config|entries).json` or any `libraries/*/relationships.json`
// changes (via FileSystemWatcher).

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

interface LibrarySummary {
  slug: string;
  title: string;
  entryCount: number | null;
  relationshipCount: number | null;
}

interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null;
  libraries: LibrarySummary[];
}

const EMPTY: SnlOverview = {
  hasSnlDoc: false,
  totalEntryCount: null,
  libraries: []
};

export function DashboardApp(): React.ReactElement {
  const [overview, setOverview] = useState<SnlOverview>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'overview'; overview: SnlOverview }
        | undefined;
      if (!msg || msg.type !== 'overview') {
        return;
      }
      setOverview(msg.overview);
      setLoaded(true);
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!loaded) {
    return (
      <main style={PANEL_STYLE}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
          SNL Dashboard
        </h1>
        <p style={{ opacity: 0.7 }}>Loading project overview…</p>
      </main>
    );
  }

  if (!overview.hasSnlDoc) {
    return <NotInitialized api={apiRef.current} />;
  }

  return <Initialized overview={overview} api={apiRef.current} />;
}

/** Placeholder shown when `.SNL_Doc/` is missing. */
function NotInitialized({
  api
}: {
  api: VsCodeApi | undefined;
}): React.ReactElement {
  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '36rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        SNL Dashboard
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        This workspace does not have an <code>.SNL_Doc/</code> folder yet.
        Run <code>SNL: Init</code> to create the skeleton first.
      </p>
      <button
        type="button"
        onClick={() => api?.postMessage({ type: 'init' })}
        style={primaryButton(true)}
      >
        Run SNL: Init
      </button>
    </main>
  );
}

function Initialized({
  overview,
  api
}: {
  overview: SnlOverview;
  api: VsCodeApi | undefined;
}): React.ReactElement {
  const [entriesOpen, setEntriesOpen] = useState(false);
  const total =
    overview.totalEntryCount === null ? '—' : overview.totalEntryCount;

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '52rem' }}>
      <h1 style={{ margin: '0 0 1rem', fontSize: '1.4rem' }}>
        SNL Dashboard
      </h1>

      {/* === Entries overview ============================================== */}
      <section style={{ marginBottom: '1.5rem' }}>
        <SectionHeader
          title="Entries"
          subtitle={`${total} entries in shared pool`}
          expanded={entriesOpen}
          onToggle={() => setEntriesOpen((v) => !v)}
        />
        {entriesOpen ? (
          <div
            style={{
              marginTop: '0.5rem',
              padding: '0.75rem 1rem',
              border:
                '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
              borderRadius: '3px',
              opacity: 0.75,
              fontStyle: 'italic'
            }}
          >
            Entry table not implemented yet — the Entry data interface is
            still in design. This section is reserved.
          </div>
        ) : null}
      </section>

      {/* === Libraries table ============================================== */}
      <section>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '0.5rem'
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
            Libraries ({overview.libraries.length})
          </h2>
          <button
            type="button"
            onClick={() => api?.postMessage({ type: 'createLibrary' })}
            style={primaryButton(true)}
          >
            Create Library
          </button>
        </div>

        {overview.libraries.length === 0 ? (
          <p style={{ opacity: 0.75, margin: '0.5rem 0 0' }}>
            No libraries yet. Click <strong>Create Library</strong> to add
            one.
          </p>
        ) : (
          <LibrariesTable libraries={overview.libraries} />
        )}
      </section>
    </main>
  );
}

function SectionHeader({
  title,
  subtitle,
  expanded,
  onToggle
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'baseline',
        gap: '0.6rem',
        padding: '0.4rem 0',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        borderBottom:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        fontSize: '1.05rem'
      }}
      aria-expanded={expanded}
    >
      <span style={{ width: '0.9rem', opacity: 0.7 }}>
        {expanded ? '▾' : '▸'}
      </span>
      <span style={{ fontWeight: 600 }}>{title}</span>
      <span style={{ opacity: 0.7, fontSize: '0.9rem' }}>{subtitle}</span>
    </button>
  );
}

function LibrariesTable({
  libraries
}: {
  libraries: LibrarySummary[];
}): React.ReactElement {
  const cellStyle: React.CSSProperties = {
    padding: '0.45rem 0.6rem',
    borderBottom:
      '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
    textAlign: 'left'
  };
  const headStyle: React.CSSProperties = {
    ...cellStyle,
    fontWeight: 600,
    opacity: 0.85
  };

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.5rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          <th style={headStyle}>Title</th>
          <th style={headStyle}>Slug</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Entries</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Relationships</th>
        </tr>
      </thead>
      <tbody>
        {libraries.map((lib) => (
          <tr key={lib.slug}>
            <td style={cellStyle}>{lib.title}</td>
            <td style={{ ...cellStyle, opacity: 0.75, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
              {lib.slug}
            </td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>
              {lib.entryCount === null ? '—' : lib.entryCount}
            </td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>
              {lib.relationshipCount === null ? '—' : lib.relationshipCount}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
