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

interface MacroPackageSummary {
  file: string;
  macroCount: number | null;
}

interface EntryKind {
  id: string;
  name: string;
  color: string;
  numbering: { pattern: string; start?: number };
}

interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null;
  libraries: LibrarySummary[];
  macroPackages: MacroPackageSummary[];
  entryKinds: EntryKind[];
}

const EMPTY: SnlOverview = {
  hasSnlDoc: false,
  totalEntryCount: null,
  libraries: [],
  macroPackages: [],
  entryKinds: []
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
    <main style={{ ...PANEL_STYLE, maxWidth: '54rem' }}>
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
          <Placeholder text="Entry table not implemented yet — the Entry data interface is still in design. This section is reserved." />
        ) : null}
      </section>

      {/* === Entry Kinds catalog ========================================== */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
          Entry Kinds ({overview.entryKinds.length})
        </h2>
        {overview.entryKinds.length === 0 ? (
          <Placeholder text="No entry kinds defined yet. Edit .SNL_Doc/config.json#entry_kinds — a dedicated editor will land later." />
        ) : (
          <EntryKindsTable kinds={overview.entryKinds} />
        )}
      </section>

      {/* === SNL Macros ==================================================== */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem' }}>
          SNL Macros ({overview.macroPackages.length} package
          {overview.macroPackages.length === 1 ? '' : 's'})
        </h2>
        {overview.macroPackages.length === 0 ? (
          <Placeholder text="No macro packages yet. Drop *.json files under .SNL_Doc/term_macros/ — schema is not finalized; the count is best-effort." />
        ) : (
          <MacroPackagesTable packages={overview.macroPackages} />
        )}
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

function Placeholder({ text }: { text: string }): React.ReactElement {
  return (
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
      {text}
    </div>
  );
}

const CELL: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  borderBottom:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
  textAlign: 'left'
};
const HEAD: React.CSSProperties = { ...CELL, fontWeight: 600, opacity: 0.85 };
const MONO: React.CSSProperties = {
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  opacity: 0.75
};

function LibrariesTable({
  libraries
}: {
  libraries: LibrarySummary[];
}): React.ReactElement {
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
          <th style={HEAD}>Title</th>
          <th style={HEAD}>Slug</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Entries</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Relationships</th>
        </tr>
      </thead>
      <tbody>
        {libraries.map((lib) => (
          <tr key={lib.slug}>
            <td style={CELL}>{lib.title}</td>
            <td style={{ ...CELL, ...MONO }}>{lib.slug}</td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {lib.entryCount === null ? '—' : lib.entryCount}
            </td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {lib.relationshipCount === null ? '—' : lib.relationshipCount}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MacroPackagesTable({
  packages
}: {
  packages: MacroPackageSummary[];
}): React.ReactElement {
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
          <th style={HEAD}>File</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Macros</th>
        </tr>
      </thead>
      <tbody>
        {packages.map((pkg) => (
          <tr key={pkg.file}>
            <td style={{ ...CELL, ...MONO }}>{pkg.file}</td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {pkg.macroCount === null ? '—' : pkg.macroCount}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EntryKindsTable({
  kinds
}: {
  kinds: EntryKind[];
}): React.ReactElement {
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
          <th style={{ ...HEAD, width: '2rem' }}></th>
          <th style={HEAD}>Name</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Numbering</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <tr key={kind.id}>
            <td style={CELL}>
              <ColorSwatch color={kind.color} />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={{ ...CELL, ...MONO }}>
              {formatNumbering(kind.numbering)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ColorSwatch({ color }: { color: string }): React.ReactElement {
  // Keep visual feedback even for malformed colors — browser falls back to
  // the inherited color when the value is invalid, which is fine here.
  return (
    <span
      title={color}
      style={{
        display: 'inline-block',
        width: '1rem',
        height: '1rem',
        borderRadius: '3px',
        background: color,
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        verticalAlign: 'middle'
      }}
    />
  );
}

function formatNumbering(
  numbering: { pattern: string; start?: number } | undefined
): string {
  if (!numbering || typeof numbering.pattern !== 'string') {
    return '—';
  }
  if (typeof numbering.start === 'number') {
    return `${numbering.pattern} (start: ${numbering.start})`;
  }
  return numbering.pattern;
}
