import * as vscode from 'vscode';
import { InfoviewPanel } from './infoviewPanel';
import { CreateLibraryPanel } from './createLibraryPanel';
import { DashboardPanel } from './dashboardPanel';
import { disposeTraceResources, isTraceEnabled, refreshTraceEnabled, setTraceEnabled, startTrace, traceChannel } from './trace';
import { registerWebviewCostProbe } from './webviewCostProbe';
import { InitEntryKindsPanel } from './initEntryKindsPanel';
import { CreateEntryKindPanel } from './createEntryKindPanel';
import { InitMacroKindsPanel } from './initMacroKindsPanel';
import { CreateMacroKindPanel } from './createMacroKindPanel';
import { CreateEntryPanel } from './createEntryPanel';
import { CreateMacroPackagePanel } from './createMacroPackagePanel';
import { PackagePanel } from './packagePanel';
import { CreateMacroPanel } from './createMacroPanel';
import { CreateRelationshipPanel } from './createRelationshipPanel';
import { GraphPanel } from './graphPanel';
import { SnoogLPanel } from './snooglPanel';
import { initSnlDoc } from './snlDoc';
import * as snlDoc from './snlDoc';
import { firstWorkspaceFolder } from './panelUtil';
import { initialize_preferences_host } from './preferencesHost';
import { installSnlDocContextKey } from './snlDocContext';
import { checkDataVersion, repairData } from './dataMigrationCommands';
import { createHostTranslator, defineHostMessages, type HostTranslatorArgs } from './hostI18n';
import { read_extension_preferences } from './preferences';

const UI_MESSAGES = defineHostMessages(
  {
    initNoWorkspace: 'SNL Init requires an open folder / workspace.',
    initExists: '.SNL_Doc already exists — use "SNL: Create Library" to add libraries.',
    initCreated: 'SNL Doc skeleton initialized. Use "SNL: Create Library" to add your first library.',
    initFailed: 'SNL Init failed: {error}',
    pointerNoWorkspace: 'Pointer cannot be resolved: no workspace folder is open.',
    loadEntriesFailed: 'Failed to load entries: {error}',
    entryNotFound: 'Entry not found: {id}',
    invalidPointer: 'Entry {id} has no valid pointer.',
    pointerResolutionFailed: 'Pointer could not be resolved: {error}',
    openFileFailed: 'Failed to open file: {error}',
    deleteAction: 'Delete',
    deleteEntryPrompt: 'Delete entry "{id}"?',
    deleteEntryDetail: 'This removes the entry from the shared pool. Library outlines and macro sources that reference this id will render as "unresolved" but keep working.',
    deleteEntryFailed: 'Delete entry failed: {error}',
    entryDeletedDangling: { arg: 'count', one: 'Deleted entry "{id}". {count} reference left dangling (library outlines / macro sources / relationships).', other: 'Deleted entry "{id}". {count} references left dangling (library outlines / macro sources / relationships).' },
    entryDeleted: 'Deleted entry "{id}".',
    deleteEntryKindPrompt: 'Delete entry kind "{id}"?',
    deleteEntryKindDetail: 'Entries that use this kind will keep working but render as "unknown kind" until their kind field is updated.',
    deleteEntryKindFailed: 'Delete entry kind failed: {error}',
    entryKindDeletedReferenced: { arg: 'count', one: 'Deleted entry kind "{id}". {count} entry now references an unknown kind.', other: 'Deleted entry kind "{id}". {count} entries now reference an unknown kind.' },
    entryKindDeleted: 'Deleted entry kind "{id}".',
    deleteMacroKindPrompt: 'Delete macro kind "{id}"?',
    deleteMacroKindDetail: 'Macros that use this kind will render with the fallback badge color until re-classified.',
    deleteMacroKindFailed: 'Delete macro kind failed: {error}',
    macroKindDeletedReferenced: { arg: 'count', one: 'Deleted macro kind "{id}". {count} macro now references an unknown kind.', other: 'Deleted macro kind "{id}". {count} macros now reference an unknown kind.' },
    macroKindDeleted: 'Deleted macro kind "{id}".',
    deleteLibraryPrompt: 'Delete library "{slug}"?',
    deleteLibraryDetail: 'The library directory (meta.json + graph.json) moves to the OS trash. Entries referenced by the library remain in the shared pool.',
    deleteLibraryFailed: 'Delete library failed: {error}',
    libraryDeleted: 'Deleted library "{slug}". Underlying entries were NOT touched.',
    deletePackagePrompt: 'Delete macro package "{file}"?',
    deletePackageDetail: 'The package file is removed and the package is dropped from active_macro_packages. Macros defined only in this package become unresolved until re-added elsewhere.',
    packageDeleted: 'Deleted macro package "{file}".',
    packageNotFound: 'Macro package "{file}" not found.',
    deletePackageFailed: 'Delete macro package failed: {error}',
    traceOn: 'SNL panel timing trace ON — open a panel, then check the "SNL Trace" output channel.',
    traceOff: 'SNL panel timing trace OFF.',
    traceChannel: 'SNL Trace',
    unsafeOpenPackage: 'Refusing to open macro package with unsafe name: "{file}".',
    unsafeCreateMacro: 'Refusing to create a macro in package with unsafe name: "{file}".',
    unsafeEditMacro: 'Refusing to edit a macro in package with unsafe name: "{file}".',
    deleteRelationshipPrompt: 'Delete relationship "{id}"?',
    deleteRelationshipDetail: 'The edge is removed from the pool-wide relationship graph. Endpoint entries are NOT touched.',
    deleteRelationshipFailed: 'Delete relationship failed: {error}',
    relationshipDeleted: 'Deleted relationship "{id}".',
    regenerateNoWorkspace: 'SNL: Regenerate Dependencies requires an open folder.',
    scopeWholePool: 'the whole entry pool',
    scopeEntries: { arg: 'count', one: '{count} entry', other: '{count} entries' },
    regeneratePrompt: 'Regenerate dependency relationships for {scope}?',
    regenerateDetail: 'Scans each entry\'s SNL content for macro uses, resolves each macro\'s source.entries[] and emits a "depends" edge per (entry, source) pair.\n\nUser-authored relationships (label ≠ "depends" or missing generator tag) are preserved. Auto rows outside the scope are also preserved. Atomicity (metadata.isAtomic) is recomputed globally over the merged depends-graph.',
    regenerateAction: 'Regenerate',
    regenerateFailed: 'Regenerate dependencies failed: {error}',
    regenerateSuccess: 'Dependencies regenerated. +{added} / ~{updated} / −{removed}. {depends} "depends" edges, {usesContext} "uses_context" edges ({atomic} atomic total). {preserved} user-authored rows preserved.',
    createMacroNoWorkspace: 'Open a folder / workspace before creating a macro.',
    listPackagesFailed: 'Failed to list macro packages: {error}',
    noActivePackages: 'No active macro packages. Create one first from the Dashboard.',
    selectPackagePlaceholder: 'Select package for the new macro'
  },
  {
    initNoWorkspace: 'SNL 初始化需要打开文件夹或工作区。',
    initExists: '.SNL_Doc 已存在——请使用“SNL：创建文档库”添加库。',
    initCreated: 'SNL Doc 骨架已初始化。请使用“SNL：创建文档库”添加第一个库。',
    initFailed: 'SNL 初始化失败：{error}',
    pointerNoWorkspace: '无法解析指针：未打开工作区文件夹。',
    loadEntriesFailed: '加载条目失败：{error}',
    entryNotFound: '未找到条目：{id}',
    invalidPointer: '条目 {id} 没有有效的指针。',
    pointerResolutionFailed: '无法解析指针：{error}',
    openFileFailed: '打开文件失败：{error}',
    deleteAction: '删除',
    deleteEntryPrompt: '删除条目“{id}”？',
    deleteEntryDetail: '这会从共享池中移除该条目。引用此 ID 的库大纲和宏源仍可工作，但会显示为“未解析”。',
    deleteEntryFailed: '删除条目失败：{error}',
    entryDeletedDangling: { arg: 'count', other: '已删除条目“{id}”。留下 {count} 个悬空引用（库大纲 / 宏源 / 关系）。' },
    entryDeleted: '已删除条目“{id}”。',
    deleteEntryKindPrompt: '删除条目类型“{id}”？',
    deleteEntryKindDetail: '使用此类型的条目仍可工作，但在更新其类型字段前会显示为“未知类型”。',
    deleteEntryKindFailed: '删除条目类型失败：{error}',
    entryKindDeletedReferenced: { arg: 'count', other: '已删除条目类型“{id}”。现在有 {count} 个条目引用未知类型。' },
    entryKindDeleted: '已删除条目类型“{id}”。',
    deleteMacroKindPrompt: '删除宏类型“{id}”？',
    deleteMacroKindDetail: '使用此类型的宏在重新分类前将以备用徽章颜色显示。',
    deleteMacroKindFailed: '删除宏类型失败：{error}',
    macroKindDeletedReferenced: { arg: 'count', other: '已删除宏类型“{id}”。现在有 {count} 个宏引用未知类型。' },
    macroKindDeleted: '已删除宏类型“{id}”。',
    deleteLibraryPrompt: '删除库“{slug}”？',
    deleteLibraryDetail: '库目录（meta.json + graph.json）将移至系统回收站。该库引用的条目会保留在共享池中。',
    deleteLibraryFailed: '删除库失败：{error}',
    libraryDeleted: '已删除库“{slug}”。底层条目未被修改。',
    deletePackagePrompt: '删除宏包“{file}”？',
    deletePackageDetail: '包文件会被移除，并从 active_macro_packages 中删除。仅在此包中定义的宏会变为未解析，直至在其他位置重新添加。',
    packageDeleted: '已删除宏包“{file}”。',
    packageNotFound: '未找到宏包“{file}”。',
    deletePackageFailed: '删除宏包失败：{error}',
    traceOn: 'SNL 面板计时跟踪已开启——请打开一个面板，然后查看“SNL 跟踪”输出通道。',
    traceOff: 'SNL 面板计时跟踪已关闭。',
    traceChannel: 'SNL 跟踪',
    unsafeOpenPackage: '拒绝打开名称不安全的宏包：“{file}”。',
    unsafeCreateMacro: '拒绝在名称不安全的包中创建宏：“{file}”。',
    unsafeEditMacro: '拒绝在名称不安全的包中编辑宏：“{file}”。',
    deleteRelationshipPrompt: '删除关系“{id}”？',
    deleteRelationshipDetail: '该边会从池级关系图中移除。端点条目不会被修改。',
    deleteRelationshipFailed: '删除关系失败：{error}',
    relationshipDeleted: '已删除关系“{id}”。',
    regenerateNoWorkspace: 'SNL：重新生成依赖关系需要打开文件夹。',
    scopeWholePool: '整个条目池',
    scopeEntries: { arg: 'count', other: '{count} 个条目' },
    regeneratePrompt: '为{scope}重新生成依赖关系？',
    regenerateDetail: '扫描每个条目的 SNL 内容以查找宏用法，解析每个宏的 source.entries[]，并为每个（条目，源）对生成一条“depends”边。\n\n保留用户创建的关系（标签不为“depends”或缺少生成器标记），也保留范围外的自动生成行。metadata.isAtomic 会基于合并后的 depends 图全局重新计算。',
    regenerateAction: '重新生成',
    regenerateFailed: '重新生成依赖关系失败：{error}',
    regenerateSuccess: '依赖关系已重新生成。+{added} / ~{updated} / −{removed}。共 {depends} 条“depends”边、{usesContext} 条“uses_context”边（共 {atomic} 个原子条目）。保留了 {preserved} 条用户创建的记录。',
    createMacroNoWorkspace: '创建宏前请先打开文件夹或工作区。',
    listPackagesFailed: '列出宏包失败：{error}',
    noActivePackages: '没有活动的宏包。请先从仪表板创建一个。',
    selectPackagePlaceholder: '选择新宏所属的包'
  }
);

function hostTranslator() {
  return createHostTranslator(read_extension_preferences().language, UI_MESSAGES);
}

function hostMessage<Key extends keyof typeof UI_MESSAGES.en & string>(
  key: Key,
  ...args: HostTranslatorArgs<(typeof UI_MESSAGES.en)[Key]>
): string {
  return hostTranslator()(key, ...args);
}

/** Regex for safe bare package filenames (path-traversal guard). */
const MACRO_FILE_RE = /^[a-zA-Z0-9_-]+(\.json)?$/;

/**
 * Sanitize a command-arg prefill payload for the Create Macro panel.
 * Command callers can hand us anything; we defensively narrow to the
 * subset CreateMacroPanel understands. Returns `null` on nothing usable.
 */
function sanitizeCreateMacroPrefill(
  value: unknown
): {
  name?: string;
  template?: string;
  mode?: 'formula_inline' | 'formula_display' | 'text';
  copyFrom?: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const out: {
    name?: string;
    template?: string;
    mode?: 'formula_inline' | 'formula_display' | 'text';
    copyFrom?: string;
  } = {};
  if (typeof p.name === 'string' && p.name.length > 0) out.name = p.name;
  if (typeof p.template === 'string' && p.template.length > 0) out.template = p.template;
  if (p.mode === 'formula_inline' || p.mode === 'formula_display' || p.mode === 'text') {
    out.mode = p.mode;
  }
  if (typeof p.copyFrom === 'string' && p.copyFrom.trim()) {
    out.copyFrom = p.copyFrom.trim();
  }
  if (
    out.name === undefined &&
    out.template === undefined &&
    out.mode === undefined &&
    out.copyFrom === undefined
  ) {
    return null;
  }
  return out;
}

/**
 * Run `SNL: Init` directly — no webview, no extra UI step.
 *
 * Init is a one-shot scaffold action with no parameters, so opening a panel
 * just to host a single button was friction with zero payoff. We instead
 * call {@link initSnlDoc} synchronously from the command handler and report
 * via toast notifications.
 *
 * Status mapping (see {@link initSnlDoc}):
 *  - `created` → information toast
 *  - `exists`  → warning toast directing to `SNL: Create Library`
 *  - thrown   → error toast with the underlying message
 */
async function runInit(): Promise<void> {
  const t = hostTranslator();
  const workspaceRoot = firstWorkspaceFolder();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(t('initNoWorkspace'));
    return;
  }
  try {
    const result = await initSnlDoc(workspaceRoot);
    if (result.status === 'exists') {
      vscode.window.showWarningMessage(t('initExists'));
      return;
    }
    vscode.window.showInformationMessage(t('initCreated'));
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(t('initFailed', { error: text }));
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // Cat 2026-07-25: panel opens are "sometimes fast, sometimes slow". One
  // candidate is that the FIRST open of a session also pays for extension
  // activation (module loading, command registration). Stamp it so that
  // shows up on the same timeline instead of being invisible.
  refreshTraceEnabled();
  const activation = startTrace('extension:activate');
  initialize_preferences_host(context);
  const t = hostMessage;
  // Drives the `when` clause of the editor-title 🐱 Dashboard button.
  installSnlDocContextKey(context.subscriptions);
  context.subscriptions.push({
    dispose: () => {
      disposeTraceResources();
      InfoviewPanel.disposeOutput();
      snlDoc.disposeSnlDocResources();
    }
  });
  const openInfoview = vscode.commands.registerCommand(
    'snlDoc.openInfoview',
    (initialLibrarySlug?: unknown) => {
      const slug =
        typeof initialLibrarySlug === 'string' && initialLibrarySlug.trim()
          ? initialLibrarySlug.trim()
          : undefined;
      InfoviewPanel.createOrShow(context.extensionUri, slug);
    }
  );

  // No palette entry (see package.json `when: false`): invoked via
  // executeCommand('snlDoc.openEntryInfoview', entryId) from a Ctrl+click on
  // an EntryRender title or a hover popover.
  const openEntryInfoview = vscode.commands.registerCommand(
    'snlDoc.openEntryInfoview',
    (entryId?: unknown) => {
      if (typeof entryId !== 'string' || !entryId.trim()) {
        return;
      }
      InfoviewPanel.createOrShowForEntry(context.extensionUri, entryId.trim());
    }
  );

  // Manual refresh — force every open Infoview panel (browser + per-entry)
  // to re-fetch its data from disk. The auto-refresh watcher covers the
  // usual write paths (Dashboard save, .SNL_Doc/* edits) but doesn't catch
  // out-of-band writes like `git pull` or external scripts that mutate
  // `.SNL_Doc/`. Cat 2026-07-09.
  const refreshInfoview = vscode.commands.registerCommand(
    'snlDoc.refreshInfoview',
    () => {
      void InfoviewPanel.refreshAll();
    }
  );

  // Reveal a pointer bound to an entry (cat 2026-07-11). Invoked from
  // EntryRender's pointer-jump button via postMessage → the panel's
  // handleMessage → executeCommand('snlDoc.revealEntryPointer', entryId).
  // Resolves the pointer fresh each time (source-of-truth: fs + latest
  // entries.json), so a fixed pointer picks up file edits without a
  // panel reload. On failure, surfaces the diagnostic as an error toast.
  const revealEntryPointer = vscode.commands.registerCommand(
    'snlDoc.revealEntryPointer',
    async (entryId?: unknown) => {
      if (typeof entryId !== 'string' || !entryId.trim()) return;
      const root = firstWorkspaceFolder();
      if (!root) {
        void vscode.window.showErrorMessage(t('pointerNoWorkspace'));
        return;
      }
      const trimmed = entryId.trim();
      let entries: snlDoc.EntryData[];
      try {
        entries = await snlDoc.readEntries(root);
      } catch (err) {
        void vscode.window.showErrorMessage(t('loadEntriesFailed', {
          error: err instanceof Error ? err.message : String(err)
        }));
        return;
      }
      const entry = entries.find((e) => e.id === trimmed);
      if (!entry) {
        void vscode.window.showErrorMessage(t('entryNotFound', { id: trimmed }));
        return;
      }
      const { normalizeEntryPointer, resolveEntryPointer, revealResolvedPointer, describeResolutionFailure } =
        await import('./pointer');
      const pointer = normalizeEntryPointer(entry.pointer);
      if (!pointer) {
        void vscode.window.showErrorMessage(t('invalidPointer', { id: trimmed }));
        return;
      }
      const resolved = await resolveEntryPointer(root, pointer);
      if (resolved.status !== 'ok') {
        void vscode.window.showErrorMessage(t('pointerResolutionFailed', {
          error: describeResolutionFailure(resolved)
        }));
        return;
      }
      try {
        await revealResolvedPointer(resolved);
      } catch (err) {
        void vscode.window.showErrorMessage(t('openFileFailed', {
          error: err instanceof Error ? err.message : String(err)
        }));
      }
    }
  );

  // Delete commands (cat 2026-07-09). Each one: confirm with the user
  // (with reference count from the backend), call the backend, close any
  // matching open editor panel so a re-open doesn't resurrect stale
  // state. The backends themselves report dangling references but don't
  // block — the UX decision "block on refs?" lives here in each command
  // so the different entity types can have different policies.
  const deleteEntry = vscode.commands.registerCommand(
    'snlDoc.deleteEntry',
    async (entryId?: unknown) => {
      const id = typeof entryId === 'string' ? entryId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const deleteAction = t('deleteAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('deleteEntryPrompt', { id }),
        { modal: true, detail: t('deleteEntryDetail') },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      const res = await snlDoc.deleteEntry(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(t('deleteEntryFailed', {
          error: 'message' in res ? res.message : res.status
        }));
        return;
      }
      const refCount =
        res.references.libraryNodes.length +
        res.references.macroSources.length +
        res.references.relationships.length;
      void vscode.window.showInformationMessage(
        refCount > 0
          ? t('entryDeletedDangling', { id, count: refCount })
          : t('entryDeleted', { id })
      );
    }
  );

  const deleteEntryKind = vscode.commands.registerCommand(
    'snlDoc.deleteEntryKind',
    async (kindId?: unknown) => {
      const id = typeof kindId === 'string' ? kindId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const deleteAction = t('deleteAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('deleteEntryKindPrompt', { id }),
        { modal: true, detail: t('deleteEntryKindDetail') },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      const res = await snlDoc.deleteEntryKind(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(t('deleteEntryKindFailed', {
          error: 'message' in res ? res.message : res.status
        }));
        return;
      }
      const n = res.references.entries.length;
      void vscode.window.showInformationMessage(
        n > 0
          ? t('entryKindDeletedReferenced', { id, count: n })
          : t('entryKindDeleted', { id })
      );
    }
  );

  const deleteMacroKind = vscode.commands.registerCommand(
    'snlDoc.deleteMacroKind',
    async (kindId?: unknown) => {
      const id = typeof kindId === 'string' ? kindId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const deleteAction = t('deleteAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('deleteMacroKindPrompt', { id }),
        { modal: true, detail: t('deleteMacroKindDetail') },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      const res = await snlDoc.deleteMacroKind(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(t('deleteMacroKindFailed', {
          error: 'message' in res ? res.message : res.status
        }));
        return;
      }
      const n = res.references.length;
      void vscode.window.showInformationMessage(
        n > 0
          ? t('macroKindDeletedReferenced', { id, count: n })
          : t('macroKindDeleted', { id })
      );
    }
  );

  const deleteLibrary = vscode.commands.registerCommand(
    'snlDoc.deleteLibrary',
    async (slug?: unknown) => {
      const librarySlug = typeof slug === 'string' ? slug.trim() : '';
      if (!librarySlug) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const deleteAction = t('deleteAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('deleteLibraryPrompt', { slug: librarySlug }),
        { modal: true, detail: t('deleteLibraryDetail') },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      const res = await snlDoc.deleteLibrary(root, librarySlug);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(t('deleteLibraryFailed', {
          error: 'message' in res ? res.message : res.status
        }));
        return;
      }
      void vscode.window.showInformationMessage(t('libraryDeleted', { slug: librarySlug }));
    }
  );

  const deleteMacroPackage = vscode.commands.registerCommand(
    'snlDoc.deleteMacroPackage',
    async (file?: unknown) => {
      const raw = typeof file === 'string' ? file.trim() : '';
      if (!raw) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const deleteAction = t('deleteAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('deletePackagePrompt', { file: raw }),
        { modal: true, detail: t('deletePackageDetail') },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      const res = await snlDoc.deleteMacroPackage(root, raw);
      if (res.status === 'ok') {
        void vscode.window.showInformationMessage(t('packageDeleted', { file: res.file }));
      } else if (res.status === 'noFile') {
        void vscode.window.showWarningMessage(t('packageNotFound', { file: raw }));
      } else {
        void vscode.window.showErrorMessage(t('deletePackageFailed', { error: res.message }));
      }
    }
  );

  const init = vscode.commands.registerCommand('snlDoc.init', runInit);

  const createLibrary = vscode.commands.registerCommand(
    'snlDoc.createLibrary',
    () => {
      CreateLibraryPanel.createOrShow(context.extensionUri);
    }
  );

  // Edit by slug. Slug validation is intentionally light — we trust it
  // because it comes either from the Dashboard's overview (i.e. from disk)
  // or from the user's own config. The panel re-verifies existence when
  // reading context.
  const editLibrary = vscode.commands.registerCommand(
    'snlDoc.editLibrary',
    (slug?: unknown) => {
      if (typeof slug !== 'string' || !slug.trim()) {
        return;
      }
      CreateLibraryPanel.editOrShow(context.extensionUri, slug.trim());
    }
  );

  const openDashboard = vscode.commands.registerCommand(
    'snlDoc.openDashboard',
    () => {
      DashboardPanel.createOrShow(context.extensionUri);
    }
  );

  const checkDataVersionCommand = vscode.commands.registerCommand(
    'snlDoc.checkDataVersion',
    async () => checkDataVersion(firstWorkspaceFolder())
  );
  const repairDataCommand = vscode.commands.registerCommand(
    'snlDoc.repairData',
    async () => repairData(firstWorkspaceFolder())
  );

  // Panel timing diagnostics (cat 2026-07-25). Off by default; the command
  // flips it for the session so you can capture one open without editing
  // settings, and the config change listener keeps the two in sync.
  refreshTraceEnabled();
  const toggleTrace = vscode.commands.registerCommand(
    'snlDoc.toggleTrace',
    () => {
      const now = setTraceEnabled(!isTraceEnabled());
      void vscode.window.showInformationMessage(
        now ? t('traceOn') : t('traceOff')
      );
    }
  );
  const traceConfigWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('snlDoc.trace')) refreshTraceEnabled();
  });

  // Cat 2026-07-26: settles per-window-boot vs per-panel for the ~1.09s that
  // every panel pays before our code runs. Reports into the same "SNL Trace"
  // channel. See webviewCostProbe.ts for why guessing was not an option.
  const probeChannel =
    traceChannel() ?? vscode.window.createOutputChannel(t('traceChannel'));
  const probeWebviewCost = registerWebviewCostProbe(probeChannel);

  const initEntryKinds = vscode.commands.registerCommand(
    'snlDoc.initEntryKinds',
    () => {
      InitEntryKindsPanel.createOrShow(context.extensionUri);
    }
  );

  const createEntryKind = vscode.commands.registerCommand(
    'snlDoc.createEntryKind',
    () => {
      CreateEntryKindPanel.createOrShow(context.extensionUri);
    }
  );

  const editEntryKind = vscode.commands.registerCommand(
    'snlDoc.editEntryKind',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateEntryKindPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const initMacroKinds = vscode.commands.registerCommand(
    'snlDoc.initMacroKinds',
    () => {
      InitMacroKindsPanel.createOrShow(context.extensionUri);
    }
  );

  const createMacroKind = vscode.commands.registerCommand(
    'snlDoc.createMacroKind',
    () => {
      CreateMacroKindPanel.createOrShow(context.extensionUri);
    }
  );

  const editMacroKind = vscode.commands.registerCommand(
    'snlDoc.editMacroKind',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateMacroKindPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const createEntry = vscode.commands.registerCommand(
    'snlDoc.createEntry',
    (seedId?: unknown) => {
      // Cat 2026-07-15: optional `seedId` from callers that already know
      // the intended entry id (e.g. Library outline's Add form when the
      // user typed an id that doesn't exist yet). CreateEntryPanel uses
      // it to prefill the id field instead of minting a fresh UUID.
      const seed =
        typeof seedId === 'string' && seedId.trim() ? seedId.trim() : undefined;
      CreateEntryPanel.createOrShow(context.extensionUri, seed);
    }
  );

  const editEntry = vscode.commands.registerCommand(
    'snlDoc.editEntry',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) {
        return;
      }
      CreateEntryPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const createMacroPackage = vscode.commands.registerCommand(
    'snlDoc.createMacroPackage',
    () => {
      CreateMacroPackagePanel.createOrShow(context.extensionUri);
    }
  );

  const editMacroPackage = vscode.commands.registerCommand(
    'snlDoc.editMacroPackage',
    (file?: unknown) => {
      if (typeof file !== 'string' || !MACRO_FILE_RE.test(file)) {
        return;
      }
      CreateMacroPackagePanel.editOrShow(context.extensionUri, file);
    }
  );

  // No palette entry (see package.json `when: false`): invoked via
  // executeCommand('snlDoc.openMacroPackage', file) from the Dashboard row
  // click and from CreateMacroPackagePanel after a successful create.
  const openMacroPackage = vscode.commands.registerCommand(
    'snlDoc.openMacroPackage',
    (file?: unknown) => {
      if (typeof file !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(t('unsafeOpenPackage', { file }));
        return;
      }
      PackagePanel.createOrShow(context.extensionUri, file);
    }
  );

  // No palette entry: invoked via executeCommand('snlDoc.createMacro', file, prefill?)
  // from a PackagePanel's "+ Create Macro" bar or the Entry GUI editor's
  // per-row "↗ new" button (cat 2026-07-12; prefill carries env_mode-→
  // mode + template, or a bare name).
  const createMacro = vscode.commands.registerCommand(
    'snlDoc.createMacro',
    (file?: unknown, prefill?: unknown) => {
      if (typeof file !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(t('unsafeCreateMacro', { file }));
        return;
      }
      CreateMacroPanel.createOrShow(
        context.extensionUri,
        file,
        sanitizeCreateMacroPrefill(prefill)
      );
    }
  );

  // No palette entry: invoked via executeCommand('snlDoc.editMacro', file, macroName)
  // from a PackagePanel's clickable macro row.
  const editMacro = vscode.commands.registerCommand(
    'snlDoc.editMacro',
    (file?: unknown, macroName?: unknown) => {
      if (typeof file !== 'string' || typeof macroName !== 'string') {
        return;
      }
      if (!MACRO_FILE_RE.test(file)) {
        vscode.window.showErrorMessage(t('unsafeEditMacro', { file }));
        return;
      }
      if (!macroName.trim()) {
        return;
      }
      CreateMacroPanel.editOrShow(context.extensionUri, file, macroName.trim());
    }
  );

  // Relationship editor commands (cat 2026-07-10). Create/edit route to
  // the shared CreateRelationshipPanel; delete goes through the same
  // modal-confirm dance as other entities.
  const createRelationship = vscode.commands.registerCommand(
    'snlDoc.createRelationship',
    () => {
      CreateRelationshipPanel.createOrShow(context.extensionUri);
    }
  );

  const editRelationship = vscode.commands.registerCommand(
    'snlDoc.editRelationship',
    (id?: unknown) => {
      if (typeof id !== 'string' || !id.trim()) return;
      CreateRelationshipPanel.editOrShow(context.extensionUri, id.trim());
    }
  );

  const deleteRelationship = vscode.commands.registerCommand(
    'snlDoc.deleteRelationship',
    async (relId?: unknown) => {
      const id = typeof relId === 'string' ? relId.trim() : '';
      if (!id) return;
      const root = firstWorkspaceFolder();
      if (!root) return;
      const deleteAction = t('deleteAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('deleteRelationshipPrompt', { id }),
        {
          modal: true,
          detail: t('deleteRelationshipDetail')
        },
        deleteAction
      );
      if (confirmed !== deleteAction) return;
      const res = await snlDoc.deleteRelationship(root, id);
      if (res.status !== 'ok') {
        void vscode.window.showErrorMessage(t('deleteRelationshipFailed', {
          error: 'message' in res ? res.message : res.status
        }));
        return;
      }
      void vscode.window.showInformationMessage(t('relationshipDeleted', { id }));
    }
  );

  // Graph viewer commands (cat 2026-07-10 Phase 2). Pool-wide entry
  // point (palette) + per-library entry point (from Infoview library
  // page). Both open the same GraphPanel class with different scopes.
  const openInfoviewGraph = vscode.commands.registerCommand(
    'snlDoc.openInfoviewGraph',
    () => {
      GraphPanel.openPool(context.extensionUri);
    }
  );

  const openInfoviewGraphForLibrary = vscode.commands.registerCommand(
    'snlDoc.openInfoviewGraphForLibrary',
    (slug?: unknown) => {
      if (typeof slug !== 'string' || !slug.trim()) return;
      GraphPanel.openForLibrary(context.extensionUri, slug.trim());
    }
  );

  // Auto-generate dependency relationships from macro-source scanning
  // (cat 2026-07-10 §3). Two entry points:
  //   - pool-wide  (Dashboard button, palette command)
  //   - per-entry  (invoked from Entry editor after a save — future)
  const regenerateDependencies = vscode.commands.registerCommand(
    'snlDoc.regenerateDependencies',
    async (scopeArg?: unknown) => {
      const root = firstWorkspaceFolder();
      if (!root) {
        vscode.window.showErrorMessage(t('regenerateNoWorkspace'));
        return;
      }
      // scopeArg shape: undefined → pool-wide; { entryIds: string[] } → subset.
      let scope: { entryIds: Set<string> | null } = { entryIds: null };
      if (
        scopeArg &&
        typeof scopeArg === 'object' &&
        Array.isArray((scopeArg as { entryIds?: unknown }).entryIds)
      ) {
        const arr = (scopeArg as { entryIds: string[] }).entryIds.filter(
          (x) => typeof x === 'string' && x.trim()
        );
        scope = { entryIds: new Set(arr) };
      }
      const scopeLabel =
        scope.entryIds === null
          ? t('scopeWholePool')
          : t('scopeEntries', { count: scope.entryIds.size });
      const regenerateAction = t('regenerateAction');
      const confirmed = await vscode.window.showWarningMessage(
        t('regeneratePrompt', { scope: scopeLabel }),
        {
          modal: true,
          detail: t('regenerateDetail')
        },
        regenerateAction
      );
      if (confirmed !== regenerateAction) return;
      const res = await snlDoc.regenerateDependencyRelationships(root, scope);
      if (res.status !== 'ok') {
        vscode.window.showErrorMessage(t('regenerateFailed', {
          error: 'message' in res ? res.message : res.status
        }));
        return;
      }
      const r = res.report;
      vscode.window.showInformationMessage(t('regenerateSuccess', {
        added: r.added,
        updated: r.updated,
        removed: r.removed,
        depends: r.totalDepends,
        usesContext: r.totalUsesContext,
        atomic: r.atomicCount,
        preserved: r.preservedUser
      }));
    }
  );

  const openSnoogL = vscode.commands.registerCommand(
    'snlDoc.openSnoogL',
    (initialMode?: unknown) => {
      const mode =
        initialMode === 'macro' || initialMode === 'entry'
          ? (initialMode as 'entry' | 'macro')
          : 'entry';
      SnoogLPanel.open(context.extensionUri, mode);
    }
  );

  // Cat 2026-07-13: Dashboard's SNL Macros header wants a "+ Create
  // Macro" button in the collapsed-row header, but Create Macro requires
  // a target package file. Show a QuickPick over the ACTIVE macro
  // packages first, then delegate to snlDoc.createMacro with the pick.
  const createMacroPickPackage = vscode.commands.registerCommand(
    'snlDoc.createMacroPickPackage',
    async () => {
      const rootUri = (() => {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri : undefined;
      })();
      if (!rootUri) {
        void vscode.window.showErrorMessage(t('createMacroNoWorkspace'));
        return;
      }
      let packages: { file: string }[];
      try {
        const { readMacroPackages, resolveActiveMacroPackages } = await import(
          './snlDoc'
        );
        const active = new Set(await resolveActiveMacroPackages(rootUri));
        const all = await readMacroPackages(rootUri);
        packages = all
          // `active` holds BARE names; `p.file` carries `.json`, so comparing
          // them directly never matched and this list was always empty.
          .filter((p) => active.has(p.file.replace(/\.json$/i, '')))
          .map((p) => ({ file: p.file }));
      } catch (err) {
        void vscode.window.showErrorMessage(t('listPackagesFailed', {
          error: err instanceof Error ? err.message : String(err)
        }));
        return;
      }
      if (packages.length === 0) {
        void vscode.window.showInformationMessage(t('noActivePackages'));
        return;
      }
      let file: string;
      if (packages.length === 1) {
        file = packages[0].file;
      } else {
        const pick = await vscode.window.showQuickPick(
          packages.map((p) => ({ label: p.file, file: p.file })),
          { placeHolder: t('selectPackagePlaceholder') }
        );
        if (!pick) return;
        file = pick.file;
      }
      await vscode.commands.executeCommand('snlDoc.createMacro', file);
    }
  );

  context.subscriptions.push(
    openInfoview,
    openEntryInfoview,
    refreshInfoview,
    revealEntryPointer,
    deleteEntry,
    deleteEntryKind,
    deleteMacroKind,
    deleteLibrary,
    deleteMacroPackage,
    init,
    createLibrary,
    editLibrary,
    openDashboard,
    checkDataVersionCommand,
    repairDataCommand,
    toggleTrace,
    traceConfigWatcher,
    probeWebviewCost,
    initEntryKinds,
    createEntryKind,
    editEntryKind,
    initMacroKinds,
    createMacroKind,
    editMacroKind,
    createEntry,
    editEntry,
    createMacroPackage,
    editMacroPackage,
    openMacroPackage,
    createMacro,
    editMacro,
    createRelationship,
    editRelationship,
    deleteRelationship,
    openInfoviewGraph,
    openInfoviewGraphForLibrary,
    regenerateDependencies,
    openSnoogL,
    createMacroPickPackage
  );
  activation.mark('done');
}

export function deactivate(): void {
  // no-op
}
