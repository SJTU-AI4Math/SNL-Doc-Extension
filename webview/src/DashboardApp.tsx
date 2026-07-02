// SNL Dashboard webview: project overview + library management.
//
// The Dashboard mirrors the management/reading split: this is the *manage*
// surface (compare with the Infoview which is the *read* surface). On
// mount it asks the host for an overview; the host re-pushes whenever
// `.SNL_Doc/(config|entries).json` or any `libraries/*/relationships.json`
// changes (via FileSystemWatcher).
//
// Section order (top → bottom):
//   1. Entry Kinds  — catalogue of entry categories
//   2. SNL Macros   — term-macro package files
//   3. Entries      — shared entry pool (collapsed by default)
//   4. Libraries    — per-library management
//
// This matches the intended data-flow reading order: define your kinds and
// macros first, then browse entries, finally manage libraries that use
// them. Entries lives just above Libraries so scrolling from top gives you
// the metadata before the actual pool of content.
//
// Create/Initialize actions are not header buttons. Each section instead
// ends with a full-width dashed "+" bar (see `AddBar`) placed AFTER its
// list; when a list is empty the section shows only that bar as its
// call-to-action. SNL Macros now follows the same pattern: a "+ Add Package"
// bar plus click-to-open rows (each opens a per-file PackagePanel). The
// Entries bar lives inside the collapsible body so it only appears when the
// section is expanded.

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
  coloring: { stroke: string; background: string };
  numbering: string;
  style: string;
}

interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
}

interface EntryData {
  id: string;
  kind: string;
  title: string;
  content: {
    snl?: string;
    typst?: string;
    latex?: string;
    markdown?: string;
    text?: string;
  };
  contribution_info?: unknown;
  pointer?: unknown;
}

interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null;
  entries: EntryData[];
  libraries: LibrarySummary[];
  macroPackages: MacroPackageSummary[];
  entryKinds: EntryKind[];
  macroKinds: MacroKind[];
}

const EMPTY: SnlOverview = {
  hasSnlDoc: false,
  totalEntryCount: null,
  entries: [],
  libraries: [],
  macroPackages: [],
  entryKinds: [],
  macroKinds: []
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
  const hasKinds = overview.entryKinds.length > 0;
  const hasMacroKinds = overview.macroKinds.length > 0;

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '62rem' }}>
      <h1 style={{ margin: '0 0 1rem', fontSize: '1.4rem' }}>
        SNL Dashboard
      </h1>

      {/* === 1. Entry Kinds catalog ======================================== */}
      <section style={{ marginBottom: '1.5rem' }}>
        <SectionRow title={`Entry Kinds (${overview.entryKinds.length})`} />
        {hasKinds ? (
          <>
            <EntryKindsTable kinds={overview.entryKinds} />
            <AddBar
              label="Create Entry Kind"
              onActivate={() =>
                api?.postMessage({ type: 'createEntryKind' })
              }
            />
          </>
        ) : (
          <AddBar
            label="Initialize Entry Kinds"
            onActivate={() => api?.postMessage({ type: 'initEntryKinds' })}
          />
        )}
      </section>

      {/* === 2. SNL Macro Kinds catalog =================================== */}
      <section style={{ marginBottom: '1.5rem' }}>
        <SectionRow title={`SNL Macro Kinds (${overview.macroKinds.length})`} />
        {hasMacroKinds ? (
          <>
            <MacroKindsTable kinds={overview.macroKinds} />
            <AddBar
              label="Create Macro Kind"
              onActivate={() =>
                api?.postMessage({ type: 'createMacroKind' })
              }
            />
          </>
        ) : (
          <AddBar
            label="Initialize Macro Kinds"
            onActivate={() => api?.postMessage({ type: 'initMacroKinds' })}
          />
        )}
      </section>

      {/* === 3. SNL Macros ================================================= */}
      <section style={{ marginBottom: '1.5rem' }}>
        <SectionRow
          title={`SNL Macros (${overview.macroPackages.length} package${
            overview.macroPackages.length === 1 ? '' : 's'
          })`}
        />
        {overview.macroPackages.length > 0 ? (
          <MacroPackagesTable
            packages={overview.macroPackages}
            onOpen={(file) =>
              api?.postMessage({ type: 'openMacroPackage', file })
            }
          />
        ) : null}
        <AddBar
          label="Add Package"
          onActivate={() => api?.postMessage({ type: 'createMacroPackage' })}
        />
      </section>

      {/* === 3. Entries overview =========================================== */}
      <section style={{ marginBottom: '1.5rem' }}>
        <CollapsibleHeader
          title="Entries"
          subtitle={`${total} entries in shared pool`}
          expanded={entriesOpen}
          onToggle={() => setEntriesOpen((v) => !v)}
        />
        {entriesOpen ? (
          <>
            {overview.entries.length > 0 ? (
              <EntriesTable
                entries={overview.entries}
                kinds={overview.entryKinds}
              />
            ) : null}
            <AddBar
              label="Create Entry"
              onActivate={() => api?.postMessage({ type: 'createEntry' })}
            />
          </>
        ) : null}
      </section>

      {/* === 4. Libraries ================================================== */}
      <section>
        <SectionRow title={`Libraries (${overview.libraries.length})`} />
        {overview.libraries.length > 0 ? (
          <LibrariesTable libraries={overview.libraries} />
        ) : null}
        <AddBar
          label="Create Library"
          onActivate={() => api?.postMessage({ type: 'createLibrary' })}
        />
      </section>
    </main>
  );
}

/**
 * Full-width dashed "+" bar rendered at the END of a section's list. Clicking
 * (or Enter/Space) dispatches the section's create/init message. When a list
 * is empty the section shows only this bar as its call-to-action.
 */
function AddBar({
  label,
  onActivate
}: {
  label: string;
  onActivate: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4rem',
        width: '100%',
        boxSizing: 'border-box',
        height: '3rem',
        marginTop: '0.5rem',
        borderRadius: '6px',
        border: hover
          ? '1.5px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))'
          : '2px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
        userSelect: 'none'
      }}
    >
      <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>+</span>
      <span>{label}</span>
    </div>
  );
}

/** Static section header showing just the section title. */
function SectionRow({ title }: { title: string }): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '0.5rem'
      }}
    >
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{title}</h2>
    </div>
  );
}

/** Toggleable header used by the Entries section. */
function CollapsibleHeader({
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

const CELL: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  borderBottom:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
  textAlign: 'left',
  verticalAlign: 'middle'
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
  packages,
  onOpen
}: {
  packages: MacroPackageSummary[];
  onOpen: (file: string) => void;
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
          <MacroPackageRow key={pkg.file} pkg={pkg} onOpen={onOpen} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * A single clickable macro-package row. Clicking (or Enter/Space) dispatches
 * `openMacroPackage` for this file. Hover / focus paints the row with the
 * theme's list-hover background, matching VS Code list affordances.
 */
function MacroPackageRow({
  pkg,
  onOpen
}: {
  pkg: MacroPackageSummary;
  onOpen: (file: string) => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const activate = (): void => onOpen(pkg.file);
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`Open macro package ${pkg.file}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent'
      }}
    >
      <td style={{ ...CELL, ...MONO }}>{pkg.file}</td>
      <td style={{ ...CELL, textAlign: 'right' }}>
        {pkg.macroCount === null ? '—' : pkg.macroCount}
      </td>
    </tr>
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
          <th style={{ ...HEAD, width: '5.5rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Numbering</th>
          <th style={HEAD}>Style</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <tr key={kind.id}>
            <td style={CELL}>
              <KindPreview
                stroke={kind.coloring.stroke}
                background={kind.coloring.background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={{ ...CELL, ...MONO }}>
              {kind.numbering ? kind.numbering : '—'}
            </td>
            <td style={{ ...CELL, ...MONO }}>
              {kind.style ? kind.style : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Macro-kinds catalog table for the Dashboard. */
function MacroKindsTable({
  kinds
}: {
  kinds: MacroKind[];
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
          <th style={{ ...HEAD, width: '5.5rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Description</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <tr key={kind.id}>
            <td style={CELL}>
              <KindPreview
                stroke={kind.coloring.stroke}
                background={kind.coloring.background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={CELL}>{kind.description ? kind.description : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Compact box preview showing stroke + background together. */
function KindPreview({
  stroke,
  background,
  width = '3.5rem'
}: {
  stroke: string;
  background: string;
  width?: string;
}): React.ReactElement {
  return (
    <span
      title={`stroke ${stroke} / background ${background}`}
      style={{
        display: 'inline-block',
        width,
        height: '1.25rem',
        borderRadius: '3px',
        background,
        border: `2px solid ${stroke}`,
        verticalAlign: 'middle'
      }}
    />
  );
}

/** List of populated content formats for an entry, e.g. "snl, typst". */
function populatedFormats(entry: EntryData): string {
  const order: Array<keyof EntryData['content']> = [
    'snl',
    'typst',
    'latex',
    'markdown',
    'text'
  ];
  const present = order.filter((k) => {
    const v = entry.content?.[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
  return present.length > 0 ? present.join(', ') : '—';
}

function EntriesTable({
  entries,
  kinds
}: {
  entries: EntryData[];
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
          <th style={{ ...HEAD, width: '3.5rem' }}>Preview</th>
          <th style={HEAD}>Title</th>
          <th style={HEAD}>ID</th>
          <th style={HEAD}>Kind</th>
          <th style={HEAD}>Formats</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const kind = kinds.find((k) => k.id === entry.kind);
          return (
            <tr key={entry.id}>
              <td style={CELL}>
                <KindPreview
                  stroke={kind ? kind.coloring.stroke : '#888888'}
                  background={kind ? kind.coloring.background : '#f0f0f0'}
                  width="2rem"
                />
              </td>
              <td style={CELL}>{entry.title}</td>
              <td style={{ ...CELL, ...MONO }}>{entry.id}</td>
              <td style={CELL}>
                {kind ? (
                  kind.name
                ) : (
                  <span
                    title={`Unknown kind "${entry.kind}" — no matching entry kind in config.json`}
                    style={{
                      display: 'inline-block',
                      padding: '0.05rem 0.4rem',
                      borderRadius: '3px',
                      fontSize: '0.85rem',
                      color: 'var(--vscode-errorForeground, #f14c4c)',
                      border:
                        '1px solid var(--vscode-errorForeground, #f14c4c)'
                    }}
                  >
                    ⚠ unknown
                  </span>
                )}
              </td>
              <td style={{ ...CELL, ...MONO }}>{populatedFormats(entry)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}