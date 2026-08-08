import { resolveThemeColoring, type ThemeColoring } from './render/themeColoring';
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

import React, { useEffect, useMemo, useState } from 'react';
import { Button } from './components/Button';
import { IconButton } from './components/IconButton';
import { Icon } from './components/Icon';
import { EmptyAction } from './components/EmptyAction';
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
  useVsCodeApiRef,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { use_preferences_revision } from './runtime/preferencesRuntime';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';

const DASHBOARD_MESSAGES = defineUiMessages(
  'dashboard',
  {
    title: 'SNL Dashboard', loading: 'Loading project overview…', overviewLoadError: 'Could not load project overview: {message}', setupIntroBefore: 'This workspace does not have an', setupIntroAfter: 'folder yet. Create the skeleton alone, or initialize a standard Kind catalog as part of setup.',
    runInit: 'Run SNL: Init', initEntryKinds: 'Initialize Entry Kinds', initMacroKinds: 'Initialize Macro Kinds', setupStatus: 'SNL setup status', initializing: 'Initializing SNL workspace…',
    viewGraph: 'View Graph', viewGraphTitle: 'Open the pool-wide relationship graph', openInfoview: 'Open Infoview →', openInfoviewTitle: 'Open the Infoview (reading surface)',
    dataMaintenance: 'Data maintenance', dataNotChecked: 'Data version has not been checked yet.', unknown: 'unknown', checkData: 'Check data', repairData: 'Repair / migrate data', pendingMigrations: '{count} pending migration step(s).', migrationRunning: 'Migration is running…', checkRunning: 'Data check is running…', dataFailed: 'Data operation failed.',
    libraries: 'Libraries', libraryCount: { arg: 'count', one: '{count} library', other: '{count} libraries' }, createLibrary: 'Create Library', createLibraryHeader: '+ Create Library', createLibraryTitle: 'Open the Create Library panel',
    entries: 'Entries', entriesInPool: '{count} entries in shared pool', createEntry: 'Create Entry', createEntryHeader: '+ Create Entry', createEntryTitle: 'Open the Create Entry panel', entrySearch: '⌕ SNoogL: Entry Search', entrySearchTitle: 'Open SNoogL panel focused on entry search',
    relationships: 'Relationships', edgeCount: { arg: 'count', one: '{count} edge', other: '{count} edges' }, createRelationship: 'Create Relationship', regenerateDependencies: '⚙ Regenerate Dependencies from Macro Sources',
    macros: 'SNL Macros', packageCount: { arg: 'count', one: '{count} package', other: '{count} packages' }, createMacroHeader: '+ Create Macro', createMacroTitle: 'Pick a package and open the Create Macro editor', macroSearch: '⌕ SNoogL: Macro Search', macroSearchTitle: 'Open SNoogL panel focused on macro search', addPackage: 'Add Package',
    entryKinds: 'Entry Kinds', kindCount: { arg: 'count', one: '{count} kind', other: '{count} kinds' }, createEntryKind: 'Create Entry Kind', macroKinds: 'SNL Macro Kinds', createMacroKind: 'Create Macro Kind',
    colTitle: 'Title', colSlug: 'Slug', colEntries: 'Entries', colRelationships: 'Relationships', colActive: 'Active', colFile: 'File', colMacros: 'Macros', colPreview: 'Preview', colName: 'Name', colId: 'ID', colDefaultCounter: 'Default Counter', colStyle: 'Style', colDescription: 'Description', colKind: 'Kind', colFormats: 'Formats', colStructuralIndex: 'SNL Structural Index', colFrom: 'From', colTo: '→ To', colLabel: 'Label', colMetadata: 'Metadata',
    editLibrary: 'Edit library {id}', deleteLibrary: 'Delete library {id}', openPackage: 'Open macro package {id}', togglePackage: 'Toggle active state for {id}', activePackageTitle: 'Active — contributes macros to the workspace', inactivePackageTitle: 'Inactive — excluded from readAllMacros', deletePackage: 'Delete macro package {id}',
    editEntryKind: 'Edit entry kind {id}', deleteEntryKind: 'Delete entry kind {id}', editMacroKind: 'Edit macro kind {id}', deleteMacroKind: 'Delete macro kind {id}', colorTitle: 'stroke {stroke} / background {background}', editEntry: 'Edit entry {title}', deleteEntry: 'Delete entry {id}', unknownKindTitle: 'Unknown kind “{kind}” — no matching entry kind in config.json', unknownKind: '⚠ unknown', editRelationship: 'Edit relationship {id}', deleteRelationship: 'Delete relationship {id}', missingEndpoint: 'No entry with id “{id}” in the shared pool. The endpoint was likely deleted.', untitled: '(untitled)', unserializable: '(unserializable)'
  },
  {
    title: 'SNL 仪表板', loading: '正在加载项目概览…', overviewLoadError: '无法加载项目概览：{message}', setupIntroBefore: '此工作区尚无', setupIntroAfter: '文件夹。您可以仅创建基本目录，也可以在设置时一并初始化标准类别目录。',
    runInit: '运行 SNL：初始化', initEntryKinds: '初始化条目类别', initMacroKinds: '初始化宏类别', setupStatus: 'SNL 设置状态', initializing: '正在初始化 SNL 工作区…',
    viewGraph: '查看关系图', viewGraphTitle: '打开共享池的完整关系图', openInfoview: '打开信息视图 →', openInfoviewTitle: '打开信息视图（阅读界面）',
    dataMaintenance: '数据维护', dataNotChecked: '尚未检查数据版本。', unknown: '未知', checkData: '检查数据', repairData: '修复 / 迁移数据', pendingMigrations: '有 {count} 个迁移步骤待执行。', migrationRunning: '正在迁移…', checkRunning: '正在检查数据…', dataFailed: '数据操作失败。',
    libraries: '库', libraryCount: { arg: 'count', other: '{count} 个库' }, createLibrary: '创建库', createLibraryHeader: '+ 创建库', createLibraryTitle: '打开创建库面板',
    entries: '共享条目', entriesInPool: '共享池中有 {count} 个条目', createEntry: '创建条目', createEntryHeader: '+ 创建条目', createEntryTitle: '打开创建条目面板', entrySearch: '⌕ SNoogL：搜索条目', entrySearchTitle: '打开 SNoogL 面板并搜索条目',
    relationships: '关系', edgeCount: { arg: 'count', other: '{count} 条边' }, createRelationship: '创建关系', regenerateDependencies: '⚙ 根据宏来源重新生成依赖关系',
    macros: 'SNL 宏', packageCount: { arg: 'count', other: '{count} 个宏包' }, createMacroHeader: '+ 创建宏', createMacroTitle: '选择宏包并打开创建宏编辑器', macroSearch: '⌕ SNoogL：搜索宏', macroSearchTitle: '打开 SNoogL 面板并搜索宏', addPackage: '添加宏包',
    entryKinds: '条目类别', kindCount: { arg: 'count', other: '{count} 个类别' }, createEntryKind: '创建条目类别', macroKinds: 'SNL 宏类别', createMacroKind: '创建宏类别',
    colTitle: '标题', colSlug: '标识名', colEntries: '条目数', colRelationships: '关系数', colActive: '启用', colFile: '文件', colMacros: '宏数', colPreview: '预览', colName: '名称', colId: 'ID', colDefaultCounter: '默认计数器', colStyle: '样式', colDescription: '说明', colKind: '类别', colFormats: '格式', colStructuralIndex: 'SNL 结构指数', colFrom: '起点', colTo: '→ 终点', colLabel: '标签', colMetadata: '元数据',
    editLibrary: '编辑库 {id}', deleteLibrary: '删除库 {id}', openPackage: '打开宏包 {id}', togglePackage: '切换 {id} 的启用状态', activePackageTitle: '已启用——向工作区提供宏', inactivePackageTitle: '未启用——不包含在 readAllMacros 中', deletePackage: '删除宏包 {id}',
    editEntryKind: '编辑条目类别 {id}', deleteEntryKind: '删除条目类别 {id}', editMacroKind: '编辑宏类别 {id}', deleteMacroKind: '删除宏类别 {id}', colorTitle: '描边 {stroke} / 背景 {background}', editEntry: '编辑条目 {title}', deleteEntry: '删除条目 {id}', unknownKindTitle: '未知类别“{kind}”——config.json 中没有匹配的条目类别', unknownKind: '⚠ 未知', editRelationship: '编辑关系 {id}', deleteRelationship: '删除关系 {id}', missingEndpoint: '共享池中没有 ID 为“{id}”的条目；该端点可能已被删除。', untitled: '（无标题）', unserializable: '（无法序列化）'
  }
);

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
  coloring: ThemeColoring;
  defaultCounterName: string;
  style: string;
}

interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: ThemeColoring;
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
  /** TEMPORARY: exactly one Contributor string; this shape may change. */
  contribution_info?: string | null;
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
    message: ''
  }
};

export function DashboardApp(): React.ReactElement {
  use_preferences_revision();
  const t = useUiMessages(DASHBOARD_MESSAGES);
  const [overview, setOverview] = useState<SnlOverview>(EMPTY);
  const [dataOperation, setDataOperation] = useState<DataOperationStatus>({ status: 'idle' });
  const [setupBusy, setSetupBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const apiRef = useVsCodeApiRef();

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'overview'; overview: SnlOverview }
        | ({ type: 'dataMigrationStatus' } & DataOperationStatus)
        | { type: 'setupStatus'; status: 'idle' | 'running' }
        | { type: 'overviewError'; message: string }
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
      if (msg.type === 'overviewError') {
        setLoadError(msg.message);
        setLoaded(true);
        return;
      }
      if (msg.type !== 'overview') return;
      setLoadError(null);
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
        <PanelHeader vsApi={apiRef.current} title={t('title')} />
        <p style={{ opacity: 0.7 }}>{t('loading')}</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main style={PANEL_STYLE}>
        <PanelHeader vsApi={apiRef.current} title={t('title')} />
        <p role="alert" style={{ color: 'var(--vscode-errorForeground)' }}>
          {t('overviewLoadError', { message: loadError })}
        </p>
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
  return (
    <main style={PANEL_STYLE} aria-busy={busy}>
      <PanelHeader vsApi={api} title={t('title')} />
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        {t('setupIntroBefore')} <code>.SNL_Doc/</code> {t('setupIntroAfter')}
      </p>
      <Button
        type="button"
        onClick={() => onStart('init')}
        disabled={busy}
        variant="primary"
      >
        {t('runInit')}
      </Button>
      <p role="status" aria-live="polite" aria-label={t('setupStatus')} style={{ minHeight: '1.25rem' }}>
        {busy ? t('initializing') : ''}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
  // All sections default collapsed. State is local (per-mount) — cheap and
  // avoids workspaceState round-trips; users open what they care about.
  const [openLibraries, setOpenLibraries] = useState(false);
  const [openEntries, setOpenEntries] = useState(false);
  const [openRelationships, setOpenRelationships] = useState(false);
  const [openMacros, setOpenMacros] = useState(false);
  const [openEntryKinds, setOpenEntryKinds] = useState(false);
  const [openMacroKinds, setOpenMacroKinds] = useState(false);

  const totalEntries =
    overview.totalEntryCount === null ? '—' : overview.totalEntryCount;
  const hasKinds = overview.entryKinds.length > 0;
  const hasMacroKinds = overview.macroKinds.length > 0;

  return (
    <main style={PANEL_STYLE} aria-busy={setupBusy}>
      <PanelHeader
        vsApi={api}
        title={t('title')}
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => api?.postMessage({ type: 'openInfoviewGraph' })}
              title={t('viewGraphTitle')}
            >
              {t('viewGraph')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => api?.postMessage({ type: 'openInfoview' })}
              title={t('openInfoviewTitle')}
            >
              {t('openInfoview')}
            </Button>
          </>
        }
      />
      <p role="status" aria-live="polite" aria-label={t('setupStatus')} style={{ minHeight: '1.25rem' }}>
        {setupBusy ? t('initializing') : ''}
      </p>
      <StaticSection
        title={t('dataMaintenance')}
        subtitle={`${overview.dataStatus.currentVersion ?? t('unknown')} → ${overview.dataStatus.targetVersion}`}
        headerActions={
          <>
            <HeaderActionButton
              label={t('checkData')}
              title={t('checkData')}
              disabled={dataOperation.status === 'running'}
              loading={dataOperation.status === 'running' && dataOperation.operation === 'check'}
              onClick={() => api?.postMessage({ type: 'checkDataVersion' })}
            />
            <HeaderActionButton
              label={t('repairData')}
              title={t('repairData')}
              disabled={dataOperation.status === 'running'}
              loading={dataOperation.status === 'running' && dataOperation.operation === 'repair'}
              onClick={() => api?.postMessage({ type: 'repairData' })}
            />
          </>
        }
      >
        <p style={{ margin: 0 }}>{overview.dataStatus.message || t('dataNotChecked')}</p>
        {overview.dataStatus.pendingCount > 0 ? (
          <p style={{ marginBottom: 0 }}>
            {t('pendingMigrations', { count: overview.dataStatus.pendingCount })}
          </p>
        ) : null}
      </StaticSection>
      {dataOperation.status === 'running' ? (
        <span
          role="status"
          aria-live="polite"
          style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
        >
          {dataOperation.operation === 'repair' ? t('migrationRunning') : t('checkRunning')}
        </span>
      ) : dataOperation.status === 'error' ? (
        <p role="alert" style={{ margin: '0.5rem 0', color: 'var(--vscode-errorForeground)' }}>
          {dataOperation.message ?? t('dataFailed')}
        </p>
      ) : null}
      {/* === 1. Libraries ================================================== */}
      <CollapsibleSection
        title={t('libraries')}
        subtitle={t('libraryCount', { count: overview.libraries.length })}
        expanded={openLibraries}
        onToggle={() => setOpenLibraries((v) => !v)}
        headerActions={
          <HeaderActionButton
            label={t('createLibraryHeader')}
            title={t('createLibraryTitle')}
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
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('createLibrary')}
          onClick={() => api?.postMessage({ type: 'createLibrary' })}
        />
      </CollapsibleSection>

      {/* === 2. Entries =================================================== */}
      <CollapsibleSection
        title={t('entries')}
        subtitle={t('entriesInPool', { count: totalEntries })}
        expanded={openEntries}
        onToggle={() => setOpenEntries((v) => !v)}
        headerActions={
          <>
            <HeaderActionButton
              label={t('createEntryHeader')}
              title={t('createEntryTitle')}
              onClick={() => api?.postMessage({ type: 'createEntry' })}
            />
            <HeaderActionButton
              label={t('entrySearch')}
              title={t('entrySearchTitle')}
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
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('createEntry')}
          onClick={() => api?.postMessage({ type: 'createEntry' })}
        />
      </CollapsibleSection>

      {/* === 3. Relationships ============================================ */}
      <CollapsibleSection
        title={t('relationships')}
        subtitle={t('edgeCount', { count: overview.relationships.length })}
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
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('createRelationship')}
          onClick={() =>
            api?.postMessage({ type: 'createRelationship' })
          }
        />
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('regenerateDependencies')}
          onClick={() =>
            api?.postMessage({ type: 'regenerateDependencies' })
          }
        />
      </CollapsibleSection>

      {/* === 4. SNL Macros ================================================ */}
      <CollapsibleSection
        title={t('macros')}
        subtitle={t('packageCount', { count: overview.macroPackages.length })}
        expanded={openMacros}
        onToggle={() => setOpenMacros((v) => !v)}
        headerActions={
          <>
            <HeaderActionButton
              label={t('createMacroHeader')}
              title={t('createMacroTitle')}
              onClick={() =>
                api?.postMessage({ type: 'createMacroPickPackage' })
              }
            />
            <HeaderActionButton
              label={t('macroSearch')}
              title={t('macroSearchTitle')}
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
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('addPackage')}
          onClick={() => api?.postMessage({ type: 'createMacroPackage' })}
        />
      </CollapsibleSection>

      {/* === 4. Entry Kinds =============================================== */}
      <CollapsibleSection
        title={t('entryKinds')}
        subtitle={t('kindCount', { count: overview.entryKinds.length })}
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
          <EmptyAction size="lg" className="snl-empty-action--large"
            label={t('initEntryKinds')}
            disabled={setupBusy}
            onClick={() => onStartSetup('initEntryKinds')}
          />
        )}
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('createEntryKind')}
          onClick={() =>
            api?.postMessage({ type: 'createEntryKind' })
          }
        />
      </CollapsibleSection>

      {/* === 5. Macro Kinds =============================================== */}
      <CollapsibleSection
        title={t('macroKinds')}
        subtitle={t('kindCount', { count: overview.macroKinds.length })}
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
          <EmptyAction size="lg" className="snl-empty-action--large"
            label={t('initMacroKinds')}
            disabled={setupBusy}
            onClick={() => onStartSetup('initMacroKinds')}
          />
        )}
        <EmptyAction size="lg" className="snl-empty-action--large"
          label={t('createMacroKind')}
          onClick={() =>
            api?.postMessage({ type: 'createMacroKind' })
          }
        />
      </CollapsibleSection>
    </main>
  );
}

function StaticSection({
  title,
  subtitle,
  headerActions,
  children
}: {
  title: string;
  subtitle: string;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0', borderBottom: '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))' }}>
        <span style={{ fontWeight: 600, fontSize: '1.05rem' }}>{title}</span>
        <span style={{ opacity: 0.7, fontSize: '0.9rem' }}>{subtitle}</span>
        {headerActions ? <div style={{ display: 'flex', gap: '0.35rem', marginLeft: 'auto' }}>{headerActions}</div> : null}
      </div>
      <div style={{ marginTop: '0.5rem' }}>{children}</div>
    </section>
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
            justifyContent: 'flex-start',
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
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
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
          <th style={HEAD}>{t('colTitle')}</th>
          <th style={HEAD}>{t('colSlug')}</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>{t('colEntries')}</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>{t('colRelationships')}</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {libraries.map((lib) => (
          <ClickableRow
            key={lib.slug}
            label={t('editLibrary', { id: lib.slug })}
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
              label={t('deleteLibrary', { id: lib.slug })}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
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
          <th style={{ ...HEAD, width: '4.5rem', textAlign: 'center' }}>{t('colActive')}</th>
          <th style={HEAD}>{t('colFile')}</th>
          <th style={{ ...HEAD, textAlign: 'right' }}>{t('colMacros')}</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {packages.map((pkg) => (
          <ClickableRow
            key={pkg.file}
            label={t('openPackage', { id: pkg.file })}
            onActivate={() => onOpen(pkg.file)}
            primaryCellIndex={1}
          >
            <td style={{ ...CELL, textAlign: 'center' }}>
              <input
                type="checkbox"
                checked={pkg.active !== false}
                aria-label={t('togglePackage', { id: pkg.file })}
                title={
                  pkg.active !== false
                    ? t('activePackageTitle')
                    : t('inactivePackageTitle')
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
              label={t('deletePackage', { id: pkg.file })}
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
      <IconButton
        icon="delete"
        label={label}
        variant="destructive"
        size="sm"
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
      />
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
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
          <th style={{ ...HEAD, width: '5.5rem' }}>{t('colPreview')}</th>
          <th style={HEAD}>{t('colName')}</th>
          <th style={HEAD}>{t('colId')}</th>
          <th style={HEAD}>{t('colDefaultCounter')}</th>
          <th style={HEAD}>{t('colStyle')}</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <ClickableRow
            key={kind.id}
            label={t('editEntryKind', { id: kind.id })}
            onActivate={() => onOpen(kind.id)}
            primaryCellIndex={1}
          >
            <td style={CELL}>
              <KindPreview
                stroke={resolveThemeColoring(kind.coloring).stroke}
                background={resolveThemeColoring(kind.coloring).background}
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
              label={t('deleteEntryKind', { id: kind.id })}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
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
          <th style={{ ...HEAD, width: '5.5rem' }}>{t('colPreview')}</th>
          <th style={HEAD}>{t('colName')}</th>
          <th style={HEAD}>{t('colId')}</th>
          <th style={HEAD}>{t('colDescription')}</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {kinds.map((kind) => (
          <ClickableRow
            key={kind.id}
            label={t('editMacroKind', { id: kind.id })}
            onActivate={() => onOpen(kind.id)}
            primaryCellIndex={1}
          >
            <td style={CELL}>
              <KindPreview
                stroke={resolveThemeColoring(kind.coloring).stroke}
                background={resolveThemeColoring(kind.coloring).background}
              />
            </td>
            <td style={CELL}>{kind.name}</td>
            <td style={{ ...CELL, ...MONO }}>{kind.id}</td>
            <td style={CELL}>{kind.description ? kind.description : '—'}</td>
            <RowDeleteCell
              label={t('deleteMacroKind', { id: kind.id })}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
  return (
    <span
      title={t('colorTitle', { stroke, background })}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
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
          <th style={{ ...HEAD, width: '3.5rem' }}>{t('colPreview')}</th>
          <th style={HEAD}>{t('colTitle')}</th>
          <th style={HEAD}>{t('colId')}</th>
          <th style={HEAD}>{t('colKind')}</th>
          <th style={HEAD}>{t('colFormats')}</th>
          <th style={{ ...HEAD, textAlign: 'center' }}>{t('colStructuralIndex')}</th>
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
              label={t('editEntry', { title: entry.title })}
              onActivate={() => onOpen(entry.id)}
              primaryCellIndex={1}
            >
              <td style={CELL}>
                <KindPreview
                  stroke={kind ? resolveThemeColoring(kind.coloring).stroke : '#888888'}
                  background={kind ? resolveThemeColoring(kind.coloring).background : '#f0f0f0'}
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
                    title={t('unknownKindTitle', { kind: entry.kind })}
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
                    {t('unknownKind')}
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
                label={t('deleteEntry', { id: entry.id })}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
  const titleById = new Map(entries.map((e) => [e.id, e.title || t('untitled')]));
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
          <th style={HEAD}>{t('colId')}</th>
          <th style={HEAD}>{t('colFrom')}</th>
          <th style={HEAD}>{t('colTo')}</th>
          <th style={HEAD}>{t('colLabel')}</th>
          <th style={HEAD}>{t('colMetadata')}</th>
          <th style={{ ...HEAD, textAlign: 'right', width: '2.5rem' }} />
        </tr>
      </thead>
      <tbody>
        {relationships.map((r) => (
          <ClickableRow
            key={r.id}
            label={t('editRelationship', { id: r.id })}
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
              {formatMetadataPreview(r.metadata, t('unserializable'))}
            </td>
            <RowDeleteCell
              label={t('deleteRelationship', { id: r.id })}
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
  const t = useUiMessages(DASHBOARD_MESSAGES);
  if (!title) {
    return (
      <span
        title={t('missingEndpoint', { id })}
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
function formatMetadataPreview(v: unknown, unserializable: string): string {
  if (v === null || v === undefined) return '—';
  try {
    const s = JSON.stringify(v);
    if (s.length <= 48) return s;
    return `${s.slice(0, 45)}…`;
  } catch {
    return unserializable;
  }
}
