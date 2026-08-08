import { resolveThemeColoring, type ThemeColoring } from './render/themeColoring';
// SNL Macro Package panel webview: lists the macros in one package file and
// offers a big-plus "+ Create Macro" bar. Each row shows a real KaTeX Preview
// (macro applied to numbered argument placeholders — same style as the
// CreateMacro editor's Live Preview) plus name / arity / modes / kind /
// styles / description columns.
//
// Preview strategy: build ONE preview macro DB per package load
// (workspace macros + shared argument placeholders + package macros) and
// pass it to every row. Each row constructs a syntax tree `{ macro.name,
// [placeholder_0, placeholder_1, ...] }` sized by max #N in the default
// style's template (fixed arity) or a fixed count (variadic). Row-level
// try/catch keeps a bad macro from crashing the whole table.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
import './create-macro.css';
import {
  defaultRenderHooks,
  SnlSyntaxTreeView,
  resolve_style_template,
  type SnlMacroStyle,
  type MacroDataDriver,
  type SnlSyntaxTree,
  type SnlRenderHooks,
  type KindPalette
} from '@sjtu-ai4math/snl-basics';
import {
  createMacroDataDriver,
  type MacroRecord
} from './render/macroData';
import { wireMacroToRenderable } from './render/macroWire';
import {
  MACRO_PREVIEW_ARGUMENTS,
  MAX_MACRO_PREVIEW_ARGS,
  macroPreviewArgumentNode,
  maxMacroTemplateChildIndex
} from './render/macroPreviewPlaceholders';
import {
  useVsCodeApiRef,
  PANEL_STYLE
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { Button } from './components/Button';
import { IconButton } from './components/IconButton';
import { EmptyAction } from './components/EmptyAction';
import { RowPrimaryButton } from './components/RowPrimaryButton';
import { shouldStopRowActivation } from './components/interactionModel';
import { macroKindsToPalette } from './render/macroKindPalette';
import { extensionRenderers } from './render/blockRenderers';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import {
  use_preferences_revision,
  webview_language_runtime
} from './runtime/preferencesRuntime';

const PACKAGE_MESSAGES = defineUiMessages(
  'packagePanel',
  {
    panelTitle: 'SNL Macro Package', dashboard: 'Dashboard', backDashboard: 'Back to Dashboard', loading: 'Loading package…', noFile: 'The package file {file} does not exist (yet).', macroCount: { arg: 'count', one: '{file} · {count} macro', other: '{file} · {count} macros' },
    deletedMacros: { arg: 'count', one: 'Deleted {count} macro.', other: 'Deleted {count} macros.' }, transferredMacros: '{verb} {count} macro(s) to {file}.', createdAndTransferred: 'Created package {file} and {verb} {count} macro(s) into it.', copiedPast: 'Copied', movedPast: 'Moved',
    exitSelectTitle: 'Exit multi-select mode', enterSelectTitle: 'Select macros for batch operations', cancel: 'Cancel', select: 'Select', editPackageTitle: 'Edit package name / description', editPackage: 'Edit package', empty: 'No macros yet — use the bar below to create the first one.', createMacro: 'Create Macro', active: 'Active', inactive: 'Inactive', deactivateTitle: 'Deactivate this package (remove from active_macro_packages)', activateTitle: 'Activate this package (add to active_macro_packages)', toggle: 'Toggle', dynamic: 'dynamic',
    colPreview: 'Preview', colName: 'Name', colArity: 'Arity', srcTitle: 'Src status. 🟢 has entry src and it resolves in the pool. 🟡 has entry src but unresolved, OR only url srcs. 🔴 no src declared.', colSrc: 'Src', colMode: 'Mode', colKind: 'Kind', colStyle: 'Style', colMacroTags: 'Macro Tags', colStyleTags: 'Style Tags', colDescription: 'Description', colActions: 'Actions',
    selectMacro: 'Select macro {name}', deselectMacro: 'Deselect macro {name}', editMacro: 'Edit macro {name}', editMacroStyle: 'Edit macro {name} — style {style}', collapseStyles: 'Collapse styles', expandStyles: 'Expand styles', collapseRows: 'Collapse this macro’s style rows', moreRows: { arg: 'count', one: 'Show {count} more style row', other: 'Show {count} more style rows' }, defaultStyle: 'Default style', untagged: '(untagged)', copyMacro: 'Copy macro {name}', copy: 'Copy', deleteMacro: 'Delete macro {name}', sameAsDefault: 'same as default', noKind: 'No matching macro kind in the catalog', colorTitle: 'stroke {stroke} / background {background}',
    selectedCount: '{count} selected', transferTitle: 'Copy or move the selected macros to another package', transfer: 'Copy / Move…', delete: 'Delete', dismiss: 'Dismiss', transferHeading: 'Copy / Move macros', transferMode: 'Transfer mode', move: 'Move', copyModeTitle: 'Copy selected macros — source package left unchanged', moveModeTitle: 'Move selected macros — removed from source package', transferSummaryNew: '{verb} the {count} selected macro(s) into a brand-new package.', transferSummaryExisting: '{verb} the {count} selected macro(s) to the selected package.', moveEffect: 'They will be removed from this package.', copyEffect: 'The source package is left unchanged.', destination: 'Destination package', createNew: '— Create new package —', newFile: 'New package file name (letters, digits, - and _ only)', filePlaceholder: 'my_new_package', invalidFile: 'Only letters, digits, hyphen and underscore are allowed.', displayName: 'Display name (optional)', displayNamePlaceholder: 'Package display name', description: 'Description (optional)', transferIntoNew: '{verb} into new package',
    resolvedEntries: '{count} entry src(s) resolved: {ids}', unresolved: '{count} unresolved: {ids}', urlSources: '{count} url src(s)', missingEntries: '{count} entry src(s) NOT in pool: {ids}', urlSourcesWithIds: '{count} url src(s): {ids}', noSource: 'No src declared (neither entry nor url).', srcStatus: 'Src status: {color}', green: 'green', yellow: 'yellow', red: 'red'
  },
  {
    panelTitle: 'SNL 宏包', dashboard: '仪表板', backDashboard: '返回仪表板', loading: '正在加载宏包…', noFile: '宏包文件 {file} 尚不存在。', macroCount: { arg: 'count', other: '{file} · {count} 个宏' },
    deletedMacros: { arg: 'count', other: '已删除 {count} 个宏。' }, transferredMacros: '已将 {count} 个宏{verb}到 {file}。', createdAndTransferred: '已创建宏包 {file}，并将 {count} 个宏{verb}到其中。', copiedPast: '复制', movedPast: '移动',
    exitSelectTitle: '退出多选模式', enterSelectTitle: '选择要批量操作的宏', cancel: '取消', select: '选择', editPackageTitle: '编辑宏包名称 / 说明', editPackage: '编辑宏包', empty: '暂无宏——请使用下方按钮创建第一个宏。', createMacro: '创建宏', active: '启用', inactive: '未启用', deactivateTitle: '停用此宏包（从 active_macro_packages 中移除）', activateTitle: '启用此宏包（添加到 active_macro_packages）', toggle: '切换', dynamic: '动态',
    colPreview: '预览', colName: '名称', colArity: '元数', srcTitle: '来源状态：🟢 条目来源存在且可在共享池中解析；🟡 条目来源无法解析或只有 URL 来源；🔴 未声明来源。', colSrc: '来源', colMode: '模式', colKind: '类别', colStyle: '样式', colMacroTags: '宏标签', colStyleTags: '样式标签', colDescription: '说明', colActions: '操作',
    selectMacro: '选择宏 {name}', deselectMacro: '取消选择宏 {name}', editMacro: '编辑宏 {name}', editMacroStyle: '编辑宏 {name} — 样式 {style}', collapseStyles: '收起样式', expandStyles: '展开样式', collapseRows: '收起此宏的样式行', moreRows: { arg: 'count', other: '再显示 {count} 个样式行' }, defaultStyle: '默认样式', untagged: '（未标记）', copyMacro: '复制宏 {name}', copy: '复制', deleteMacro: '删除宏 {name}', sameAsDefault: '与默认值相同', noKind: '类别目录中没有匹配的宏类别', colorTitle: '描边 {stroke} / 背景 {background}',
    selectedCount: '已选择 {count} 个', transferTitle: '将所选宏复制或移动到其他宏包', transfer: '复制 / 移动…', delete: '删除', dismiss: '关闭', transferHeading: '复制 / 移动宏', transferMode: '传输模式', move: '移动', copyModeTitle: '复制所选宏——源宏包保持不变', moveModeTitle: '移动所选宏——将从源宏包中移除', transferSummaryNew: '将 {count} 个所选宏{verb}到全新宏包。', transferSummaryExisting: '将 {count} 个所选宏{verb}到选定宏包。', moveEffect: '这些宏将从当前宏包中移除。', copyEffect: '源宏包保持不变。', destination: '目标宏包', createNew: '— 创建新宏包 —', newFile: '新宏包文件名（仅限字母、数字、- 和 _）', filePlaceholder: 'my_new_package', invalidFile: '只能使用字母、数字、连字符和下划线。', displayName: '显示名称（可选）', displayNamePlaceholder: '宏包显示名称', description: '说明（可选）', transferIntoNew: '{verb}到新宏包',
    resolvedEntries: '已解析 {count} 个条目来源：{ids}', unresolved: '{count} 个未解析：{ids}', urlSources: '{count} 个 URL 来源', missingEntries: '共享池中不存在的 {count} 个条目来源：{ids}', urlSourcesWithIds: '{count} 个 URL 来源：{ids}', noSource: '未声明来源（既无条目也无 URL）。', srcStatus: '来源状态：{color}', green: '正常', yellow: '警告', red: '缺失'
  }
);

// Extended, on-disk macro shape (v6) — a superset of the library's render-only
// `SnlMacro`. It keeps the consumer-owned output backends (typst / latex /
// markdown / text) that this panel reads back, *per style*.
// v6: `mode` is 4 flat values (formula_inline/formula_display/text/block),
// no `display` axis; `dynamic_arity: boolean` replaces `arity`; variadic
// delimiters are 3 optional strings; per-macro + per-style `tags`.
interface MacroStyleBackends {
  typst?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  latex?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  markdown?: string;
  text?: string;
}
type MacroPackageStyle =
  | (Extract<SnlMacroStyle, { mode: 'text' }> & MacroStyleBackends)
  | (Exclude<SnlMacroStyle, { mode: 'text' }> & MacroStyleBackends);

export interface MacroPackageEntry {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind?: string;
  dynamic_arity: boolean;
  default_style: Record<string, string>;
  styles: MacroPackageStyle[];
  tags: string[];
}

export interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: ThemeColoring;
}

interface MacroPackageFile {
  version: string;
  name: string;
  description?: string;
  macros: Record<string, Omit<MacroPackageEntry, 'name'>>;
}

type Incoming =
  | {
      type: 'package';
      pkg: MacroPackageFile;
      file: string;
      macros: MacroPackageEntry[];
      workspaceMacros?: Record<string, MacroPackageEntry>;
      macroKinds?: MacroKind[];
      otherPackages?: Array<{ file: string; name: string }>;
      active?: boolean;
      entryPoolIds?: string[];
    }
  | { type: 'noFile'; file: string }
  | { type: 'batchCancelled' }
  | { type: 'error'; message: string }
  | undefined;

type Model =
  | { kind: 'loading' }
  | {
      kind: 'package';
      pkg: MacroPackageFile;
      file: string;
      macros: MacroPackageEntry[];
      workspaceMacros: Record<string, MacroPackageEntry>;
      macroKinds: MacroKind[];
      otherPackages: Array<{ file: string; name: string }>;
      active: boolean;
      entryPoolIds: Set<string>;
    }
  | { kind: 'noFile'; file: string }
  | { kind: 'error'; message: string };

/** Bare-filename rule shared with the host (`MACRO_FILE_RE`). */
const BARE_FILE_RE = /^[a-zA-Z0-9_-]+$/;

/** A transient toast surfaced after a batch action completes. */
interface Toast {
  kind: 'success' | 'error';
  message: string;
}

/** Which batch modal is currently open (null = none). */
type ActiveModal = 'transfer' | null;

// ---------------------------------------------------------------------------
// Preview constants — mirror the CreateMacro Live Preview so a package row's
// preview matches what the user sees while editing that macro.
// ---------------------------------------------------------------------------

const VARIADIC_PREVIEW_ARGS = 3;

export function PackagePanelApp(): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  use_preferences_revision();
  const [model, setModel] = useState<Model>({ kind: 'loading' });
  const [mode, setMode] = useState<'normal' | 'multiselect'>('normal');
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const apiRef = useVsCodeApiRef();
  // A pending batch action awaits either a fresh 'package' push (success) or
  // an 'error' message (failure) from the host so we can toast the outcome.
  const pendingActionRef = useRef<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (t: Toast): void => {
    setToast(t);
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => setToast(null), 4500);
  };

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'package': {
          setModel({
            kind: 'package',
            pkg: msg.pkg,
            file: msg.file,
            macros: Array.isArray(msg.macros) ? msg.macros : [],
            workspaceMacros: msg.workspaceMacros && typeof msg.workspaceMacros === 'object'
              ? msg.workspaceMacros
              : {},
            macroKinds: Array.isArray(msg.macroKinds) ? msg.macroKinds : [],
            otherPackages: Array.isArray(msg.otherPackages)
              ? msg.otherPackages
              : [],
            active: msg.active !== false,
            entryPoolIds: new Set(
              Array.isArray(msg.entryPoolIds) ? msg.entryPoolIds : []
            )
          });
          // A refresh following a batch action means it succeeded: toast,
          // exit multi-select, and clear the selection.
          const pending = pendingActionRef.current;
          if (pending) {
            pendingActionRef.current = null;
            showToast({ kind: 'success', message: pending });
            setMode('normal');
            setSelectedNames(new Set());
            setActiveModal(null);
          }
          break;
        }
        case 'noFile':
          setModel({ kind: 'noFile', file: msg.file });
          break;
        case 'batchCancelled':
          pendingActionRef.current = null;
          break;
        case 'error':
          // A batch failure keeps the panel intact — surface a toast and let
          // the user retry. Only a load-time error (no package yet) is fatal.
          if (pendingActionRef.current !== null) {
            pendingActionRef.current = null;
            showToast({ kind: 'error', message: msg.message });
          } else {
            setModel((prev) =>
              prev.kind === 'package'
                ? prev
                : { kind: 'error', message: msg.message }
            );
            showToast({ kind: 'error', message: msg.message });
          }
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createMacro = (): void =>
    apiRef.current?.postMessage({ type: 'createMacro' });
  const editMacroPackage = (): void =>
    apiRef.current?.postMessage({ type: 'editMacroPackage' });
  const editMacro = (name: string): void =>
    apiRef.current?.postMessage({ type: 'editMacro', name });
  const copyMacro = (name: string): void =>
    apiRef.current?.postMessage({ type: 'copyMacro', name });
  const setPackageActive = (active: boolean): void =>
    apiRef.current?.postMessage({ type: 'setPackageActive', active });

  const enterSelect = (): void => {
    setMode('multiselect');
    setSelectedNames(new Set());
    setActiveModal(null);
  };
  const cancelSelect = (): void => {
    setMode('normal');
    setSelectedNames(new Set());
    setActiveModal(null);
  };
  const toggleSelect = (name: string): void => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const submitBatchDelete = (): void => {
    const names = Array.from(selectedNames);
    if (names.length === 0) return;
    // Cat 2026-07-09: modal confirm is host-side (window.confirm is
    // CSP-blocked in VS Code webviews and silently returned undefined
    // here, so this branch never showed a prompt). Host sees the intent
    // via the batchDelete message and prompts before mutating.
    pendingActionRef.current = t('deletedMacros', { count: names.length });
    apiRef.current?.postMessage({ type: 'batchDelete', macroNames: names });
  };

  const deleteMacro = (name: string): void => {
    pendingActionRef.current = t('deletedMacros', { count: 1 });
    apiRef.current?.postMessage({ type: 'batchDelete', macroNames: [name] });
  };

  const submitBatchTransfer = (params: {
    mode: 'copy' | 'move';
    target: 'existing' | 'new';
    destFile?: string;
    newFile?: string;
    newDisplayName?: string;
    newDescription?: string;
  }): void => {
    const names = Array.from(selectedNames);
    if (names.length === 0) return;
    const verbPast = params.mode === 'move' ? t('movedPast') : t('copiedPast');
    if (params.target === 'existing') {
      if (!params.destFile) return;
      pendingActionRef.current = t('transferredMacros', { verb: verbPast, count: names.length, file: params.destFile });
      apiRef.current?.postMessage({
        type: 'batchTransfer',
        mode: params.mode,
        target: 'existing',
        macroNames: names,
        destFile: params.destFile
      });
      return;
    }
    // target === 'new'
    if (!params.newFile) return;
    const verbGer = params.mode === 'move' ? t('movedPast') : t('copiedPast');
    pendingActionRef.current = t('createdAndTransferred', { verb: verbGer.toLowerCase(), count: names.length, file: params.newFile });
    apiRef.current?.postMessage({
      type: 'batchTransfer',
      mode: params.mode,
      target: 'new',
      macroNames: names,
      newFile: params.newFile,
      newDisplayName: params.newDisplayName || undefined,
      newDescription: params.newDescription || undefined
    });
  };

  if (model.kind === 'loading') {
    return (
      <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t('panelTitle')}
        back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }}
      />
        <p style={{ opacity: 0.7 }}>{t('loading')}</p>
      </main>
    );
  }

  if (model.kind === 'noFile') {
    return (
      <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t('panelTitle')}
        back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }}
      />
        <p style={{ opacity: 0.85 }}>
          {t('noFile', { file: model.file })}
        </p>
      </main>
    );
  }

  if (model.kind === 'error') {
    return (
      <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t('panelTitle')}
        back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }}
      />
        <p style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>
          ❌ {model.message}
        </p>
      </main>
    );
  }

  const { pkg, file, macros, workspaceMacros, macroKinds, otherPackages, active, entryPoolIds } = model;
  const selectMode = mode === 'multiselect';

  return (
    <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={pkg.name}
        subtitle={t('macroCount', { file, count: macros.length })}
        back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }}
      />
      {toast ? <ToastBanner toast={toast} onDismiss={() => setToast(null)} /> : null}
      <div
        className="snl-responsive-row"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem'
        }}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          {pkg.description ? (
            <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
              {pkg.description}
            </p>
          ) : (
            <div style={{ height: '0.5rem' }} />
          )}
        </div>
        <div style={{ flex: '0 0 auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <ActiveIndicator active={active} onToggle={() => setPackageActive(!active)} />
          <Button
            type="button"
            onClick={selectMode ? cancelSelect : enterSelect}
            title={
              selectMode
                ? t('exitSelectTitle')
                : t('enterSelectTitle')
            }
            style={HEADER_BUTTON_STYLE}
          >
            {selectMode ? t('cancel') : t('select')}
          </Button>
          <Button
            type="button"
            onClick={editMacroPackage}
            title={t('editPackageTitle')}
            style={HEADER_BUTTON_STYLE}
          >
            {t('editPackage')}
          </Button>
        </div>
      </div>

      {macros.length > 0 ? (
        <MacroTable
          macros={macros}
          workspaceMacros={workspaceMacros}
          macroKinds={macroKinds}
          entryPoolIds={entryPoolIds}
          onEdit={editMacro}
          onCopy={copyMacro}
          onDelete={deleteMacro}
          selectMode={selectMode}
          selectedNames={selectedNames}
          onToggleSelect={toggleSelect}
        />
      ) : (
        <p style={{ opacity: 0.7, fontStyle: 'italic', margin: '0.5rem 0' }}>
          {t('empty')}
        </p>
      )}

      {selectMode ? (
        <MultiSelectBar
          count={selectedNames.size}
          onTransfer={() => setActiveModal('transfer')}
          onDelete={submitBatchDelete}
        />
      ) : (
        <EmptyAction size="lg" className="snl-empty-action--large" label={t('createMacro')} onClick={createMacro} />
      )}

      {activeModal === 'transfer' ? (
        <TransferModal
          count={selectedNames.size}
          otherPackages={otherPackages}
          onCancel={() => setActiveModal(null)}
          onSubmit={submitBatchTransfer}
        />
      ) : null}
    </main>
  );
}

const HEADER_BUTTON_STYLE: React.CSSProperties = {
  flex: '0 0 auto',
  padding: '0.35rem 0.75rem',
  fontFamily: 'inherit',
  fontSize: '0.9rem',
  border:
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
  borderRadius: '4px',
  background:
    'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
  color: 'inherit',
  cursor: 'pointer'
};

/**
 * Header active-state indicator: a colored dot + label plus a Toggle button.
 * Green/"Active" when the package contributes to the workspace macro
 * universe, gray/"Inactive" otherwise.
 */
function ActiveIndicator({
  active,
  onToggle
}: {
  active: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        marginRight: '0.25rem'
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: '0.6rem',
          height: '0.6rem',
          borderRadius: '50%',
          background: active
            ? 'var(--vscode-testing-iconPassed, #3fb950)'
            : 'var(--vscode-descriptionForeground, #888)'
        }}
      />
      <span style={{ fontSize: '0.85rem', opacity: 0.85 }}>
        {active ? t('active') : t('inactive')}
      </span>
      <Button
        type="button"
        onClick={onToggle}
        title={
          active
            ? t('deactivateTitle')
            : t('activateTitle')
        }
        style={HEADER_BUTTON_STYLE}
      >
        {t('toggle')}
      </Button>
    </span>
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
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};

/**
 * Human-readable arity label for a macro row (bug 2 fix).
 * For a fixed-arity macro, show the derived argument count (from max #N in
 * the default template + 1). For dynamic-arity, show "dynamic". "0" (a
 * fixed nullary macro like `\LaTeX`) is a legitimate value.
 */
export function defaultStyleForLanguage(
  macro: MacroPackageEntry,
  language: string
): MacroPackageStyle | undefined {
  const styles = Array.isArray(macro.styles) ? macro.styles : [];
  if (styles.length === 0) return undefined;
  const mappedName = macro.default_style?.[language] ?? macro.default_style?.en;
  if (mappedName === undefined) return styles[0];
  const mapped = styles.find((style) => style.style_name === mappedName);
  if (!mapped) {
    throw new Error(
      `default style "${mappedName}" for language "${language}" does not exist on macro "${macro.name}"`
    );
  }
  return mapped;
}

function arityLabel(
  macro: MacroPackageEntry,
  style = defaultStyleForLanguage(
    macro,
    webview_language_runtime.query_environment().language
  ),
  dynamicLabel = 'dynamic'
): string {
  if (macro.dynamic_arity) {
    return dynamicLabel;
  }
  const template = style
    ? resolve_style_template(style, webview_language_runtime)
    : '';
  const count = Math.max(0, maxMacroTemplateChildIndex(template) + 1);
  return String(count);
}

export function MacroTable({
  macros,
  workspaceMacros,
  macroKinds,
  entryPoolIds,
  onEdit,
  onCopy,
  onDelete,
  selectMode,
  selectedNames,
  onToggleSelect
}: {
  macros: MacroPackageEntry[];
  workspaceMacros: Record<string, MacroPackageEntry>;
  macroKinds: MacroKind[];
  entryPoolIds: Set<string>;
  onEdit: (name: string) => void;
  onCopy?: (name: string) => void;
  onDelete: (name: string) => void;
  selectMode: boolean;
  selectedNames: Set<string>;
  onToggleSelect: (name: string) => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  const kindById = useMemo(() => {
    const m = new Map<string, MacroKind>();
    for (const k of macroKinds) {
      m.set(k.id, k);
    }
    return m;
  }, [macroKinds]);
  const kindPalette = useMemo(
    () => macroKindsToPalette(macroKinds),
    [macroKinds]
  );

  // Build ONE preview macro record for the whole table: all active workspace
  // packages, argument placeholders, then THIS package for deterministic local
  // precedence. This supports cross-package Macro composition.
  // memoize by the macros array identity — parent's onMessage handler creates
  // a fresh array whenever the package file changes.
  const previewMacroRecord: MacroRecord = useMemo(() => {
    const packageMacros: MacroRecord = {};
    for (const [name, macro] of Object.entries(workspaceMacros)) {
      packageMacros[name] = wireMacroToRenderable(macro);
    }
    for (const m of macros) {
      packageMacros[m.name] = wireMacroToRenderable(m);
    }
    return { ...packageMacros, ...MACRO_PREVIEW_ARGUMENTS };
  }, [macros, workspaceMacros]);

  const previewMacroDataDriver = useMemo(
    () => createMacroDataDriver(previewMacroRecord),
    [previewMacroRecord]
  );

  // Tooltip / hover pipeline is pointless in a compact row preview and only
  // adds jitter. Suppress via renderTooltip → null.
  const previewHooks: SnlRenderHooks = useMemo(
    // `renderers` replaces the registry wholesale; `extensionRenderers` keeps
    // the Basics defaults and adds `collapsible`, so a package macro using that
    // preset previews correctly instead of falling back to a plain block.
    () => ({
      ...defaultRenderHooks,
      renderTooltip: () => null,
      renderers: extensionRenderers
    }),
    []
  );

  return (
    <table
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        marginTop: '0.25rem',
        fontSize: '0.95rem'
      }}
    >
      <thead>
        <tr>
          {/* Leftmost column doubles as expand-toggle stub (normal mode) or
              checkbox column (multi-select mode) — 1.6rem wide. */}
          <th style={{ ...HEAD, width: '1.6rem', padding: '0.45rem 0.2rem' }} />
          <th style={{ ...HEAD, width: '9rem' }}>{t('colPreview')}</th>
          <th style={HEAD}>{t('colName')}</th>
          <th style={{ ...HEAD, width: '5rem' }}>{t('colArity')}</th>
          <th
            style={{ ...HEAD, width: '3.5rem', textAlign: 'center' }}
            title={t('srcTitle')}
          >
            {t('colSrc')}
          </th>
          <th style={{ ...HEAD, width: '9rem' }}>{t('colMode')}</th>
          <th style={{ ...HEAD, width: '8rem' }}>{t('colKind')}</th>
          <th style={{ ...HEAD, width: '11rem' }}>{t('colStyle')}</th>
          <th style={{ ...HEAD, width: '13rem' }}>{t('colMacroTags')}</th>
          <th style={{ ...HEAD, width: '13rem' }}>{t('colStyleTags')}</th>
          {/* Description can be long and wrapping is fine here. */}
          <th style={HEAD}>{t('colDescription')}</th>
          <th style={{ ...HEAD, width: '7rem', textAlign: 'center' }}>{t('colActions')}</th>
        </tr>
      </thead>
      <tbody>
        {macros.map((m) => (
          <MacroRowGroup
            key={m.name}
            macro={m}
            kindById={kindById}
            kindPalette={kindPalette}
            entryPoolIds={entryPoolIds}
            previewMacroDataDriver={previewMacroDataDriver}
            previewHooks={previewHooks}
            onEdit={onEdit}
            onCopy={onCopy}
            onDelete={onDelete}
            selectMode={selectMode}
            selected={selectedNames.has(m.name)}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </tbody>
    </table>
  );
}

/**
 * One macro renders as N rows — a "default style" summary row (always shown)
 * plus zero or more "additional style" rows (rendered only when the user
 * expands the macro via the ▶ toggle in the leftmost column).
 *
 * 猫猫 spec 2026-07-04-late 3: "Macro Package Panel 应该按一个 Style 一行
 * 展示，但在每个 default style 左侧加个展开/缩回按钮，默认缩回 ... 每个纵栏
 * 的值就不用 / 或 + 分隔了，只显示那一行对应的；Name / Kind / Arity /
 * Description 纵栏除了 default 的都用 `-` 占位".
 */
function MacroRowGroup({
  macro,
  kindById,
  kindPalette,
  entryPoolIds,
  previewMacroDataDriver,
  previewHooks,
  onEdit,
  onCopy,
  onDelete,
  selectMode,
  selected,
  onToggleSelect
}: {
  macro: MacroPackageEntry;
  kindById: Map<string, MacroKind>;
  kindPalette: KindPalette | undefined;
  entryPoolIds: Set<string>;
  previewMacroDataDriver: MacroDataDriver;
  previewHooks: SnlRenderHooks;
  onEdit: (name: string) => void;
  onCopy?: (name: string) => void;
  onDelete: (name: string) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (name: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  use_preferences_revision();
  const styles = Array.isArray(macro.styles) ? macro.styles : [];
  const language = webview_language_runtime.query_environment().language;
  const defaultStyle = defaultStyleForLanguage(macro, language);
  const defaultIndex = defaultStyle
    ? Math.max(0, styles.findIndex((style) => style.style_name === defaultStyle.style_name))
    : 0;
  const extraStyles = styles
    .map((style, index) => ({ style, index }))
    .filter(({ index }) => index !== defaultIndex);
  // In multi-select mode a macro is one selectable unit — collapse the style
  // rows so each macro is a single checkbox row.
  const canExpand = !selectMode && extraStyles.length > 0;
  return (
    <>
      <MacroStyleRow
        macro={macro}
        style={defaultStyle}
        isDefault
        showMacroLevel
        expanded={expanded}
        canExpand={canExpand}
        onToggleExpand={
          canExpand ? () => setExpanded((v) => !v) : undefined
        }
        kindById={kindById}
        kindPalette={kindPalette}
        entryPoolIds={entryPoolIds}
        previewMacroDataDriver={previewMacroDataDriver}
        previewHooks={previewHooks}
        onEdit={onEdit}
        onCopy={onCopy}
        onDelete={onDelete}
        selectMode={selectMode}
        selected={selected}
        onToggleSelect={onToggleSelect}
      />
      {!selectMode && expanded
        ? extraStyles.map(({ style, index }) => (
            <MacroStyleRow
              key={`${macro.name}::${style.style_name}::${index}`}
              macro={macro}
              style={style}
              isDefault={false}
              showMacroLevel={false}
              expanded={false}
              canExpand={false}
              onToggleExpand={undefined}
              kindById={kindById}
              kindPalette={kindPalette}
              entryPoolIds={entryPoolIds}
              previewMacroDataDriver={previewMacroDataDriver}
              previewHooks={previewHooks}
              onEdit={onEdit}
              onCopy={onCopy}
              onDelete={onDelete}
              selectMode={false}
              selected={false}
              onToggleSelect={onToggleSelect}
            />
          ))
        : null}
    </>
  );
}

/**
 * A single clickable macro/style row. Clicking (or Enter/Space) on any cell
 * OTHER than the expand-toggle dispatches `editMacro` for this macro name.
 * The expand toggle has its own click handler with stopPropagation.
 *
 * Cells are split into "macro-level" (Name / Arity / Kind / Macro Tags /
 * Description) — shown only on the default row (`showMacroLevel=true`),
 * `—` placeholder on extra style rows — and "style-level" (Preview / Mode /
 * Style tag / Style Tags) — always shown per row.
 */
function MacroStyleRow({
  macro,
  style,
  isDefault,
  showMacroLevel,
  expanded,
  canExpand,
  onToggleExpand,
  kindById,
  kindPalette,
  entryPoolIds,
  previewMacroDataDriver,
  previewHooks,
  onEdit,
  onCopy,
  onDelete,
  selectMode,
  selected,
  onToggleSelect
}: {
  macro: MacroPackageEntry;
  style: MacroPackageStyle | undefined;
  isDefault: boolean;
  /** If true, render Name / Arity / Kind / Macro Tags / Description; else `—`. */
  showMacroLevel: boolean;
  expanded: boolean;
  canExpand: boolean;
  onToggleExpand: (() => void) | undefined;
  kindById: Map<string, MacroKind>;
  kindPalette: KindPalette | undefined;
  entryPoolIds: Set<string>;
  previewMacroDataDriver: MacroDataDriver;
  previewHooks: SnlRenderHooks;
  onEdit: (name: string) => void;
  onCopy?: (name: string) => void;
  onDelete: (name: string) => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (name: string) => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  const [hover, setHover] = useState(false);
  // In multi-select mode a row click toggles selection instead of opening the
  // macro editor.
  const activate = (): void =>
    selectMode ? onToggleSelect(macro.name) : onEdit(macro.name);
  const macroTags = Array.isArray(macro.tags) ? macro.tags : [];
  const styleTags = Array.isArray(style?.tags) ? (style?.tags as string[]) : [];
  const styleTag = style?.style_name ?? t('untagged');
  const styleMode = style?.mode ?? '';
  const rowBackground =
    selectMode && selected
      ? 'var(--vscode-list-activeSelectionBackground, rgba(60,120,220,0.25))'
      : hover
        ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
        : isDefault
          ? 'transparent'
          : 'var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.02))';
  return (
    <tr
      onClick={activate}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: rowBackground,
        // Extra rows visually attach to their default row with no top border
        // so the group reads as one block.
        borderTop: isDefault
          ? undefined
          : '1px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #333))'
      }}
    >
      {/* Leftmost cell: checkbox (multi-select) or expand toggle (normal). */}
      <td
        style={{
          ...CELL,
          width: '1.6rem',
          padding: '0.45rem 0.2rem',
          textAlign: 'center'
        }}
      >
        {selectMode ? (
          <input
            type="checkbox"
            checked={selected}
            aria-label={t('selectMacro', { name: macro.name })}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (shouldStopRowActivation(e.key)) e.stopPropagation();
            }}
            onChange={() => onToggleSelect(macro.name)}
            style={{ cursor: 'pointer' }}
          />
        ) : isDefault && canExpand ? (
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand?.();
            }}
            onKeyDown={(e) => {
              // Enter / Space on the toggle should NOT propagate to the row's
              // activate() — the user is toggling, not editing.
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
              }
            }}
            aria-label={expanded ? t('collapseStyles') : t('expandStyles')}
            title={
              expanded
                ? t('collapseRows')
                : t('moreRows', { count: macro.styles.length - 1 })
            }
            style={{
              padding: '0.05rem 0.35rem',
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '0.9rem',
              opacity: 0.75,
              lineHeight: 1
            }}
          >
            {expanded ? '▼' : '▶'}
          </Button>
        ) : null}
      </td>
      {/* Preview: always per-style. */}
      <td style={{ ...CELL, textAlign: 'center' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '1.5rem'
          }}
        >
          {style ? (
            <MacroPreview
              macro={macro}
              styleTag={isDefault ? undefined : style.style_name}
              macroDataDriver={previewMacroDataDriver}
              hooks={previewHooks}
              kindPalette={kindPalette}
            />
          ) : (
            <span style={{ opacity: 0.5 }}>—</span>
          )}
        </div>
      </td>
      {/* Name: macro-level. */}
      <td style={{ ...CELL, ...MONO }}>
        <RowPrimaryButton
          label={
            selectMode
              ? (selected ? t('deselectMacro', { name: macro.name }) : t('selectMacro', { name: macro.name }))
              : isDefault
                ? t('editMacro', { name: macro.name })
                : t('editMacroStyle', { name: macro.name, style: styleTag })
          }
          onActivate={activate}
        >
          {showMacroLevel ? macro.name : <Dash />}
        </RowPrimaryButton>
      </td>
      {/* Arity: macro-level. */}
      <td style={CELL}>{showMacroLevel ? arityLabel(macro, style, t('dynamic')) : <Dash />}</td>
      {/* Src status: macro-level. Cat 2026-07-10 §2. */}
      <td style={{ ...CELL, textAlign: 'center' }}>
        {showMacroLevel ? (
          <SrcStatusLight
            source={macro.source}
            entryPoolIds={entryPoolIds}
          />
        ) : (
          <Dash />
        )}
      </td>
      {/* Mode: style-level. */}
      <td style={CELL}>
        {styleMode ? (
          <span style={MONO}>{styleMode}</span>
        ) : (
          <span style={{ opacity: 0.5 }}>—</span>
        )}
      </td>
      {/* Kind: macro-level. */}
      <td style={CELL}>
        {showMacroLevel ? (
          <KindCell
            kindId={macro.kind}
            kind={macro.kind ? kindById.get(macro.kind) : undefined}
          />
        ) : (
          <Dash />
        )}
      </td>
      {/* Style tag: style-level (★ marker on the default row). */}
      <td style={CELL}>
        <span style={MONO}>{styleTag}</span>
        {isDefault ? (
          <span style={{ opacity: 0.7, marginLeft: '0.3rem' }} title={t('defaultStyle')}>
            ★
          </span>
        ) : null}
      </td>
      {/* Macro Tags: macro-level. */}
      <td style={CELL}>
        {showMacroLevel ? <TagChipList tags={macroTags} /> : <Dash />}
      </td>
      {/* Style Tags: style-level. */}
      <td style={CELL}>
        <TagChipList tags={styleTags} />
      </td>
      {/* Description: macro-level. */}
      <td style={{ ...CELL, opacity: 0.85 }}>
        {showMacroLevel ? (macro.description ?? '') : <Dash />}
      </td>
      <td style={{ ...CELL, textAlign: 'center' }}>
        {showMacroLevel && !selectMode ? (
          <span style={{ display: 'inline-flex', gap: '0.3rem' }}>
            {onCopy ? (
              <Button
                size="sm"
                title={t('copyMacro', { name: macro.name })}
                aria-label={t('copyMacro', { name: macro.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  onCopy?.(macro.name);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {t('copy')}
              </Button>
            ) : null}
            <IconButton
              icon="delete"
              label={t('deleteMacro', { name: macro.name })}
              variant="destructive"
              size="sm"
              title={t('deleteMacro', { name: macro.name })}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(macro.name);
              }}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </span>
        ) : (
          <Dash />
        )}
      </td>
    </tr>
  );
}

/** Placeholder cell used to signal "same as macro's default row". */
function Dash(): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  return (
    <span aria-label={t('sameAsDefault')} style={{ opacity: 0.45 }}>
      —
    </span>
  );
}

/** How many tag chips to render before collapsing the tail into a `+N`. */
const TAG_CHIP_VISIBLE = 3;

/**
 * Render a compact row of tag chips with an overflow `+N` chip. Empty tag
 * list renders as `—`. Chips are inline-flex cards with a subtle border and
 * background so they read as their own units against the row background.
 */
function TagChipList({ tags }: { tags: string[] }): React.ReactElement {
  if (!Array.isArray(tags) || tags.length === 0) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }
  const visible = tags.slice(0, TAG_CHIP_VISIBLE);
  const overflow = tags.length - visible.length;
  return (
    <span
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        gap: '0.25rem',
        alignItems: 'center'
      }}
    >
      {visible.map((t, i) => (
        <TagChip key={i} label={t} />
      ))}
      {overflow > 0 ? (
        <TagChip
          label={`+${overflow}`}
          title={tags.slice(TAG_CHIP_VISIBLE).join(', ')}
          muted
        />
      ) : null}
    </span>
  );
}

function TagChip({
  label,
  title,
  muted
}: {
  label: string;
  title?: string;
  muted?: boolean;
}): React.ReactElement {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.05rem 0.45rem',
        borderRadius: '10px',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #555))',
        background: muted
          ? 'transparent'
          : 'var(--vscode-badge-background, rgba(255,255,255,0.06))',
        color: muted
          ? 'var(--vscode-descriptionForeground, #999)'
          : 'var(--vscode-badge-foreground, inherit)',
        fontSize: '0.75rem',
        lineHeight: 1.3,
        maxWidth: '11rem',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </span>
  );
}

/** Renders a macro's kind: swatch + name when known, raw id when the kind
 *  isn't in the catalog, or "—" when unset. */
function KindCell({
  kindId,
  kind
}: {
  kindId?: string;
  kind?: MacroKind;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  if (!kindId) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }
  if (!kind) {
    return (
      <span
        style={{ ...MONO, opacity: 0.75 }}
        title={t('noKind')}
      >
        {kindId}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span
        title={t('colorTitle', { stroke: resolveThemeColoring(kind.coloring).stroke, background: resolveThemeColoring(kind.coloring).background })}
        style={{
          display: 'inline-block',
          width: '1.2rem',
          height: '1rem',
          borderRadius: '3px',
          background: resolveThemeColoring(kind.coloring).background,
          border: `2px solid ${resolveThemeColoring(kind.coloring).stroke}`
        }}
      />
      {kind.name}
    </span>
  );
}

/**
 * Real KaTeX preview of a macro applied to numbered argument placeholders.
 *
 * When `styleTag` is undefined the macro's language-default style is
 * used — the tree omits `[style]` and the render pipeline resolves the current
 * language, then English, then `styles[0]`. When `styleTag` is provided, the tree carries that
 * tag so the pipeline resolves to the matching non-default style. Arity is
 * derived from the RESOLVED style's template (max `#N` + 1); dynamic-arity
 * always uses VARIADIC_PREVIEW_ARGS. A macro with an empty template renders
 * as a soft `—` so a broken row doesn't show a phantom empty preview.
 *
 * A row-scoped try/catch (via a null template fallback) keeps a broken macro
 * from taking down the whole table.
 */
function MacroPreview({
  macro,
  styleTag,
  macroDataDriver,
  hooks,
  kindPalette
}: {
  macro: MacroPackageEntry;
  /** Non-default style tag to preview. Undefined → use the language default. */
  styleTag: string | undefined;
  macroDataDriver: MacroDataDriver;
  hooks: SnlRenderHooks;
  kindPalette: KindPalette | undefined;
}): React.ReactElement {
  const preferencesRevision = use_preferences_revision();
  const language = webview_language_runtime.query_environment().language;
  // Locate the specific style being previewed (fall back through language defaults).
  const style = useMemo<MacroPackageStyle | undefined>(() => {
    if (!Array.isArray(macro.styles) || macro.styles.length === 0)
      return undefined;
    if (styleTag == null) return defaultStyleForLanguage(macro, language);
    return macro.styles.find((s) => s.style_name === styleTag) ?? macro.styles[0];
  }, [macro, language, styleTag]);
  const resolvedTemplate = useMemo(
    () => style ? resolve_style_template(style, webview_language_runtime) : '',
    [style, preferencesRevision]
  );

  const argCount = useMemo(() => {
    if (macro.dynamic_arity) {
      return Math.min(VARIADIC_PREVIEW_ARGS, MAX_MACRO_PREVIEW_ARGS);
    }
    const derived = maxMacroTemplateChildIndex(resolvedTemplate) + 1;
    return Math.min(Math.max(derived, 0), MAX_MACRO_PREVIEW_ARGS);
  }, [macro.dynamic_arity, resolvedTemplate]);

  const tree: SnlSyntaxTree = useMemo(() => {
    const children: SnlSyntaxTree[] = [];
    for (let i = 0; i < argCount; i++) {
      children.push(macroPreviewArgumentNode(i));
    }
    const node: SnlSyntaxTree = {
      macro_name: macro.name,
      kind: '',
      mdata: null,
      children
    };
    // Only stamp `style` when the caller asked for a non-default style;
    // omission lets the render pipeline use the language default.
    if (styleTag != null) node.style_name = styleTag;
    return node;
  }, [macro.name, argCount, styleTag]);

  // A style with an empty template renders as nothing useful — bail to
  // a soft "—" so the row doesn't show a phantom empty preview.
  const template = resolvedTemplate.trim();
  if (!template) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }

  // No wrapper background / border: the SNL preview should be the outermost
  // block. SnlSyntaxTreeView emits its own `.katex-panel > .katex-html` divs
  // (structural but paint-nothing after the 2026-07-04 SNL-Basics fix), so
  // adding a chip here would just re-introduce the "framed panel" look that
  // 猫猫 called out.
  return (
    <SnlSyntaxTreeView
      key={`preferences-${preferencesRevision}`}
      tree={tree}
      macro_data_driver={macroDataDriver}
      reader_runtime={webview_language_runtime}
      hooks={hooks}
      kindPalette={kindPalette}
    />
  );
}

// ---------------------------------------------------------------------------
// Multi-select batch UI
// ---------------------------------------------------------------------------

/**
 * Sticky bottom action bar shown in multi-select mode. The primary batch
 * action is a single "Copy / Move…" button that opens a unified modal where
 * the user picks copy-vs-move and a destination (existing or new package).
 * Both buttons are disabled when nothing is selected.
 */
function MultiSelectBar({
  count,
  onTransfer,
  onDelete
}: {
  count: number;
  onTransfer: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  const none = count === 0;
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        marginTop: '0.75rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        padding: '0.6rem 0.75rem',
        borderRadius: '6px',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background:
          'var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e))'
      }}
    >
      <span style={{ fontWeight: 600, marginRight: 'auto' }}>
        {t('selectedCount', { count })}
      </span>
      <Button
        type="button"
        disabled={none}
        onClick={onTransfer}
        title={t('transferTitle')}
        style={batchButtonStyle(none, false)}
      >
        {t('transfer')}
      </Button>
      <Button
        type="button"
        disabled={none}
        onClick={onDelete}
        style={batchButtonStyle(none, true)}
      >
        {t('delete')}
      </Button>
    </div>
  );
}

function batchButtonStyle(
  disabled: boolean,
  destructive: boolean
): React.CSSProperties {
  return {
    padding: '0.35rem 0.85rem',
    fontFamily: 'inherit',
    fontSize: '0.9rem',
    borderRadius: '4px',
    border: destructive
      ? '1px solid var(--vscode-inputValidation-errorBorder, #be1100)'
      : '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
    background: destructive
      ? 'var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.15))'
      : 'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
    color: destructive
      ? 'var(--vscode-errorForeground, #f48771)'
      : 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1
  };
}

/** A transient success/error toast banner pinned to the top of the panel. */
function ToastBanner({
  toast,
  onDismiss
}: {
  toast: Toast;
  onDismiss: () => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  const isError = toast.kind === 'error';
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        marginBottom: '0.75rem',
        padding: '0.55rem 0.75rem',
        borderRadius: '5px',
        border: `1px solid ${
          isError
            ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
            : 'var(--vscode-inputValidation-infoBorder, #3794ff)'
        }`,
        background: isError
          ? 'var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.15))'
          : 'var(--vscode-inputValidation-infoBackground, rgba(55,148,255,0.15))',
        color: isError
          ? 'var(--vscode-errorForeground, #f48771)'
          : 'inherit'
      }}
    >
      <span style={{ marginRight: 'auto' }}>
        {isError ? '❌' : '✓'} {toast.message}
      </span>
      <IconButton
        icon="close"
        label={t('dismiss')}
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        style={{ color: 'inherit' }}
      />
    </div>
  );
}

/** Shared modal shell — dim backdrop + centered card. */
function ModalShell({
  title,
  onCancel,
  children
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(28rem, 90vw)',
          padding: '1.1rem 1.25rem',
          borderRadius: '8px',
          border:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
          background:
            'var(--vscode-editorWidget-background, var(--vscode-editor-background, #1e1e1e))',
          boxShadow: '0 8px 30px rgba(0,0,0,0.4)'
        }}
      >
        <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.1rem' }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const MODAL_INPUT_BORDER =
  '1px solid var(--vscode-input-border, var(--vscode-panel-border, #555))';

const MODAL_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.4rem 0.5rem',
  fontFamily: 'inherit',
  fontSize: '0.9rem',
  borderRadius: '4px',
  border: MODAL_INPUT_BORDER,
  background: 'var(--vscode-input-background, rgba(255,255,255,0.04))',
  color: 'var(--vscode-input-foreground, inherit)'
};

/**
 * Unified "Copy / Move macros" modal (2026-07-06 merge).
 *
 * Replaces the two older single-purpose dialogs. A segmented toggle at the
 * top picks copy-vs-move; the destination dropdown starts with a synthetic
 * "— Create new package —" entry followed by every other active package.
 * When the create-new entry is selected, three extra inputs appear (file
 * name, display name, description) mirroring the old "Package as new" form.
 *
 * Behaviour matrix:
 *   Copy + existing -> host `batchCopyMacros`   (conflicts refuse whole batch)
 *   Move + existing -> host `batchMoveMacros`   (conflicts refuse whole batch)
 *   Copy + new      -> host `batchPackageAsNew`
 *   Move + new      -> host `batchMoveToNewPackage` (create + copy + delete-source)
 *
 * Default (`Copy` + first existing package, or `Copy` + create-new when
 * there are no other active packages) is the safest choice — it never
 * mutates the source package until the user explicitly flips to Move.
 */
const CREATE_NEW_VALUE = '__create_new__';

function TransferModal({
  count,
  otherPackages,
  onCancel,
  onSubmit
}: {
  count: number;
  otherPackages: Array<{ file: string; name: string }>;
  onCancel: () => void;
  onSubmit: (params: {
    mode: 'copy' | 'move';
    target: 'existing' | 'new';
    destFile?: string;
    newFile?: string;
    newDisplayName?: string;
    newDescription?: string;
  }) => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  // Default: first existing package if any, otherwise create-new.
  const [destValue, setDestValue] = useState<string>(
    otherPackages[0]?.file ?? CREATE_NEW_VALUE
  );
  const [newFile, setNewFile] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const isNew = destValue === CREATE_NEW_VALUE;
  const bare = newFile.trim();
  const fileValid = BARE_FILE_RE.test(bare);

  const canSubmit =
    count > 0 &&
    (isNew ? fileValid : destValue.length > 0 && destValue !== CREATE_NEW_VALUE);

  const submit = (): void => {
    if (!canSubmit) return;
    if (isNew) {
      onSubmit({
        mode,
        target: 'new',
        newFile: bare,
        newDisplayName: newDisplayName.trim(),
        newDescription: newDescription.trim()
      });
    } else {
      onSubmit({ mode, target: 'existing', destFile: destValue });
    }
  };

  const verb = mode === 'move' ? t('move') : t('copy');

  return (
    <ModalShell title={t('transferHeading')} onCancel={onCancel}>
      {/* Copy / Move segmented toggle. */}
      <div
        role="radiogroup"
        aria-label={t('transferMode')}
        style={{
          display: 'inline-flex',
          marginBottom: '0.75rem',
          border: MODAL_INPUT_BORDER,
          borderRadius: '4px',
          overflow: 'hidden'
        }}
      >
        <TransferModeButton
          label={t('copy')}
          active={mode === 'copy'}
          onClick={() => setMode('copy')}
          title={t('copyModeTitle')}
        />
        <TransferModeButton
          label={t('move')}
          active={mode === 'move'}
          onClick={() => setMode('move')}
          title={t('moveModeTitle')}
        />
      </div>

      <p style={{ margin: '0 0 0.75rem', opacity: 0.8, fontSize: '0.9rem' }}>
        {isNew
          ? t('transferSummaryNew', { verb, count })
          : t('transferSummaryExisting', { verb, count })}
        {' '}{mode === 'move' ? t('moveEffect') : t('copyEffect')}
      </p>

      <label style={{ display: 'block', marginBottom: '0.6rem' }}>
        <span
          style={{
            display: 'block',
            marginBottom: '0.2rem',
            fontSize: '0.85rem'
          }}
        >
          {t('destination')}
        </span>
        <select
          value={destValue}
          onChange={(e) => setDestValue(e.target.value)}
          style={MODAL_INPUT_STYLE}
        >
          <option value={CREATE_NEW_VALUE}>{t('createNew')}</option>
          {otherPackages.map((p) => (
            <option key={p.file} value={p.file}>
              {p.name} ({p.file})
            </option>
          ))}
        </select>
      </label>

      {isNew ? (
        <>
          <label style={{ display: 'block', marginBottom: '0.6rem' }}>
            <span
              style={{
                display: 'block',
                marginBottom: '0.2rem',
                fontSize: '0.85rem'
              }}
            >
              {t('newFile')}
            </span>
            <input
              type="text"
              value={newFile}
              autoFocus
              placeholder={t('filePlaceholder')}
              onChange={(e) => setNewFile(e.target.value)}
              style={{
                ...MODAL_INPUT_STYLE,
                border:
                  bare.length > 0 && !fileValid
                    ? '1px solid var(--vscode-inputValidation-errorBorder, #be1100)'
                    : MODAL_INPUT_BORDER
              }}
            />
            {bare.length > 0 && !fileValid ? (
              <span
                style={{
                  display: 'block',
                  marginTop: '0.2rem',
                  fontSize: '0.8rem',
                  color: 'var(--vscode-errorForeground, #f48771)'
                }}
              >
                {t('invalidFile')}
              </span>
            ) : null}
          </label>
          <label style={{ display: 'block', marginBottom: '0.6rem' }}>
            <span
              style={{
                display: 'block',
                marginBottom: '0.2rem',
                fontSize: '0.85rem'
              }}
            >
              {t('displayName')}
            </span>
            <input
              type="text"
              value={newDisplayName}
              placeholder={bare || t('displayNamePlaceholder')}
              onChange={(e) => setNewDisplayName(e.target.value)}
              style={MODAL_INPUT_STYLE}
            />
          </label>
          <label style={{ display: 'block', marginBottom: '1rem' }}>
            <span
              style={{
                display: 'block',
                marginBottom: '0.2rem',
                fontSize: '0.85rem'
              }}
            >
              {t('description')}
            </span>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              style={MODAL_INPUT_STYLE}
            />
          </label>
        </>
      ) : null}

      <ModalButtons
        onCancel={onCancel}
        submitLabel={isNew ? t('transferIntoNew', { verb }) : verb}
        canSubmit={canSubmit}
        onSubmit={submit}
      />
    </ModalShell>
  );
}

/** One segment of the Copy/Move toggle. */
function TransferModeButton({
  label,
  active,
  onClick,
  title
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title: string;
}): React.ReactElement {
  return (
    <Button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      title={title}
      style={{
        padding: '0.35rem 0.9rem',
        fontFamily: 'inherit',
        fontSize: '0.9rem',
        border: 'none',
        cursor: 'pointer',
        background: active
          ? 'var(--vscode-button-background, var(--vscode-button-secondaryBackground, #0e639c))'
          : 'transparent',
        color: active
          ? 'var(--vscode-button-foreground, #fff)'
          : 'inherit',
        fontWeight: active ? 600 : 400
      }}
    >
      {label}
    </Button>
  );
}

/** Cancel / submit button pair used by the batch modals. */
function ModalButtons({
  onCancel,
  submitLabel,
  canSubmit,
  onSubmit
}: {
  onCancel: () => void;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
      <Button type="button" onClick={onCancel} style={HEADER_BUTTON_STYLE}>
        {t('cancel')}
      </Button>
      <Button
        type="button"
        disabled={!canSubmit}
        onClick={onSubmit}
        style={{
          ...HEADER_BUTTON_STYLE,
          background:
            'var(--vscode-button-background, var(--vscode-button-secondaryBackground, #0e639c))',
          color: 'var(--vscode-button-foreground, #fff)',
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          opacity: canSubmit ? 1 : 0.5
        }}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

/**
 * Traffic-light indicator for a macro's `source` binding
 * (cat 2026-07-10 §2):
 *   🟢 green  — at least one entry src that resolves in the pool.
 *   🟡 yellow — has entry src(s) but none resolve; OR only url src(s).
 *   🔴 red    — no src at all (no entries, no urls).
 * Wrapped in a `<span>` with a hover title spelling out what was found.
 */
function SrcStatusLight({
  source,
  entryPoolIds
}: {
  source: { entries?: string[]; urls?: string[] } | null | undefined;
  entryPoolIds: Set<string>;
}): React.ReactElement {
  const t = useUiMessages(PACKAGE_MESSAGES);
  const entries = Array.isArray(source?.entries) ? source!.entries : [];
  const urls = Array.isArray(source?.urls) ? source!.urls : [];
  const resolved = entries.filter((id) => entryPoolIds.has(id));
  const unresolved = entries.filter((id) => !entryPoolIds.has(id));

  let color: 'green' | 'yellow' | 'red';
  let title: string;
  if (resolved.length > 0) {
    color = 'green';
    const bits = [
      t('resolvedEntries', { count: resolved.length, ids: resolved.join(', ') })
    ];
    if (unresolved.length > 0) {
      bits.push(t('unresolved', { count: unresolved.length, ids: unresolved.join(', ') }));
    }
    if (urls.length > 0) {
      bits.push(t('urlSources', { count: urls.length }));
    }
    title = bits.join('\n');
  } else if (entries.length > 0 || urls.length > 0) {
    color = 'yellow';
    const bits: string[] = [];
    if (unresolved.length > 0) {
      bits.push(t('missingEntries', { count: unresolved.length, ids: unresolved.join(', ') }));
    }
    if (urls.length > 0) {
      bits.push(t('urlSourcesWithIds', { count: urls.length, ids: urls.join(', ') }));
    }
    title = bits.join('\n');
  } else {
    color = 'red';
    title = t('noSource');
  }

  const dotColor =
    color === 'green'
      ? 'var(--vscode-testing-iconPassed, #4caf50)'
      : color === 'yellow'
        ? 'var(--vscode-editorWarning-foreground, #d7a35a)'
        : 'var(--vscode-errorForeground, #f14c4c)';
  return (
    <span
      title={title}
      aria-label={t('srcStatus', { color: t(color) })}
      style={{
        display: 'inline-block',
        width: '0.75rem',
        height: '0.75rem',
        borderRadius: '50%',
        background: dotColor,
        border: '1px solid rgba(0,0,0,0.25)',
        verticalAlign: 'middle'
      }}
    />
  );
}
