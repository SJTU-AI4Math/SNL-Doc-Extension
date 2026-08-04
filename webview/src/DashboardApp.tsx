// SNL Dashboard webview: project overview + library management.
//
// The Dashboard mirrors the management/reading split: this is the *manage*
// surface (compare with the Infoview which is the *read* surface). On
// mount it asks the host for an overview; the host re-pushes whenever
// `.SNL_Doc/(config|entries).json` or any `libraries/*/graph.json`
// changes (via FileSystemWatcher).
//
// Section order (top → bottom):
//   1. Libraries    — per-library management (primary content)
//   2. Entries      — shared entry pool (primary content)
//   3. SNL Macros   — term-macro package files
//   4. Entry Kinds  — catalogue of entry categories
//   5. Macro Kinds  — catalogue of macro categories
//
// This matches the reader's natural priority: what libraries exist, what
// entries live in the shared pool, then the packaged macros used by them,
// with the catalogue metadata (kinds) at the bottom as reference.
//
// Every section is a `CollapsibleSection` — the header shows count + toggle
// chevron; the body is only mounted when expanded. Default state = all
// collapsed (极简，用户按需展开). Each section's body ends with a full-width
// dashed "+" bar (`AddBar`) that dispatches the section's create/init
// message; when the list is empty the section shows only that bar.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './components/Button';
import { PanelHeader } from './components/PanelHeader';
import { RowPrimaryButton } from './components/RowPrimaryButton';
import { shouldStopRowActivation } from './components/interactionModel';
import {
  buildEntryMetricContext,
  computeEntryMetrics,
  DEFAULT_ENTRY_METRIC_THRESHOLDS,
  EntryMetricValue,
  type EntryMetricThresholds,
  type SnlMacroSourceLookup
} from './components/EntryMetrics';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { use_preferences_revision } from './runtime/preferencesRuntime';

interface LibrarySummary {
  slug: string;
  title: string;
  entryCount: number | null;
  relationshipCount: number | null;
}

interface MacroPackageSummary {
  file: string;
  macroCount: number | null;
  active?: boolean;
}

/**
 * SNoogL search-index entry: one per macro across every package. Mirrors
 * snlDoc.ts's `AllMacroIndexEntry`. Deliberately narrow — no styles /
 * templates — because the search box only matches on `id` and shows the
 * origin package for context.
 */
interface AllMacroIndexEntry {
  id: string;
  packageFile: string;
  packageName: string;
  kind?: string;
}

interface EntryKind {
  id: string;
  name: string;
  coloring: { stroke: string; background: string };
  defaultCounterName: string;
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

interface RelationshipData {
  id: string;
  from: string;
  to: string;
  label: string;
  metadata: unknown;
}

interface DataStatusSummary {
  status: 'missing' | 'invalid' | 'future' | 'current' | 'needsMigration';
  currentVersion: string | null;
  targetVersion: string;
  pendingCount: number;
  message: string;
}

interface DataOperationStatus {
  status: 'idle' | 'running' | 'error';
  operation?: 'check' | 'repair';
  message?: string;
}

type SetupMessageType = 'init' | 'initEntryKinds' | 'initMacroKinds';

interface SnlOverview {
  hasSnlDoc: boolean;
  totalEntryCount: number | null;
  entries: EntryData[];
  libraries: LibrarySummary[];
  macroPackages: MacroPackageSummary[];
  /** SNoogL search index — see AllMacroIndexEntry. */
  allMacros: AllMacroIndexEntry[];
  metricMacroSources: SnlMacroSourceLookup;
  metricThresholds: EntryMetricThresholds;
  entryKinds: EntryKind[];
  macroKinds: MacroKind[];
  relationships: RelationshipData[];
  dataStatus: DataStatusSummary;
}

const EMPTY: SnlOverview = {
  hasSnlDoc: false,
  totalEntryCount: null,
  entries: [],
  libraries: [],
  macroPackages: [],
  allMacros: [],
  metricMacroSources: {},
  metricThresholds: DEFAULT_ENTRY_METRIC_THRESHOLDS,
  entryKinds: [],
  macroKinds: [],
  relationships: [],
  dataStatus: {
    status: 'invalid',
    currentVersion: null,
    targetVersion: '—',
    pendingCount: 0,
    message: 'Data version has not been checked yet.'
  }
};

export function DashboardApp(): React.ReactElement {
  use_preferences_revision();
  const [overview, setOverview] = useState<SnlOverview>(EMPTY);
  const [dataOperation, setDataOperation] = useState<DataOperationStatus>({ status: 'idle' });
  const [setupBusy, setSetupBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'overview'; overview: SnlOverview }
        | ({ type: 'dataMigrationStatus' } & DataOperationStatus)
        | { type: 'setupStatus'; status: 'idle' | 'running' }
        | undefined;
      if (!msg) return;
      if (msg.type === 'dataMigrationStatus') {
        setDataOperation({
          status: msg.status,
          operation: msg.operation,
          message: msg.message
        });
        return;
      }
      if (msg.type === 'setupStatus') {
        setSetupBusy(msg.status === 'running');
        return;
      }
      if (msg.type !== 'overview') return;
      setOverview({
        ...EMPTY,
        ...msg.overview,
        metricMacroSources: msg.overview.metricMacroSources ?? {},
        metricThresholds:
          msg.overview.metricThresholds ?? DEFAULT_ENTRY_METRIC_THRESHOLDS
      });
      setLoaded(true);
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const startSetup = (type: SetupMessageType): void => {
    const api = apiRef.current;
    if (!api) return;
    setSetupBusy(true);
    api.postMessage({ type });
  };

  if (!loaded) {
    return (
      <main style={PANEL_STYLE}>
        <PanelHeader vsApi={apiRef.current} title="SNL Dashboard" />
        <p style={{ opacity: 0.7 }}>Loading project overview…</p>
      </main>
    );
  }

  if (!overview.hasSnlDoc) {
    return (
      <NotInitialized
        api={apiRef.current}
        busy={setupBusy}
        onStart={startSetup}
      />
    );
  }

  return (
    <Initialized
      overview={overview}
      api={apiRef.current}
      dataOperation={dataOperation}
      setupBusy={setupBusy}
      onStartSetup={startSetup}
    />
  );
}

/** Placeholder shown when `.SNL_Doc/` is missing. */
function NotInitialized({
  api,
  busy,
  onStart
}: {
  api: VsCodeApi | undefined;
  busy: boolean;
  onStart: (type: SetupMessageType) => void;
}): React.ReactElement {
  return (
    <main style={PANEL_STYLE} aria-busy={busy}>
      <PanelHeader vsApi={api} title="SNL Dashboard" />
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        This workspace does not have an <code>.SNL_Doc/</code> folder yet.
        Create the skeleton alone, or initialize a standard Kind catalog as
        part of setup.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <Button
          type="button"
          onClick={() => onStart('init')}
          disabled={busy}
          variant="primary"
        >
          Run SNL: Init
        </Button>
        <Button
          type="button"
          onClick={() => onStart('initEntryKinds')}
          disabled={busy}
          variant="secondary"
        >
          Initialize Entry Kinds
        </Button>
        <Button
          type="button"
          onClick={() => onStart('initMacroKinds')}
          disabled={busy}
          variant="secondary"
        >
          Initialize Macro Kinds
        </Button>
      </div>
      <p role="status" aria-live="polite" aria-label="SNL setup status" style={{ minHeight: '1.25rem' }}>
        {busy ? 'Initializing SNL workspace…' : ''}
      </p>
    </main>
  );
}

function Initialized({
  overview,
  api,
  dataOperation,
  setupBusy,
  onStartSetup
}: {
  overview: SnlOverview;
  api: VsCodeApi | undefined;
  dataOperation: DataOperationStatus;
  setupBusy: boolean;
  onStartSetup: (type: SetupMessageType) => void;
}): React.ReactElement {
  // All sections default collapsed. State is local (per-mount) — cheap and
  // avoids workspaceState round-trips; users open what they care about.
  const [openLibraries, setOpenLibraries] = useState(false);
  const [openEntries, setOpenEntries] = useState(false);
  const [openRelationships, setOpenRelationships] = useState(false);
  const [openMacros, setOpenMacros] = useState(false);
  const [openEntryKinds, setOpenEntryKinds] = useState(false);
  const [openMacroKinds, setOpenMacroKinds] = useState(false);
  const [openDataMaintenance, setOpenDataMaintenance] = useState(false);

  const totalEntries =
    overview.totalEntryCount === null ? '—' : overview.totalEntryCount;
  const hasKinds = overview.entryKinds.length > 0;
  const hasMacroKinds = overview.macroKinds.length > 0;

  return (
    <main style={PANEL_STYLE} aria-busy={setupBusy}>
      <PanelHeader
        vsApi={api}
        title="SNL Dashboard"
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => api?.postMessage({ type: 'openInfoviewGraph' })}
              title="Open the pool-wide relationship graph"
            >
              View Graph
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => api?.postMessage({ type: 'openInfoview' })}
              title="Open the Infoview (reading surface)"
            >
              Open Infoview →
            </Button>
          </>
        }
      />
      <p role="status" aria-live="polite" aria-label="SNL setup status" style={{ minHeight: '1.25rem' }}>
        {setupBusy ? 'Initializing SNL workspace…' : ''}
      </p>
      <CollapsibleSection
        title="Data maintenance"
        subtitle={`${overview.dataStatus.currentVersion ?? 'unknown'} → ${overview.dataStatus.targetVersion}`}
        expanded={openDataMaintenance}
        onToggle={() => setOpenDataMaintenance((value) => !value)}
        headerActions={
          <>
            <HeaderActionButton
              label="Check data"
              title="Check data"
              disabled={dataOperation.status === 'running'}
              loading={dataOperation.status === 'running' && dataOperation.operation === 'check'}
              onClick={() => api?.postMessage({ type: 'checkDataVersion' })}
            />
            <HeaderActionButton
              label="Repair / migrate data"
              title="Repair / migrate data"
              disabled={dataOperation.status === 'running'}
              loading={dataOperation.status === 'running' && dataOperation.operation === 'repair'}
              onClick={() => api?.postMessage({ type: 'repairData' })}
            />
          </>
        }
      >
        <p style={{ margin: 0 }}>{overview.dataStatus.message}</p>
        {overview.dataStatus.pendingCount > 0 ? (
          <p style={{ marginBottom: 0 }}>
            {overview.dataStatus.pendingCount} pending migration step
            {overview.dataStatus.pendingCount === 1 ? '' : 's'}.
          </p>
        ) : null}
      </CollapsibleSection>
      {dataOperation.status === 'running' ? (
        <span
          role="status"
          aria-live="polite"
          style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
        >
          {dataOperation.operation === 'repair' ? 'Migration is running…' : 'Data check is running…'}
        </span>
      ) : dataOperation.status === 'error' ? (
        <p role="alert" style={{ margin: '0.5rem 0', color: 'var(--vscode-errorForeground)' }}>
          {dataOperation.message ?? 'Data operation failed.'}
        </p>
      ) : null}
      {/* === 1. Libraries ================================================== */}
      <CollapsibleSection
        title="Libraries"
        subtitle={`${overview.libraries.length} librar${
          overview.libraries.length === 1 ? 'y' : 'ies'
        }`}
        expanded={openLibraries}
        onToggle={() => setOpenLibraries((v) => !v)}
        headerActions={
          <HeaderActionButton
            label="+ Create Library"
            title="Open the Create Library panel"
            onClick={() => api?.postMessage({ type: 'createLibrary' })}
          />
        }
      >
        {overview.libraries.length > 0 ? (
          <LibrariesTable
            libraries={overview.libraries}
            onOpen={(slug) =>
              api?.postMessage({ type: 'editLibrary', slug })
            }
            onDelete={(slug) =>
              api?.postMessage({ type: 'deleteLibrary', slug })
            }
          />
        ) : null}
        <AddBar
          label="Create Library"
          onActivate={() => api?.postMessage({ type: 'createLibrary' })}
        />
      </CollapsibleSection>

      {/* === 2. Entries =================================================== */}
      <CollapsibleSection
        title="Entries"
        subtitle={`${totalEntries} entries in shared pool`}
        expanded={openEntries}
        onToggle={() => setOpenEntries((v) => !v)}
        headerActions={
          <>
            <HeaderActionButton
              label="+ Create Entry"
              title="Open the Create Entry panel"
              onClick={() => api?.postMessage({ type: 'createEntry' })}
            />
            <HeaderActionButton
              label="⌕ SNoogL: Entry Search"
              title="Open SNoogL panel focused on entry search"
              onClick={() =>
                api?.postMessage({ type: 'openSnoogL', mode: 'entry' })
              }
            />
          </>
        }
      >
        {overview.entries.length > 0 ? (
          <EntriesTable
            entries={overview.entries}
            kinds={overview.entryKinds}
            macroSources={overview.metricMacroSources}
            metricThresholds={overview.metricThresholds}
            onOpen={(id) => api?.postMessage({ type: 'editEntry', id })}
            onDelete={(id) =>
              api?.postMessage({ type: 'deleteEntry', id })
            }
          />
        ) : null}
        <AddBar
          label="Create Entry"
          onActivate={() => api?.postMessage({ type: 'createEntry' })}
        />
      </CollapsibleSection>

      {/* === 3. Relationships ============================================ */}
      <CollapsibleSection
        title="Relationships"
        subtitle={`${overview.relationships.length} edge${
          overview.relationships.length === 1 ? '' : 's'
        }`}
        expanded={openRelationships}
        onToggle={() => setOpenRelationships((v) => !v)}
      >
        {overview.relationships.length > 0 ? (
          <RelationshipsTable
            relationships={overview.relationships}
            entries={overview.entries}
            onOpen={(id) =>
              api?.postMessage({ type: 'editRelationship', id })
            }
            onDelete={(id) =>
              api?.postMessage({ type: 'deleteRelationship', id })
            }
          />
        ) : null}
        <AddBar
          label="Create Relationship"
          onActivate={() =>
            api?.postMessage({ type: 'createRelationship' })
          }
        />
        <AddBar
          label="⚙ Regenerate Dependencies from Macro Sources"
          onActivate={() =>
            api?.postMessage({ type: 'regenerateDependencies' })
          }
        />
      </CollapsibleSection>

      {/* === 4. SNL Macros ================================================ */}
      <CollapsibleSection
        title="SNL Macros"
        subtitle={`${overview.macroPackages.length} package${
          overview.macroPackages.length === 1 ? '' : 's'
        }`}
        expanded={openMacros}
        onToggle={() => setOpenMacros((v) => !v)}
        headerActions={
          <>
            <HeaderActionButton
              label="+ Create Macro"
              title="Pick a package and open the Create Macro editor"
              onClick={() =>
                api?.postMessage({ type: 'createMacroPickPackage' })
              }
            />
            <HeaderActionButton
              label="⌕ SNoogL: Macro Search"
              title="Open SNoogL panel focused on macro search"
              onClick={() =>
                api?.postMessage({ type: 'openSnoogL', mode: 'macro' })
              }
            />
          </>
        }
      >
        {overview.macroPackages.length > 0 ? (
          <MacroPackagesTable
            packages={overview.macroPackages}
            onOpen={(file) =>
              api?.postMessage({ type: 'openMacroPackage', file })
            }
            onSetActive={(file, active) =>
              api?.postMessage({ type: 'setPackageActive', file, active })
            }
            onDelete={(file) =>
              api?.postMessage({ type: 'deleteMacroPackage', file })
            }
          />
        ) : null}
        <AddBar
          label="Add Package"
          onActivate={() => api?.postMessage({ type: 'createMacroPackage' })}
        />
      </CollapsibleSection>

      {/* === 4. Entry Kinds =============================================== */}
      <CollapsibleSection
        title="Entry Kinds"
        subtitle={`${overview.entryKinds.length} kind${
          overview.entryKinds.length === 1 ? '' : 's'
        }`}
        expanded={openEntryKinds}
        onToggle={() => setOpenEntryKinds((v) => !v)}
      >
        {hasKinds ? (
          <EntryKindsTable
            kinds={overview.entryKinds}
            onOpen={(id) =>
              api?.postMessage({ type: 'editEntryKind', id })
            }
            onDelete={(id) =>
              api?.postMessage({ type: 'deleteEntryKind', id })
            }
          />
        ) : (
          <AddBar
            label="Initialize Entry Kinds"
            disabled={setupBusy}
            onActivate={() => onStartSetup('initEntryKinds')}
          />
        )}
        <AddBar
          label="Create Entry Kind"
          onActivate={() =>
            api?.postMessage({ type: 'createEntryKind' })
          }
        />
      </CollapsibleSection>

      {/* === 5. Macro Kinds =============================================== */}
      <CollapsibleSection
        title="SNL Macro Kinds"
        subtitle={`${overview.macroKinds.length} kind${
          overview.macroKinds.length === 1 ? '' : 's'
        }`}
        expanded={openMacroKinds}
        onToggle={() => setOpenMacroKinds((v) => !v)}
      >
        {hasMacroKinds ? (
          <MacroKindsTable
            kinds={overview.macroKinds}
            onOpen={(id) =>
              api?.postMessage({ type: 'editMacroKind', id })
            }
            onDelete={(id) =>
              api?.postMessage({ type: 'deleteMacroKind', id })
            }
          />
        ) : (
          <AddBar
            label="Initialize Macro Kinds"
            disabled={setupBusy}
            onActivate={() => onStartSetup('initMacroKinds')}
          />
        )}
        <AddBar
          label="Create Macro Kind"
          onActivate={() =>
            api?.postMessage({ type: 'createMacroKind' })
          }
        />
      </CollapsibleSection>
    </main>
  );
}

/**
 * A collapsible section wrapper. Header shows title + subtitle + chevron;
 * body is only rendered when `expanded` is true, so heavy tables don't pay
 * layout cost while collapsed.
 */
function CollapsibleSection({
  title,
  subtitle,
  expanded,
  onToggle,
  headerActions,
  children
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  /**
   * Optional inline actions rendered flush-right on the header row.
   * Cat 2026-07-13: some sections (Libraries, Entries, SNL Macros) want jump
   * buttons, such as Create Library / Create Entry / Create Macro / Open
   * SNoogL, reachable WITHOUT expanding the section. Buttons must call
   * `stopPropagation` on their own click handlers so the header
   * toggle doesn't fire when the user only meant to hit the button.
   */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          borderBottom:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))'
        }}
      >
        <Button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            display: 'flex',
            flex: 1,
            alignItems: 'baseline',
            gap: '0.6rem',
            padding: '0.4rem 0',
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
            fontSize: '1.05rem'
          }}
        >
          <span style={{ width: '0.9rem', opacity: 0.7 }}>
            {expanded ? '▾' : '▸'}
          </span>
          <span style={{ fontWeight: 600 }}>{title}</span>
          <span style={{ opacity: 0.7, fontSize: '0.9rem' }}>{subtitle}</span>
        </Button>
        {headerActions ? (
          <div
            style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {headerActions}
          </div>
        ) : null}
      </div>
      {expanded ? <div style={{ marginTop: '0.5rem' }}>{children}</div> : null}
    </section>
  );
}

/**
 * Compact action button sized for CollapsibleSection headers.
 * Distinct from `AddBar` (full-width, section body). Neutral look so
 * a row can carry 2-3 without dominating the header.
 */
function HeaderActionButton({
  label,
  title,
  onClick,
  disabled = false,
  loading = false
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
}): React.ReactElement {
  return (
    <Button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      disabled={disabled}
      loading={loading}
      loadingLabel={loading ? `${label}…` : undefined}
      style={{
        padding: '0.25rem 0.65rem',
        fontSize: '0.82rem',
        fontFamily: 'inherit',
        cursor: 'pointer',
        border:
          '1px solid var(--vscode-button-border, var(--vscode-contrastBorder, #555))',
        background:
          'var(--vscode-button-secondaryBackground, var(--vscode-input-background, #2a2a2a))',
        color:
          'var(--vscode-button-secondaryForeground, var(--vscode-foreground, inherit))',
        borderRadius: '3px'
      }}
    >
      {label}
    </Button>
  );
}

/**
 * (Removed 2026-07-13.) `OpenSnoogLBar` — a full-width jump button that
 * used to sit inside the expanded SNL Macros section — was replaced by
 * two per-section header buttons (Entries → SNoogL: Entry Search, SNL
 * Macros → SNoogL: Macro Search) so the search entry point is reachable
 * without expanding either section.
 */


 /**
  * Full-width primary "add" bar used as a section CTA. When a section's list
  * is empty the section shows only this bar as its call-to-action.
  */
 function AddBar({
  label,
  onActivate,
  disabled = false
}: {
  label: string;
  onActivate: () => void;
  disabled?: boolean;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={onActivate}
      onMouseEnter={() => { if (!disabled) setHover(true); }}
      onMouseLeave={() => setHover(false)}
      onFocus={() => { if (!disabled) setHover(true); }}
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
        padding: 0,
        borderRadius: '6px',
        border: hover
          ? '1.5px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))'
          : '2px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent',
        color: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: 'inherit',
        fontWeight: 600,
        userSelect: 'none'
      }}
    >
      <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>+</span>
      <span>{label}</span>
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
  libraries,
  onOpen,
  onDelete
}: {
  libraries: LibrarySummary[];
  onOpen: (slug: string) => void;
  onDelete: (slug: string) => void;
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
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {libraries.map((lib) => (
          <ClickableRow
            key={lib.slug}
            label={`Edit library ${lib.slug}`}
            onActivate={() => onOpen(lib.slug)}
            primaryCellIndex={0}
          >
            <td style={CELL}>{lib.title}</td>
            <td style={{ ...CELL, ...MONO }}>{lib.slug}</td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {lib.entryCount === null ? '—' : lib.entryCount}
            </td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {lib.relationshipCount === null ? '—' : lib.relationshipCount}
            </td>
            <RowDeleteCell
              label={`Delete library ${lib.slug}`}
              onDelete={() => onDelete(lib.slug)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

function MacroPackagesTable({
  packages,
  onOpen,
  onSetActive,
  onDelete
}: {
  packages: MacroPackageSummary[];
  onOpen: (file: string) => void;
  onSetActive: (file: string, active: boolean) => void;
  onDelete: (file: string) => void;
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
          <th style={{ ...HEAD, width: '4.5rem', textAlign: 'center' }}>Active</th>
          <th style={HEAD}>File</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>Macros</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {packages.map((pkg) => (
          <ClickableRow
            key={pkg.file}
            label={`Open macro package ${pkg.file}`}
            onActivate={() => onOpen(pkg.file)}
            primaryCellIndex={1}
          >
            <td style={{ ...CELL, textAlign: 'center' }}>
              <input
                type="checkbox"
                checked={pkg.active !== false}
                aria-label={`Toggle active state for ${pkg.file}`}
                title={
                  pkg.active !== false
                    ? 'Active — contributes macros to the workspace'
                    : 'Inactive — excluded from readAllMacros'
                }
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (shouldStopRowActivation(e.key)) e.stopPropagation();
                }}
                onChange={(e) => onSetActive(pkg.file, e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
            </td>
            <td style={{ ...CELL, ...MONO }}>{pkg.file}</td>
            <td style={{ ...CELL, textAlign: 'right' }}>
              {pkg.macroCount === null ? '—' : pkg.macroCount}
            </td>
            <RowDeleteCell
              label={`Delete macro package ${pkg.file}`}
              onDelete={() => onDelete(pkg.file)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Shared clickable-row wrapper. Clicking (or Enter/Space) fires `onActivate`;
 * hover / focus paint the row with the theme's list-hover background,
 * matching VS Code list affordances.
 */
/**
 * Trash-icon cell for a Dashboard table row. Placed inside a
 * {@link ClickableRow} — stopPropagation is critical because the surrounding
 * row treats any click as "open this entity", and we absolutely do not want
 * clicking Delete to also open the editor for the doomed row.
 *
 * Cat 2026-07-09: every entity type (entry / library / entry-kind /
 * macro-kind / macro-package) grows a matching Delete action. The confirm
 * modal + reference reporting lives in extension.ts commands; here we just
 * post the intent.
 */
function RowDeleteCell({
  onDelete,
  label
}: {
  onDelete: () => void;
  label: string;
}): React.ReactElement {
  return (
    <td
      style={{ ...CELL, textAlign: 'right', width: '2.5rem' }}
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        variant="destructive"
        size="sm"
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onKeyDown={(e) => {
          // Prevent the surrounding ClickableRow's Enter/Space handler
          // from firing when a user focuses this button via keyboard.
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
          }
        }}
      >
        ✕
      </Button>
    </td>
  );
}

function ClickableRow({
  label,
  onActivate,
  primaryCellIndex,
  children
}: {
  label: string;
  onActivate: () => void;
  primaryCellIndex: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const cells = React.Children.toArray(children) as React.ReactElement<{
    children?: React.ReactNode;
  }>[];
  const primaryCell = cells[primaryCellIndex];
  if (primaryCell) {
    cells[primaryCellIndex] = React.cloneElement(
      primaryCell,
      {},
      <RowPrimaryButton label={label} onActivate={onActivate}>
        {primaryCell.props.children}
      </RowPrimaryButton>
    );
  }
  return (
    <tr
      onClick={onActivate}
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
      {cells}
    </tr>
  );
}

function EntryKindsTable({
  kinds,
  onOpen,
  onDelete
}: {
  kinds: EntryKind[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
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
          <th style={HEAD}>Default Counter</th>
          <th style={HEAD}>Style</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <ClickableRow
            key={kind.id}
            label={`Edit entry kind ${kind.id}`}
            onActivate={() => onOpen(kind.id)}
            primaryCellIndex={1}
          >
            <td style={CELL}>
              <KindPreview
                stroke={kind.coloring.stroke}
                background={kind.coloring.background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={{ ...CELL, ...MONO }}>
              {kind.defaultCounterName ? kind.defaultCounterName : '—'}
            </td>
            <td style={{ ...CELL, ...MONO }}>
              {kind.style ? kind.style : '—'}
            </td>
            <RowDeleteCell
              label={`Delete entry kind ${kind.id}`}
              onDelete={() => onDelete(kind.id)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/** Macro-kinds catalog table for the Dashboard. */
function MacroKindsTable({
  kinds,
  onOpen,
  onDelete
}: {
  kinds: MacroKind[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
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
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <ClickableRow
            key={kind.id}
            label={`Edit macro kind ${kind.id}`}
            onActivate={() => onOpen(kind.id)}
            primaryCellIndex={1}
          >
            <td style={CELL}>
              <KindPreview
                stroke={kind.coloring.stroke}
                background={kind.coloring.background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={CELL}>{kind.description ? kind.description : '—'}</td>
            <RowDeleteCell
              label={`Delete macro kind ${kind.id}`}
              onDelete={() => onDelete(kind.id)}
            />
          </ClickableRow>
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
  kinds,
  macroSources,
  metricThresholds,
  onOpen,
  onDelete
}: {
  entries: EntryData[];
  kinds: EntryKind[];
  macroSources: SnlMacroSourceLookup;
  metricThresholds: EntryMetricThresholds;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const metricContext = useMemo(
    () => buildEntryMetricContext(entries),
    [entries]
  );
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
          <th style={{ ...HEAD, textAlign: 'center' }}>SNL Structural Index</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const kind = kinds.find((k) => k.id === entry.kind);
          const metrics = computeEntryMetrics(
            entry.content?.snl,
            macroSources,
            metricContext
          );
          return (
            <ClickableRow
              key={entry.id}
              label={`Edit entry ${entry.title}`}
              onActivate={() => onOpen(entry.id)}
              primaryCellIndex={1}
            >
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
              <td style={{ ...CELL, textAlign: 'center' }}>
                <EntryMetricValue
                  result={metrics}
                  metric="structuralIndex"
                  thresholds={metricThresholds}
                />
              </td>
              <RowDeleteCell
                label={`Delete entry ${entry.id}`}
                onDelete={() => onDelete(entry.id)}
              />
            </ClickableRow>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Relationships list for the Dashboard (cat 2026-07-10). Each row shows
 * id / from → to / label / metadata-preview. Endpoints resolve to entry
 * titles when available; a missing endpoint (entry deleted after the
 * relationship was written) renders in error color as a hint.
 */
function RelationshipsTable({
  relationships,
  entries,
  onOpen,
  onDelete
}: {
  relationships: RelationshipData[];
  entries: EntryData[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const titleById = new Map(entries.map((e) => [e.id, e.title || '(untitled)']));
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
          <th style={HEAD}>ID</th>
          <th style={HEAD}>From</th>
          <th style={HEAD}>→ To</th>
          <th style={HEAD}>Label</th>
          <th style={HEAD}>Metadata</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {relationships.map((r) => (
          <ClickableRow
            key={r.id}
            label={`Edit relationship ${r.id}`}
            onActivate={() => onOpen(r.id)}
            primaryCellIndex={0}
          >
            <td style={{ ...CELL, ...MONO }}>{r.id}</td>
            <td style={CELL}>
              <EndpointCell id={r.from} title={titleById.get(r.from)} />
            </td>
            <td style={CELL}>
              <EndpointCell id={r.to} title={titleById.get(r.to)} />
            </td>
            <td style={CELL}>{r.label}</td>
            <td style={{ ...CELL, ...MONO, opacity: 0.75 }}>
              {formatMetadataPreview(r.metadata)}
            </td>
            <RowDeleteCell
              label={`Delete relationship ${r.id}`}
              onDelete={() => onDelete(r.id)}
            />
          </ClickableRow>
        ))}
      </tbody>
    </table>
  );
}

/** id + resolved title (or ⚠ unknown badge when the endpoint is gone). */
function EndpointCell({
  id,
  title
}: {
  id: string;
  title: string | undefined;
}): React.ReactElement {
  if (!title) {
    return (
      <span
        title={`No entry with id "${id}" in the shared pool. The endpoint was likely deleted.`}
        style={{
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          color: 'var(--vscode-errorForeground, #f14c4c)'
        }}
      >
        ⚠ {id}
      </span>
    );
  }
  return (
    <span>
      <span style={{ ...MONO, marginRight: '0.4rem', opacity: 0.75 }}>
        {id}
      </span>
      <span>{title}</span>
    </span>
  );
}

/** One-line preview of the metadata blob for the table cell. */
function formatMetadataPreview(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    const s = JSON.stringify(v);
    if (s.length <= 48) return s;
    return `${s.slice(0, 45)}…`;
  } catch {
    return '(unserializable)';
  }
}
