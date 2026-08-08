// SNL Create Entry webview: the Entry editor MVP.
//
// Layout (top → bottom):
//   1. Header    — Title + ID (UUID, regenerate)
//   2. Kind      — dropdown seeded from config.json#entry_kinds
//   3. Preview   — kind-aware live box (stroke + background + mock number)
//   4. Content   — SNL / Typst / LaTeX / Markdown / Text tabs (each its own
//                  textarea; SNL has a Text / GUI (Inductive) sub-switch)
//   5. Relationships — edit-only, collapsed by default
//   6. Contributor — temporary single-string field, collapsed by default
//   7. Pointer     — schema-driven source binding editor, collapsed by default
//   8. Submit/Cancel + result banner
//
// SNL rendering uses one merged MacroDataDriver: bundled macros overridden
// by every macro in every package in the current workspace, shipped via the
// `context` message from createEntryPanel. See 猫猫 2026-07-04 spec 2:
// "Entry 编辑器的 SNL parser 几乎等于没实装 ... 先把它做成能正常根据项目
// 中已有的 Macro 来进行 Parse 和渲染的模式."
//
// {t('guiInductive')} wraps @sjtu-ai4math/snl-basics's SnlSyntaxTreeEditor with
// a Add-child / Remove-node control layer, and syncs bidirectionally with
// the SNL text via parse/serialize round-trips. 猫猫 spec 3: "把 SNL-Basics
// 里的 Syntax Tree Editor 先给它搬过来，变成 {t('guiInductive')}".

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
import './entry-editor/canvas.css';
import {
  tryParseSnlSyntaxTree,
  createSnlSyntaxTreeNode,
  SnlSyntaxTreeView,
  SnlDslFormatter,
  DEFAULT_KIND_PALETTE,
  read_localized,
  resolve_style_template,
  type I18n,
  type Localized,
  type MacroDataDriver,
  type SnlMacro,
  type SnlSyntaxTree,
  type KindColoring,
  type KindPalette
} from '@sjtu-ai4math/snl-basics';
import {
  getVsCodeApi,
  useVsCodeApiRef,
  PANEL_STYLE
} from './vscodeApi';
import { traceFirstPaint, traceMark } from './runtime/trace';
import {
  EntryRelationshipsSection,
  type EntryRelationshipRow
} from './components/EntryRelationshipsSection';
import { PanelHeader } from './components/PanelHeader';
import { MissingEditorTarget } from './components/MissingEditorTarget';
import { Button } from './components/Button';
import { Icon } from './components/Icon';
import { IconButton } from './components/IconButton';
import { MenuItemButton } from './components/MenuItemButton';
import { TabButton, TabList } from './components/Tabs';
import { Disclosure } from './components/Disclosure';
import {
  TreeNodeActionDashboard,
  type TreeNodeActionCommand
} from './components/TreeNodeActionDashboard';
import { MacroIdInput } from './components/MacroIdInput';
import { isEntityIdUnique } from './components/formValidation';
import { ensureTreeIdentity, inheritTreeIdentity, treeIdentity } from './components/treeIdentity';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES
} from './components/EntityIdSearchBox';
import {
  EntrySurface,
  type EntryOption,
  type EntryData,
  type EntryKind as RenderEntryKind
} from './render/EntrySurface';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import { wireMacroToRenderable, type WireMacro } from './render/macroWire';
import {
  createMacroDataDriver,
  type MacroRecord
} from './render/macroData';
import { mergeDraftIntoEntryPool } from './render/entryPreviewPool';
import { extensionRenderers } from './render/blockRenderers';
import {
  attachCanvasRoot,
  canPersistCanvasForest,
  deleteCanvasTarget,
  detachCanvasSubtree,
  isCanvasHole,
  moveCanvasCursor,
  reconcileCanvasArity,
  replaceCanvasTarget,
  setCanvasDynamicArity
} from './entry-editor/canvasForest';
import { loadDraft, saveDraft, usePersistedDraft, useSaveShortcut } from './components/draftState';
import { merge_localized_projection } from './runtime/localizedDraft';
import {
  get_formatter_preferences,
  use_preferences_revision,
  webview_language_runtime
} from './runtime/preferencesRuntime';
import {
  macroKindsToPalette,
  type MacroKindPaletteSource
} from './render/macroKindPalette';
import type { SnooglSearchCandidate } from '../../src/snooglSearch';
import { defineUiMessages, useUiMessages, type UiTranslator } from './i18n/uiMessages';
import { MonacoTextEditor } from './entry-editor/MonacoTextEditor';


export const CREATE_ENTRY_MESSAGES = defineUiMessages('createEntry', {
  chooseProjectFile: 'Choose a project-relative file.',
  relativeProjectPath: 'The file path must be relative to the project root.',
  pathCannotLeaveRoot: 'The file path cannot leave the project root.',
  positiveStartLine: 'Start line must be a positive integer.',
  validEndLine: 'End line must be a positive integer at or after the start line.',
  regexRequired: 'Regex pattern cannot be empty.',
  invalidRegex: 'Invalid regular expression: {message}',
  positiveOccurrence: 'Occurrence must be a positive integer.',
  cannotSaveNoKinds: 'Cannot save yet — no Entry kinds are defined.',
  cannotSaveTitle: 'Cannot save yet — the title is empty.',
  cannotSaveId: 'Cannot save yet — the id is empty.',
  cannotSaveDuplicateId: 'Cannot save yet — the id "{id}" is already taken.',
  cannotSaveKind: 'Cannot save yet — pick a kind first.',
  cannotSavePackage: 'Cannot save yet — pick an existing Entry Package first.',
  cannotSaveReason: 'Cannot save yet — {reason}',
  cannotSave: 'Cannot save yet.',
  cannotSaveLooseCanvas: 'Cannot save yet — the Canvas has several loose blocks. Attach them first.',
  cannotSaveCanvasSlot: 'Cannot save yet — a Macro has a single unfilled slot, which cannot be written to SNL.',
  editEntry: 'Edit Entry',
  createEntry: 'Create Entry',
  editEntryHeader: 'Edit entry',
  createEntryHeader: 'Create entry',
  editTitle: 'Edit title',
  dashboard: 'Dashboard',
  backDashboard: 'Back to Dashboard',
  viewInfoview: 'View in Infoview',
  openEntryInfoview: 'Open entry "{id}" in the Infoview reading surface',
  noKindsBefore: 'No entry kinds defined — run',
  initializeKinds: 'Initialize Entry Kinds',
  noKindsAfter: 'first. The form is disabled until at least one kind exists.',
  title: 'Title',
  titlePlaceholder: 'e.g. Pythagorean Theorem',
  idReadonly: 'ID (readonly)',
  id: 'ID',
  idPlaceholder: 'e.g. pythagorean-theorem',
  immutableIdTitle: 'IDs are immutable; delete + recreate to rename',
  overwriteUuidTitle: 'Overwrite the ID with a fresh UUID v4 (tolerated but not preferred — semantic ids are strongly preferred)',
  fillUuidTitle: 'Fill the ID with a fresh UUID v4 (only when no meaningful semantic id fits)',
  regenerateUuid: 'Regenerate UUID',
  useUuid: 'Use UUID instead',
  immutableIdHint: 'IDs are stable references used by relationship links; they cannot be edited here.',
  semanticIdHint: "Prefer a semantic id like 'pythagorean-theorem' or 'context-linalg-vars' — human-readable ids render better in cross-entry references (macro sources, library graph nodes, bvar `x@<id>` context refs). The UUID button is a fallback for when no meaningful name fits. IDs are immutable once created.",
  package: 'Entry Package',
  createPackage: 'Create Entry Package',
  newPackageId: 'New Entry Package ID',
  packageIdPlaceholder: 'e.g. algebra',
  addPackage: 'Add Entry Package',
  cancelPackageCreate: 'Cancel',
  packageCreating: 'Creating…',
  missingPackageOption: '{packageId} (missing; choose another Entry Package)',
  unpackaged: 'Unpackaged (_unpackaged)',
  missingPackage: 'The selected Entry Package no longer exists. Your draft was preserved; choose another Entry Package before saving.',
  packageHint: 'Entry Package membership may be changed later; moving an Entry preserves its ID and references.',
  kind: 'Entry kind',
  kindSelection: 'Entry kind: {name}',
  kindDetails: 'id {id}; stroke {stroke}; background {background}',
  unsupportedFormat: '{format} editing is not supported yet',
  kindColors: 'stroke {stroke} / background {background}',
  livePreview: 'Live Preview',
  newEntryId: '(new-entry)',
  content: 'Content',
  textFormat: 'Text',
  editorMode: 'SNL editor mode',
  guiCanvas: 'GUI Editor (Canvas)',
  guiInductive: 'GUI Editor (Inductive)',
  textEditor: 'Text Editor',
  sourcePlaceholder: '{format} source…',
  sourceEditorLabel: '{format} source editor',
  formatSnl: 'Format SNL',
  formatShortcut: 'Shift+Alt+F',
  formatFailed: 'Could not format SNL: {error}',
  contributor: 'Contributor',
  contributorPlaceholder: 'e.g. Ada Lovelace',
  contributorTemporary: 'Temporary single-string field — this Contributor shape may change.',
  pointer: 'Pointer',
  canvasMultipleRoots: 'Save is disabled while the Canvas syntax forest has multiple roots. Attach the loose blocks or reset the Canvas.',
  canvasSingleSlot: 'Save is disabled because a Macro has a single unfilled slot, which cannot be written to SNL — an empty slot needs a comma, so give that Macro another argument or fill the slot.',
  updating: 'Updating…',
  creating: 'Creating…',
  updateEntry: 'Update Entry',
  resetBanner: 'Reset banner',
  cancel: 'Cancel',
  sectionToggle: '{title} — {action} section',
  collapse: 'collapse',
  expand: 'expand',
  bindSource: 'Bind this Entry to a source location',
  projectRelativeFile: 'Project-relative file',
  projectFilePlaceholder: 'e.g. src/theorems/pythagorean.ts',
  mode: 'Mode',
  lineRange: 'Line range',
  regularExpression: 'Regular expression',
  startLine: 'Start line',
  endLine: 'End line (optional)',
  sameAsStart: 'same as start',
  regexPattern: 'Regex pattern',
  regexPlaceholder: 'e.g. function\\s+provePythagorean',
  regexFlags: 'Regex flags (optional)',
  exampleIm: 'e.g. im',
  occurrence: 'Occurrence (optional)',
  pointerHint: 'Paths are resolved from the project root. Line numbers and regex occurrences are 1-indexed.',
  noPointer: 'No source location is attached. Enable the binding to choose a file and addressing mode.',
  canvasAria: 'GUI Editor canvas',
  editFocusedSnl: 'Edit focused SNL',
  editMacroInput: 'Edit this block’s Macro; Enter commits, Shift+Enter adds a line',
  enterSnlDsl: 'Enter SNL DSL; Enter commits, Shift+Enter adds a line',
  insertCanvasRoot: 'Insert Canvas root Macro',
  argumentCount: 'Argument count',
  macroActions: 'Macro actions',
  removeArgument: 'Remove an argument',
  argumentCountValue: 'Argument count value',
  addArgument: 'Add argument',
  macroStyle: 'Macro style',
  selectMacroStyle: 'Select Macro style',
  clearStyle: '(clear style)',
  missing: '(missing)',
  defaultSuffix: ' (default)',
  editMacro: 'Edit macro',
  createMacro: 'Create macro',
  openEditMacro: 'Open Edit Macro: {name} ({origin})',
  openCreateMacroPrefill: 'Open Create Macro (prefill id "{name}")',
  resetCanvas: 'Reset Canvas from SNL',
  addRootMacro: 'Add root Macro',
  editMacroMenu: 'Edit Macro',
  editSubtreeSnl: 'Edit subtree as SNL',
  detachBlock: 'Detach into its own block',
  delete: 'Delete',
  canvasBlockActions: 'Canvas block actions',
  macroEditSingleId: 'Macro edit accepts a single macro id; use Ctrl+F2 to edit the subtree.',
  macroEditNameOnly: 'Macro edit accepts a Macro name only; use the Style dropdown.',
  unparseableSnl: 'Text-mode SNL is not parseable ({error}). Tree shown reflects the last successful parse; editing here will overwrite the Text content on next change.',
  inductiveHelp: 'Inductive editor — hover a row for the action dial. Delimited forms are recognized: $foo$, $$x+y$$, %text%, @$x$. A suffix @ opens the Context Entry ID input. Choose Style from the adjacent dropdown.',
  expandNode: 'Expand',
  collapseNode: 'Collapse',
  rootMacroPlaceholder: 'root macro',
  leafPlaceholder: 'name / $expr$ / %text% / @…',
  kindTooltip: 'kind: {kind}{source}',
  envModeSource: ' (from env_mode)',
  macroNotFound: 'name does not match any macro in the current DB',
  contextEntryId: 'Context Entry ID',
  entryId: 'Entry ID',
  unresolvedMacro: 'unresolved Macro',
  macroStyleFor: 'Macro style for {name}',
  missingStyle: 'Style [{style}] is missing; choose clear or a declared Style',
  styleUnavailable: 'Style unavailable — name does not match a Macro with styles',
  explicitStyle: 'explicit style: [{style}]',
  implicitStyle: 'default style (implicit): [{style}]',
  openCreateMacroText: 'Open Create Macro (text mode, prefill "{name}")',
  openCreateMacroInline: 'Open Create Macro (formula_inline, prefill "{name}")',
  openCreateMacroDisplay: 'Open Create Macro (formula_display, prefill "{name}")',
  openCreateMacroBlank: 'Open Create Macro (blank)',
  moveUpAvailable: 'Move up — swap with preceding sibling',
  moveUpUnavailable: 'Cannot move up — already first',
  moveUp: 'Move up',
  outdentAvailable: 'Outdent — move up one level',
  outdentUnavailable: 'Cannot outdent — already at top-level',
  outdent: 'Outdent',
  chooseAddPosition: 'Choose where to add a node',
  chooseAddPositionAria: 'Choose add position',
  indentAvailable: 'Indent — become child of preceding sibling',
  indentUnavailable: 'Cannot indent — no preceding sibling',
  indent: 'Indent',
  moveDownAvailable: 'Move down — swap with following sibling',
  moveDownUnavailable: 'Cannot move down — already last',
  moveDown: 'Move down',
  addNodePosition: 'Add node position',
  addParent: 'Add parent',
  addParentTitle: 'Add a parent around this node',
  parent: 'parent',
  addChild: 'Add child',
  addChildTitle: 'Add a child under this node',
  child: 'child',
  addSibling: 'Add sibling',
  rootNoSibling: 'Root cannot have a sibling',
  addSiblingTitle: 'Add a sibling after this node',
  sibling: 'sibling',
  deleteSubtreeTitle: 'Delete this subtree',
  deleteSubtree: 'Delete subtree',
  createdStatus: '✅ Created entry (id: {id}).',
  updatedStatus: '✅ Updated entry (id: {id}).',
  warningStatus: '⚠️ {message}',
  errorStatus: '❌ {message}',
  invalidStatus: '❌ Invalid: {message}'
}, {
  chooseProjectFile: '请选择项目相对路径文件。',
  relativeProjectPath: '文件路径必须相对于项目根目录。',
  pathCannotLeaveRoot: '文件路径不能超出项目根目录。',
  positiveStartLine: '起始行必须是正整数。',
  validEndLine: '结束行必须是大于或等于起始行的正整数。',
  regexRequired: '正则表达式不能为空。',
  invalidRegex: '无效的正则表达式：{message}',
  positiveOccurrence: '匹配序号必须是正整数。',
  cannotSaveNoKinds: '尚无法保存——未定义任何条目种类。',
  cannotSaveTitle: '尚无法保存——标题为空。',
  cannotSaveId: '尚无法保存——ID 为空。',
  cannotSaveDuplicateId: '尚无法保存——ID“{id}”已被占用。',
  cannotSaveKind: '尚无法保存——请先选择种类。',
  cannotSavePackage: '尚无法保存——请先选择现有条目包。',
  cannotSaveReason: '尚无法保存——{reason}',
  cannotSave: '尚无法保存。',
  cannotSaveLooseCanvas: '尚无法保存——画布中有多个未连接的块。请先将其连接。',
  cannotSaveCanvasSlot: '尚无法保存——某个宏仅有一个未填槽位，无法写入 SNL。',
  editEntry: '编辑条目', createEntry: '创建条目', editEntryHeader: '编辑条目', createEntryHeader: '创建条目', editTitle: '编辑标题', dashboard: '仪表板', backDashboard: '返回仪表板',
  viewInfoview: '在信息视图中查看', openEntryInfoview: '在信息视图阅读界面中打开条目“{id}”',
  noKindsBefore: '未定义条目种类——请先运行', initializeKinds: '初始化条目种类', noKindsAfter: '。在至少存在一种条目种类之前，表单将被禁用。',
  title: '标题', titlePlaceholder: '例如：勾股定理', idReadonly: 'ID（只读）', id: 'ID', idPlaceholder: '例如：pythagorean-theorem',
  immutableIdTitle: 'ID 不可变；如需重命名，请删除后重新创建',
  overwriteUuidTitle: '用新的 UUID v4 覆盖 ID（允许但不推荐——强烈建议使用语义化 ID）',
  fillUuidTitle: '用新的 UUID v4 填充 ID（仅当没有合适的语义化 ID 时使用）', regenerateUuid: '重新生成 UUID', useUuid: '改用 UUID',
  immutableIdHint: 'ID 是关系链接使用的稳定引用，无法在此处编辑。',
  semanticIdHint: "建议使用 'pythagorean-theorem' 或 'context-linalg-vars' 等语义化 ID——人类可读的 ID 在跨条目引用（宏源、库图节点、bvar `x@<id>` 上下文引用）中显示效果更好。没有合适名称时才使用 UUID 按钮。ID 创建后不可变。",
  package: '条目包', createPackage: '创建条目包', newPackageId: '新条目包 ID', packageIdPlaceholder: '例如：algebra', addPackage: '添加条目包', cancelPackageCreate: '取消', packageCreating: '正在创建…', missingPackageOption: '{packageId}（已丢失；请选择其他条目包）', unpackaged: '未归入条目包（_unpackaged）',
  missingPackage: '所选条目包已不存在。草稿已保留；保存前请选择其他条目包。', packageHint: '以后可以更改条目包归属；移动条目会保留其 ID 和引用。',
  kind: '条目类别', kindSelection: '条目类别：{name}', kindDetails: 'ID {id}；描边 {stroke}；背景 {background}', unsupportedFormat: '暂不支持编辑 {format}', kindColors: '描边 {stroke} / 背景 {background}', livePreview: '实时预览', newEntryId: '（新条目）', content: '内容', textFormat: '文本',
  editorMode: 'SNL 编辑器模式', guiCanvas: 'GUI 编辑器（画布）', guiInductive: 'GUI 编辑器（归纳式）', textEditor: '文本编辑器', sourcePlaceholder: '{format} 源代码…',
  sourceEditorLabel: '{format} 源代码编辑器', formatSnl: '格式化 SNL', formatShortcut: 'Shift+Alt+F', formatFailed: '无法格式化 SNL：{error}', contributor: '贡献者', contributorPlaceholder: '例如：艾达·洛芙莱斯', contributorTemporary: '临时单字符串字段——此贡献者数据结构将来可能更改。', pointer: '指针',
  canvasMultipleRoots: '画布语法森林有多个根节点时无法保存。请连接未附着的块或重置画布。',
  canvasSingleSlot: '某个宏只有一个未填槽位，无法写入 SNL，因此无法保存——空槽位需要逗号；请为该宏再添加一个参数或填充此槽位。',
  updating: '正在更新…', creating: '正在创建…', updateEntry: '更新条目', resetBanner: '重置横幅', cancel: '取消',
  sectionToggle: '{title}——{action}分区', collapse: '折叠', expand: '展开', bindSource: '将此条目绑定到源代码位置', projectRelativeFile: '项目相对路径文件',
  projectFilePlaceholder: '例如：src/theorems/pythagorean.ts', mode: '模式', lineRange: '行范围', regularExpression: '正则表达式', startLine: '起始行', endLine: '结束行（可选）',
  sameAsStart: '与起始行相同', regexPattern: '正则表达式', regexPlaceholder: '例如：function\\s+provePythagorean', regexFlags: '正则标志（可选）', exampleIm: '例如：im', occurrence: '匹配序号（可选）',
  pointerHint: '路径从项目根目录解析。行号和正则匹配序号均从 1 开始。', noPointer: '尚未附加源代码位置。启用绑定后即可选择文件和寻址模式。',
  canvasAria: 'GUI 编辑器画布', editFocusedSnl: '编辑聚焦的 SNL', editMacroInput: '编辑此块的宏；按 Enter 提交，按 Shift+Enter 添加新行', enterSnlDsl: '输入 SNL DSL；按 Enter 提交，按 Shift+Enter 添加新行',
  insertCanvasRoot: '插入画布根宏', argumentCount: '参数数量', macroActions: '宏操作', removeArgument: '移除参数', argumentCountValue: '参数数量值', addArgument: '添加参数',
  macroStyle: '宏样式', selectMacroStyle: '选择宏样式', clearStyle: '（清除样式）', missing: '（缺失）', defaultSuffix: '（默认）', editMacro: '编辑宏', createMacro: '创建宏',
  openEditMacro: '打开“编辑宏”：{name}（{origin}）', openCreateMacroPrefill: '打开“创建宏”（预填 ID“{name}”）', resetCanvas: '从 SNL 重置画布',
  addRootMacro: '添加根宏', editMacroMenu: '编辑宏', editSubtreeSnl: '将子树作为 SNL 编辑', detachBlock: '拆分为独立块', delete: '删除', canvasBlockActions: '画布块操作',
  macroEditSingleId: '宏编辑仅接受单个宏 ID；请使用 Ctrl+F2 编辑子树。', macroEditNameOnly: '宏编辑仅接受宏名称；请使用“样式”下拉框。',
  unparseableSnl: '文本模式 SNL 无法解析（{error}）。当前树反映上次成功解析的结果；下次在此编辑时将覆盖文本内容。',
  inductiveHelp: '归纳式编辑器——将鼠标悬停在行上可显示操作盘。支持分隔形式：$foo$、$$x+y$$、%text%、@$x$。后缀 @ 会打开“上下文条目 ID”输入框。可从相邻下拉框选择样式。',
  expandNode: '展开', collapseNode: '折叠', rootMacroPlaceholder: '根宏', leafPlaceholder: '名称 / $expr$ / %text% / @…', kindTooltip: '种类：{kind}{source}', envModeSource: '（来自 env_mode）',
  macroNotFound: '名称与当前数据库中的任何宏都不匹配', contextEntryId: '上下文条目 ID', entryId: '条目 ID', unresolvedMacro: '未解析的宏', macroStyleFor: '{name} 的宏样式',
  missingStyle: '样式 [{style}] 缺失；请选择清除或已声明的样式', styleUnavailable: '样式不可用——名称与任何带样式的宏都不匹配', explicitStyle: '显式样式：[{style}]', implicitStyle: '默认样式（隐式）：[{style}]',
  openCreateMacroText: '打开“创建宏”（文本模式，预填“{name}”）', openCreateMacroInline: '打开“创建宏”（formula_inline，预填“{name}”）', openCreateMacroDisplay: '打开“创建宏”（formula_display，预填“{name}”）', openCreateMacroBlank: '打开“创建宏”（空白）',
  moveUpAvailable: '上移——与前一个同级节点交换', moveUpUnavailable: '无法上移——已是第一个', moveUp: '上移', outdentAvailable: '减少缩进——上移一级', outdentUnavailable: '无法减少缩进——已在顶层', outdent: '减少缩进',
  chooseAddPosition: '选择添加节点的位置', chooseAddPositionAria: '选择添加位置', indentAvailable: '增加缩进——成为前一个同级节点的子节点', indentUnavailable: '无法增加缩进——没有前一个同级节点', indent: '增加缩进',
  moveDownAvailable: '下移——与后一个同级节点交换', moveDownUnavailable: '无法下移——已是最后一个', moveDown: '下移', addNodePosition: '添加节点位置', addParent: '添加父节点', addParentTitle: '在此节点外添加父节点', parent: '父节点',
  addChild: '添加子节点', addChildTitle: '在此节点下添加子节点', child: '子节点', addSibling: '添加同级节点', rootNoSibling: '根节点不能有同级节点', addSiblingTitle: '在此节点后添加同级节点', sibling: '同级节点', deleteSubtreeTitle: '删除此子树', deleteSubtree: '删除子树',
  createdStatus: '✅ 已创建条目（ID：{id}）。', updatedStatus: '✅ 已更新条目（ID：{id}）。', warningStatus: '⚠️ {message}', errorStatus: '❌ {message}', invalidStatus: '❌ 无效：{message}'
});
type CreateEntryTranslator = UiTranslator<typeof CREATE_ENTRY_MESSAGES.catalogs.en>;

// ---------------------------------------------------------------------------
// Macro DB merge
// ---------------------------------------------------------------------------

/**
 * The on-disk v6 macro entry shape as shipped from the host (see snlDoc.ts
 * MacroPackageEntry). A superset of the library's render-only SnlMacro:
 * additionally carries the consumer-owned output backends per style.
 * We only mirror the fields the view layer needs.
 */
type WirePackageMacro = WireMacro;

// Preview now routes through <EntrySurface>, which owns its own source
// resolution against the entry pool. The bespoke PREVIEW_HOOKS constant
// (used by the old SnlSyntaxTreeView-based preview) is no longer needed.

interface EntryKind {
  id: string;
  name: string;
  coloring: { stroke: string; background: string };
  numbering: string;
  style: string;
}

type ContentFormat = 'snl' | 'typst' | 'latex' | 'markdown' | 'text';
type LocalizableContentFormat = Exclude<ContentFormat, 'snl'>;

const LOCALIZABLE_CONTENT_FORMATS: readonly LocalizableContentFormat[] = [
  'typst',
  'latex',
  'markdown',
  'text'
];

type Mode = 'create' | 'edit';

interface ExistingEntry {
  id: string;
  package?: string;
  kind: string;
  title: string;
  content: {
    snl?: string;
    typst?: Localized<string, string>;
    latex?: Localized<string, string>;
    markdown?: Localized<string, string>;
    text?: Localized<string, string>;
  };
  /** New writes are scalar; legacy structured values are preserved untouched. */
  contribution_info?: unknown;
  pointer?: unknown;
}

type PointerMode = 'lines' | 'regex';

interface PointerDraft {
  enabled: boolean;
  file: string;
  mode: PointerMode;
  line: string;
  endLine: string;
  pattern: string;
  flags: string;
  occurrence: string;
}

type EntryPointer =
  | { file: string; mode: 'lines'; line: number; endLine?: number }
  | { file: string; mode: 'regex'; pattern: string; flags?: string; occurrence?: number };

const EMPTY_POINTER_DRAFT: PointerDraft = {
  enabled: false,
  file: '',
  mode: 'lines',
  line: '1',
  endLine: '',
  pattern: '',
  flags: '',
  occurrence: ''
};

function pointerDraftFrom(value: unknown): PointerDraft {
  if (!value || typeof value !== 'object') return { ...EMPTY_POINTER_DRAFT };
  const pointer = value as Record<string, unknown>;
  if (typeof pointer.file !== 'string') return { ...EMPTY_POINTER_DRAFT };
  if (pointer.mode === 'lines' && typeof pointer.line === 'number') {
    return {
      ...EMPTY_POINTER_DRAFT,
      enabled: true,
      file: pointer.file,
      mode: 'lines',
      line: String(pointer.line),
      endLine: typeof pointer.endLine === 'number' ? String(pointer.endLine) : ''
    };
  }
  if (pointer.mode === 'regex' && typeof pointer.pattern === 'string') {
    return {
      ...EMPTY_POINTER_DRAFT,
      enabled: true,
      file: pointer.file,
      mode: 'regex',
      pattern: pointer.pattern,
      flags: typeof pointer.flags === 'string' ? pointer.flags : '',
      occurrence: typeof pointer.occurrence === 'number' ? String(pointer.occurrence) : ''
    };
  }
  return { ...EMPTY_POINTER_DRAFT };
}

function positiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function pointerDraftError(draft: PointerDraft, t: CreateEntryTranslator): string | null {
  if (!draft.enabled) return null;
  const file = draft.file.trim().replace(/\\/g, '/');
  if (!file) return t('chooseProjectFile');
  if (file.startsWith('/') || /^[A-Za-z]:\//.test(file)) {
    return t('relativeProjectPath');
  }
  if (file.split('/').some((segment) => segment === '..')) {
    return t('pathCannotLeaveRoot');
  }
  if (draft.mode === 'lines') {
    const line = positiveInteger(draft.line);
    if (line === null) return t('positiveStartLine');
    if (draft.endLine) {
      const endLine = positiveInteger(draft.endLine);
      if (endLine === null || endLine < line) {
        return t('validEndLine');
      }
    }
    return null;
  }
  if (!draft.pattern) return t('regexRequired');
  try {
    void new RegExp(draft.pattern, draft.flags);
  } catch (error) {
    return t('invalidRegex', { message: error instanceof Error ? error.message : String(error) });
  }
  if (draft.occurrence && positiveInteger(draft.occurrence) === null) {
    return t('positiveOccurrence');
  }
  return null;
}

function pointerFromDraft(draft: PointerDraft, t: CreateEntryTranslator): EntryPointer | null {
  if (!draft.enabled || pointerDraftError(draft, t)) return null;
  const file = draft.file.trim().replace(/\\/g, '/');
  if (draft.mode === 'lines') {
    const pointer: EntryPointer = {
      file,
      mode: 'lines',
      line: positiveInteger(draft.line)!
    };
    const endLine = positiveInteger(draft.endLine);
    if (endLine !== null) pointer.endLine = endLine;
    return pointer;
  }
  const pointer: EntryPointer = { file, mode: 'regex', pattern: draft.pattern };
  if (draft.flags) pointer.flags = draft.flags;
  const occurrence = positiveInteger(draft.occurrence);
  if (occurrence !== null) pointer.occurrence = occurrence;
  return pointer;
}

const FORMAT_TABS: { id: ContentFormat; label: string }[] = [
  { id: 'snl', label: 'SNL' },
  { id: 'typst', label: 'Typst' },
  { id: 'latex', label: 'LaTeX' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: 'Text' }
];

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; id: string }
  | { kind: 'updated'; id: string }
  | { kind: 'duplicate'; id: string; message: string }
  | { kind: 'notFound'; id: string; message: string }
  | { kind: 'unknownKind'; kindId: string; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

function projectLocalizedContent(
  value: Localized<string, string> | undefined
): { text: string; i18n?: I18n<string, string> } {
  if (value === undefined) return { text: '' };
  if (typeof value === 'string') return { text: value };
  return {
    text: webview_language_runtime.run_reader(
      read_localized<string, string>(value)
    ),
    i18n: value
  };
}

function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback (should not happen in a modern webview host).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Number rendering: the real counter engine is deferred; EntryRender is
// fed `counterLabel={undefined}` so the header just shows "<KindName> --
// <title>" without a mock digit.

function sameWireCatalogValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameWireCatalogValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      sameWireCatalogValue(leftRecord[key], rightRecord[key]));
}

export function CreateEntryApp(): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const preferencesRevision = use_preferences_revision();
  const formatterPreferences = get_formatter_preferences();
  const snlFormatter = useMemo(
    () => new SnlDslFormatter(
      formatterPreferences.indentSpaces,
      formatterPreferences.inlineParenthesisDepth
    ),
    [preferencesRevision]
  );
  const monacoTheme = (() => {
    switch (document.documentElement.dataset.snlColorScheme) {
      case 'light': return 'vs';
      case 'high-contrast': return 'hc-black';
      case 'high-contrast-light': return 'hc-light';
      default: return 'vs-dark';
    }
  })();
  const languageRef = useRef(webview_language_runtime.query_environment().language);
  const [mode, setMode] = useState<Mode>('create');
  const [targetState, setTargetState] = useState<'found' | 'notFound'>('found');
  const [kinds, setKinds] = useState<EntryKind[]>([]);
  const [kindsLoaded, setKindsLoaded] = useState(false);

  /**
   * User-authored macros indexed by name (strict v8 wire shape from the host).
   * Empty until the first `context` message arrives.
   */
  const [wireMacros, setWireMacros] = useState<Record<string, WirePackageMacro>>({});
  const [kindPalette, setKindPalette] = useState<KindPalette | undefined>(undefined);
  // Name → owning package (bare filename) for the row-side "open Macro
  // editor" button in the GUI editor. Pushed by the host on `context`.
  const [macroOrigin, setMacroOrigin] = useState<Record<string, string>>({});

  // User-only DB for EntryRender and the GUI editor's flat lookup.
  const userMacros: MacroRecord = useMemo(() => {
    const userDb: MacroRecord = {};
    for (const [name, m] of Object.entries(wireMacros)) {
      userDb[name] = wireMacroToRenderable(m);
    }
    return userDb;
  }, [wireMacros]);

  const macroDataDriver = useMemo(
    () => createMacroDataDriver(userMacros),
    [userMacros]
  );
  const macroCandidates = useMemo(
    () => {
      const candidates = new Map<string, SnooglSearchCandidate>();
      const styleNames = (macro: { styles?: readonly { style_name: string }[] }): string[] =>
        (macro.styles ?? []).map((style) => style.style_name).filter(Boolean);
      for (const [name, macro] of Object.entries(wireMacros)) {
        candidates.set(name, { id: name, labels: macro.tags ?? [], styles: styleNames(macro) });
      }
      return Array.from(candidates.values()).sort((left, right) =>
        left.id.localeCompare(right.id)
      );
    },
    [wireMacros]
  );

  // (`macroQuery` used to be threaded into the SnlSyntaxTreeView-based
  // preview; the EntryRender path derives its own query internally so we
  // no longer need one at this layer.)

  const [title, setTitle] = useState('');
  const [titleEditing, setTitleEditing] = useState(true);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleModeInitializedRef = useRef(false);
  const [id, setId] = useState<string>('');
  // Full shared pool (id+title) for dedupe validation in create mode
  // (`requireUnique`). In edit mode we still use it — the widget is
  // suppressed but the pool would enable future reference features
  // without another host roundtrip. Cat 2026-07-09.
  const [existingIds, setExistingIds] = useState<EntryOption[]>([]);
  const [entryPackages, setEntryPackages] = useState<string[]>(['_unpackaged']);
  const [selectedPackage, setSelectedPackage] = useState<string>('_unpackaged');
  const [showPackageCreator, setShowPackageCreator] = useState(false);
  const [newPackageId, setNewPackageId] = useState('');
  const [packageCreating, setPackageCreating] = useState(false);
  const [packageCreateError, setPackageCreateError] = useState('');
  const packageRequestSequenceRef = useRef(0);
  const activePackageRequestRef = useRef<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<string>('');

  const [activeFormat, setActiveFormat] = useState<ContentFormat>('snl');
  const [snlMode, setSnlMode] = useState<'text' | 'gui' | 'canvas'>('canvas');
  const [content, setContent] = useState<Record<ContentFormat, string>>({
    snl: '',
    typst: '',
    latex: '',
    markdown: '',
    text: ''
  });
  const [canvasForest, setCanvasForest] = useState<SnlSyntaxTree[]>(() => {
    const root = createSnlSyntaxTreeNode('_snl_stub');
    ensureTreeIdentity(root);
    return [root];
  });
  const canvasAuthoredSnlRef = useRef<string | null>(null);
  useEffect(() => {
    if (canvasAuthoredSnlRef.current === content.snl) {
      canvasAuthoredSnlRef.current = null;
      return;
    }
    canvasAuthoredSnlRef.current = null;
    const root = parseOrDefault(content.snl);
    ensureTreeIdentity(root);
    setCanvasForest([root]);
  }, [content.snl]);
  const [contentI18n, setContentI18n] = useState<
    Partial<Record<LocalizableContentFormat, I18n<string, string>>>
  >({});
  const [contributor, setContributor] = useState('');
  const contributorDirtyRef = useRef(false);
  const [pointerDraft, setPointerDraft] = useState<PointerDraft>(() => ({
    ...EMPTY_POINTER_DRAFT
  }));
  const pointerDirtyRef = useRef(false);

  /** Rows for the Relationships section; replaced wholesale on every push. */
  const [relationships, setRelationships] = useState<EntryRelationshipRow[]>([]);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useVsCodeApiRef();
  const formDirtyRef = useRef(false);
  const editGenerationRef = useRef(0);
  const submittedEditGenerationRef = useRef<number | null>(null);
  const submittedSaveRequestIdRef = useRef<string | null>(null);
  const saveRequestSequenceRef = useRef(0);
  /**
   * Mirror of `formDirtyRef` as real state.
   *
   * The ref alone cannot drive the draft-stashing effect: writing a ref does
   * not re-render, so an interaction that sets dirty without changing any
   * state would never persist. Review 2026-07-25.
   */
  const [formDirty, setFormDirty] = useState(false);
  const markFormDirty = React.useCallback((dirty: boolean): void => {
    if (dirty) editGenerationRef.current += 1;
    formDirtyRef.current = dirty;
    setFormDirty(dirty);
  }, []);
  /**
   * Which entry id the restored draft belongs to, or null when nothing was
   * restored. Panels now run with `retainContextWhenHidden: true`, so merely
   * hiding the tab keeps React state alive; a window reload / VS Code restart
   * still destroys it, and the draft stashed in webview state is what
   * survives that. See components/draftState.ts.
   */
  const restoredDraftIdRef = useRef<string | null>(null);
  const contentDirtyRef = useRef<Set<LocalizableContentFormat>>(new Set());
  const editingIdRef = useRef('');
  /**
   * Id of the entry this panel just created or updated, until the host's
   * immediate follow-up context has been absorbed. The acknowledged on-screen
   * form is the save authority for that one refresh: a racing stale snapshot
   * must not blank Preview/Canvas or rebuild the Canvas forest.
   */
  const justSavedIdRef = useRef<string | null>(null);
  const committedCreateIdRef = useRef<string | null>(null);
  const committedUpdateRequestIdRef = useRef<string | null>(null);
  const committedUpdateRevisionRef = useRef<{ id: string; revision: string } | null>(null);
  const targetGenerationRef = useRef<number | null>(null);
  const contextEstablishedGenerationRef = useRef<number | null>(null);
  const pendingTargetMessagesRef = useRef<Map<number, unknown[]>>(new Map());
  const entryRevisionRef = useRef<string | undefined>(undefined);
  const existingMetadataRef = useRef<{
    pointer: unknown;
    contributionInfo: unknown;
  }>({ pointer: null, contributionInfo: null });

  useEffect(() => {
    const nextLanguage = webview_language_runtime.query_environment().language;
    const previousLanguage = languageRef.current;
    if (nextLanguage === previousLanguage) return;
    const nextMaps = { ...contentI18n };
    const nextContent = { ...content };
    for (const format of ['typst', 'latex', 'markdown', 'text'] as const) {
      const original = contentI18n[format];
      if (!original) continue;
      const updated = merge_localized_projection(
        original,
        content[format],
        previousLanguage,
        contentDirtyRef.current.has(format)
      );
      nextMaps[format] = updated;
      nextContent[format] = webview_language_runtime.run_reader(
        read_localized<string, string>(updated)
      );
    }
    setContentI18n(nextMaps);
    setContent(nextContent);
    contentDirtyRef.current.clear();
    languageRef.current = nextLanguage;
  }, [preferencesRevision]);

  // Report the first painted frame exactly once, so the timeline ends at
  // "the author can actually see the panel".
  const paintReportedRef = useRef(false);
  useEffect(() => {
    if (!paintReportedRef.current) {
      paintReportedRef.current = true;
      traceMark('app-mounted');
      traceFirstPaint();
    }
  }, []);

  useEffect(() => {

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'openPackageCreator' }
        | { type: 'retarget'; mode: Mode; id?: string }
        | {
            type: 'context';
            mode: Mode;
            targetState?: 'found' | 'notFound';
            id?: string;
            seedId?: string;
            openPackageCreator?: boolean;
            kinds: EntryKind[];
            macros?: Record<string, WirePackageMacro>;
            macroKinds?: MacroKindPaletteSource[];
            macroOrigin?: Record<string, string>;
            existing?: ExistingEntry | null;
            entryRevision?: string;
            entryPackages?: string[];
            existingIds?: EntryOption[];
            relationships?: EntryRelationshipRow[];
          }
        | { type: 'created'; id: string }
        | { type: 'createCommitted'; id: string }
        | { type: 'updateCommitted'; id: string; revision: string }
        | { type: 'packageCreated'; packageId: string; requestId: string }
        | { type: 'packageCreateFailed'; message: string; requestId: string }
        | { type: 'updated'; id: string }
        | { type: 'duplicate'; id: string; message: string }
        | { type: 'notFound'; id: string; message: string }
        | { type: 'unknownKind'; kind: string; message: string }
        | { type: 'invalid'; reason: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      const rawTargetGeneration = (event.data as { targetGeneration?: unknown })
        .targetGeneration;
      const hasTargetGeneration =
        typeof rawTargetGeneration === 'number' && Number.isSafeInteger(rawTargetGeneration);
      let flushGeneration: number | null = null;
      if (!hasTargetGeneration) {
        // Legacy fixtures remain usable until the first correlated anchor. Once
        // correlation is active, an untagged target message is unsafe/stale.
        if (targetGenerationRef.current !== null) return;
      } else {
        const incomingGeneration = rawTargetGeneration;
        const currentGeneration = targetGenerationRef.current;
        const establishesTarget =
          msg.type === 'retarget' || msg.type === 'context' || msg.type === 'createCommitted';
        const futureGeneration =
          currentGeneration === null || incomingGeneration > currentGeneration;
        const createFlipContextArrivedBeforeCommit =
          msg.type === 'context' && msg.mode === 'edit' && mode === 'create' &&
          submittedEditGenerationRef.current !== null;

        if (
          futureGeneration &&
          (!establishesTarget || createFlipContextArrivedBeforeCommit)
        ) {
          const pending = pendingTargetMessagesRef.current.get(incomingGeneration) ?? [];
          pending.push(event.data);
          pendingTargetMessagesRef.current.set(incomingGeneration, pending);
          return;
        }
        if (currentGeneration !== null && incomingGeneration < currentGeneration) return;
        if (
          msg.type === 'retarget' &&
          contextEstablishedGenerationRef.current === incomingGeneration
        ) return;
        if (futureGeneration) {
          targetGenerationRef.current = incomingGeneration;
          contextEstablishedGenerationRef.current = null;
          for (const generation of pendingTargetMessagesRef.current.keys()) {
            if (generation < incomingGeneration) pendingTargetMessagesRef.current.delete(generation);
          }
        }
        if (msg.type === 'context') {
          contextEstablishedGenerationRef.current = incomingGeneration;
        }
        if (establishesTarget) flushGeneration = incomingGeneration;
      }
      const saveRequestId = (event.data as { saveRequestId?: unknown }).saveRequestId;
      const isSaveTerminal =
        msg.type === 'created' || msg.type === 'updated' || msg.type === 'duplicate' ||
        msg.type === 'notFound' || msg.type === 'unknownKind' || msg.type === 'invalid' ||
        msg.type === 'noSnlDoc' || msg.type === 'noWorkspace' || msg.type === 'error';
      const isSaveScoped =
        isSaveTerminal || msg.type === 'createCommitted' || msg.type === 'updateCommitted';
      if (hasTargetGeneration && isSaveScoped) {
        if (typeof saveRequestId !== 'string' || saveRequestId.length === 0) return;
        if (saveRequestId !== submittedSaveRequestIdRef.current) return;
        if (isSaveTerminal) submittedSaveRequestIdRef.current = null;
      }
      switch (msg.type) {
        case 'openPackageCreator':
          setShowPackageCreator(true);
          setPackageCreateError('');
          break;
        case 'retarget': {
          // One panel serves every entry now (cat 2026-07-25). Clear the
          // form before the new entry's context lands so the previous
          // entry's text is never shown against the new id, and drop the
          // dirty/draft/save-ack bookkeeping that belonged to the old target.
          restoredDraftIdRef.current = null;
          justSavedIdRef.current = null;
          committedCreateIdRef.current = null;
          committedUpdateRequestIdRef.current = null;
          committedUpdateRevisionRef.current = null;
          submittedEditGenerationRef.current = null;
          editingIdRef.current = '';
          entryRevisionRef.current = undefined;
          contentDirtyRef.current.clear();
          markFormDirty(false);
          setStatus({ kind: 'idle' });
          setTargetState('found');
          setTitle('');
          setTitleEditing(false);
          titleModeInitializedRef.current = false;
          setSelectedPackage('_unpackaged');
          activePackageRequestRef.current = null;
          setPackageCreating(false);
          setPackageCreateError('');
          setNewPackageId('');
          setShowPackageCreator(false);
          setSelectedKind('');
          setContentI18n({});
          setContributor('');
          contributorDirtyRef.current = false;
          setPointerDraft({ ...EMPTY_POINTER_DRAFT });
          pointerDirtyRef.current = false;
          setRelationships([]);
          setContent({ snl: '', typst: '', latex: '', markdown: '', text: '' });
          setId(typeof msg.id === 'string' ? msg.id : '');
          if (msg.mode === 'create' || msg.mode === 'edit') setMode(msg.mode);
          break;
        }
        case 'context':
          // The payload has arrived and is about to be applied to state.
          traceMark('context-received');
          setRelationships(
            Array.isArray(msg.relationships) ? msg.relationships : []
          );
          setMode(msg.mode);
          if (!titleModeInitializedRef.current) {
            setTitleEditing(msg.mode === 'create');
            titleModeInitializedRef.current = true;
          }
          setTargetState(msg.mode === 'edit' && msg.targetState === 'notFound' ? 'notFound' : 'found');
          setKinds(Array.isArray(msg.kinds) ? msg.kinds : []);
          setKindsLoaded(true);
          const incomingMacros = msg.macros && typeof msg.macros === 'object' ? msg.macros : {};
          setWireMacros((previous) =>
            sameWireCatalogValue(previous, incomingMacros) ? previous : incomingMacros
          );
          setKindPalette(macroKindsToPalette(msg.macroKinds));
          setMacroOrigin(
            msg.macroOrigin && typeof msg.macroOrigin === 'object'
              ? msg.macroOrigin
              : {},
          );
          setExistingIds(Array.isArray(msg.existingIds) ? msg.existingIds : []);
          const packages = Array.isArray(msg.entryPackages) && msg.entryPackages.length > 0
            ? msg.entryPackages
            : ['_unpackaged'];
          setEntryPackages(packages);
          if (msg.openPackageCreator === true) {
            setShowPackageCreator(true);
            setPackageCreateError('');
          }
          setSelectedPackage((previous) =>
            formDirtyRef.current || packages.includes(previous) ? previous : '_unpackaged'
          );
          if (msg.mode === 'edit') {
            const incomingId = msg.id ?? msg.existing?.id ?? '';
            // Cat 2026-07-27: the context that immediately follows our own
            // successful create. What is on screen IS what was just written,
            // and it carries state the host's copy cannot reproduce (Canvas
            // node identity / multi-root forests are not recoverable from
            // `content.snl`). Always preserve, never re-fill.
            const justSaved = justSavedIdRef.current === incomingId;
            const preserveDraft = justSaved ||
              (!!msg.existing &&
              formDirtyRef.current &&
              editingIdRef.current === incomingId) ||
              // A restored draft is unsaved work that outlived the panel
              // being hidden; the host's copy is by definition older.
              (restoredDraftIdRef.current !== null &&
                restoredDraftIdRef.current === incomingId);
            const committedUpdate = committedUpdateRevisionRef.current;
            if (justSaved && committedUpdate?.id === incomingId) {
              entryRevisionRef.current = committedUpdate.revision;
            } else if (!preserveDraft || justSaved) {
              entryRevisionRef.current = msg.entryRevision;
            }
            if (msg.id) {
              setId(msg.id);
            }
            if (msg.existing) {
              // Metadata the panel does not edit but DOES write back on
              // Update. It must be absorbed even when a draft wins, or saving
              // from a restored draft silently drops the pointer and every
              // non-current language, because updateEntry overwrites the whole
              // record. Contributor is edited directly and therefore lives in
              // identity-scoped draft state instead. Review 2026-07-25.
              existingMetadataRef.current = {
                pointer: msg.existing.pointer ?? null,
                contributionInfo: msg.existing.contribution_info
              };
              const typst = projectLocalizedContent(msg.existing.content?.typst);
              const latex = projectLocalizedContent(msg.existing.content?.latex);
              const markdown = projectLocalizedContent(msg.existing.content?.markdown);
              const text = projectLocalizedContent(msg.existing.content?.text);
              if (!preserveDraft || !contributorDirtyRef.current) {
                setContributor(
                  typeof msg.existing.contribution_info === 'string'
                    ? msg.existing.contribution_info
                    : ''
                );
                contributorDirtyRef.current = false;
              }
              if (!justSaved) {
                setContentI18n({
                  ...(typst.i18n ? { typst: typst.i18n } : {}),
                  ...(latex.i18n ? { latex: latex.i18n } : {}),
                  ...(markdown.i18n ? { markdown: markdown.i18n } : {}),
                  ...(text.i18n ? { text: text.i18n } : {})
                });
              }
              if (!preserveDraft) {
                editingIdRef.current = incomingId;
                setTitle(msg.existing.title || '');
                setSelectedPackage(msg.existing.package || '_unpackaged');
                setSelectedKind(msg.existing.kind || '');
                setPointerDraft(pointerDraftFrom(msg.existing.pointer));
                pointerDirtyRef.current = false;
                setContent({
                  snl: msg.existing.content?.snl ?? '',
                  typst: typst.text,
                  latex: latex.text,
                  markdown: markdown.text,
                  text: text.text
                });
                contentDirtyRef.current.clear();
                markFormDirty(false);
              } else if (restoredDraftIdRef.current === incomingId) {
                // ONLY on the restored-draft path: the stash carries no
                // record of which formats were edited, so treating them all
                // as edited is the lesser evil — otherwise `persist` merges
                // the draft text into the host's i18n as if untouched and
                // the author's work is dropped.
                //
                // The other `preserveDraft` source (a live dirty form being
                // re-pushed by the file watcher) must NOT come here: its
                // `contentDirtyRef` is accurate, and widening it would
                // freeze every untouched format's language fallback into an
                // explicit translation. Review 2026-07-25.
                editingIdRef.current = incomingId;
                for (const format of LOCALIZABLE_CONTENT_FORMATS) {
                  contentDirtyRef.current.add(format);
                }
              } else {
                editingIdRef.current = incomingId;
              }
            }
            // One-shot: consumed by the single context push that follows the
            // create. Later pushes (file watcher, retarget) must go through
            // the normal dirty-form rules.
            if (justSaved) {
              justSavedIdRef.current = null;
              if (committedUpdateRevisionRef.current?.id === incomingId) {
                committedUpdateRevisionRef.current = null;
              }
            }
          } else {
            // Cat 2026-07-15: seed the id field with the caller-provided
            // hint (e.g. the id the user typed into the Library outline's
            // Add form that didn't resolve). Only overwrite an empty
            // field — a user who already started typing in this panel
            // shouldn't have their input clobbered by a late re-push.
            if (typeof msg.seedId === 'string' && msg.seedId) {
              setId((prev) => (prev ? prev : msg.seedId!));
            }
            setSelectedKind((prev) => {
              if (prev) return prev;
              return msg.kinds && msg.kinds.length > 0 ? msg.kinds[0].id : '';
            });
          }
          break;
        case 'createCommitted': {
          // The Entry itself is durable and the host target has changed to
          // Edit, but dependency reconciliation is still pending. Migrate
          // ownership without clearing dirty state or claiming save success.
          const createdId = typeof msg.id === 'string' ? msg.id : '';
          if (
            committedCreateIdRef.current === createdId &&
            editingIdRef.current === createdId
          ) break;
          committedCreateIdRef.current = createdId;
          // The key switch itself must be atomic with draft ownership. A stale
          // edit draft from an older session for the newly-created ID must not
          // hydrate over the current in-memory form; the dirty effect below
          // repopulates the destination key from current state.
          saveDraft(getVsCodeApi(), 'createEntry:create:', undefined);
          saveDraft(getVsCodeApi(), `createEntry:edit:${createdId}`, undefined);
          editingIdRef.current = createdId;
          justSavedIdRef.current = createdId;
          setMode('edit');
          setTitleEditing(false);
          setId(createdId);
          activePackageRequestRef.current = null;
          setPackageCreating(false);
          setPackageCreateError('');
          setNewPackageId('');
          setShowPackageCreator(false);
          break;
        }
        case 'updateCommitted': {
          const requestId = typeof saveRequestId === 'string' ? saveRequestId : '';
          if (committedUpdateRequestIdRef.current === requestId) break;
          const committedId = typeof msg.id === 'string' ? msg.id : '';
          const revision = typeof msg.revision === 'string' ? msg.revision : '';
          if (!committedId || !revision) break;
          committedUpdateRequestIdRef.current = requestId;
          committedUpdateRevisionRef.current = { id: committedId, revision };
          entryRevisionRef.current = revision;
          justSavedIdRef.current = committedId;
          break;
        }
        case 'created': {
          // Cat 2026-07-27: the host now flips this panel into Edit mode for
          // the entry we just created and re-pushes context. Record the id so
          // the follow-up `edit` context is recognised as the SAME target and
          // preserves what is already on screen instead of re-filling it.
          const createdId = typeof msg.id === 'string' ? msg.id : '';
          committedCreateIdRef.current = createdId;
          editingIdRef.current = createdId;
          justSavedIdRef.current = createdId;
          // The host now treats Package responses from the create target as
          // stale. Reset the matching local request state so the new Edit
          // target cannot remain stuck on a disabled “Creating…” control.
          activePackageRequestRef.current = null;
          setPackageCreating(false);
          setPackageCreateError('');
          setNewPackageId('');
          setShowPackageCreator(false);
          // Clear dirty state only when the acknowledged payload is still
          // the latest local generation. Authors may keep typing while the host
          // persists; those later edits were not part of this create request.
          const acknowledgesCurrentGeneration =
            submittedEditGenerationRef.current === editGenerationRef.current;
          submittedEditGenerationRef.current = null;
          if (acknowledgesCurrentGeneration) markFormDirty(false);
          // `draftKey` embeds `mode`, so the flip switches to
          // `createEntry:edit:<id>`. A stale stash left there by an earlier
          // session for the same id would be restored on top of the content
          // that was just written. Drop it before the key changes.
          saveDraft(getVsCodeApi(), `createEntry:edit:${createdId}`, undefined);
          setStatus({ kind: 'created', id: msg.id });
          break;
        }
        case 'packageCreated': {
          if (msg.requestId !== activePackageRequestRef.current) break;
          const packageId = typeof msg.packageId === 'string' ? msg.packageId : '';
          if (!packageId) break;
          activePackageRequestRef.current = null;
          setEntryPackages((previous) =>
            previous.includes(packageId) ? previous : [...previous, packageId]
          );
          setSelectedPackage(packageId);
          markFormDirty(true);
          setPackageCreating(false);
          setPackageCreateError('');
          setNewPackageId('');
          setShowPackageCreator(false);
          break;
        }
        case 'packageCreateFailed':
          if (msg.requestId !== activePackageRequestRef.current) break;
          activePackageRequestRef.current = null;
          setPackageCreating(false);
          setPackageCreateError(msg.message);
          break;
        case 'updated': {
          justSavedIdRef.current = typeof msg.id === 'string' ? msg.id : null;
          const acknowledgesCurrentGeneration =
            submittedEditGenerationRef.current === editGenerationRef.current;
          submittedEditGenerationRef.current = null;
          if (acknowledgesCurrentGeneration) {
            markFormDirty(false);
            contentDirtyRef.current.clear();
          }
          setStatus({ kind: 'updated', id: msg.id });
          break;
        }
        case 'duplicate':
          setStatus({ kind: 'duplicate', id: msg.id, message: msg.message });
          break;
        case 'notFound':
          setTargetState('notFound');
          setId(msg.id);
          setStatus({ kind: 'notFound', id: msg.id, message: msg.message });
          break;
        case 'unknownKind':
          setStatus({
            kind: 'unknownKind',
            kindId: msg.kind,
            message: msg.message
          });
          break;
        case 'invalid':
          setStatus({ kind: 'invalid', message: msg.reason });
          break;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          break;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          break;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          break;
        default:
          break;
      }
      if (flushGeneration !== null) {
        const pending = pendingTargetMessagesRef.current.get(flushGeneration) ?? [];
        pendingTargetMessagesRef.current.delete(flushGeneration);
        for (const pendingMessage of pending) {
          onMessage(new MessageEvent('message', { data: pendingMessage }));
        }
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const kind = useMemo(
    () => kinds.find((k) => k.id === selectedKind),
    [kinds, selectedKind]
  );

  const trimmedTitle = title.trim();
  const trimmedId = id.trim();
  // Existing metadata is preserved byte-for-byte until the author actually
  // touches Pointer. A malformed legacy pointer must not block an unrelated
  // title/content edit merely because the editor cannot project it cleanly.
  const editablePointerError =
    mode === 'edit' && !pointerDirtyRef.current
      ? null
      : pointerDraftError(pointerDraft, t);
  const canCreate =
    targetState !== 'notFound' &&
    !packageCreating &&
    kinds.length > 0 &&
    trimmedTitle.length > 0 &&
    trimmedId.length > 0 &&
    isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined) &&
    selectedKind.length > 0 &&
    selectedPackage.length > 0 &&
    entryPackages.includes(selectedPackage) &&
    editablePointerError === null &&
    canPersistCanvasForest(canvasForest) &&
    status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canCreate) {
      return;
    }
    setStatus({ kind: 'creating' });
    const persist = (
      format: LocalizableContentFormat
    ): Localized<string, string> | undefined => {
      const value = content[format];
      const original = contentI18n[format];
      if (!original) return value || undefined;
      if (!contentDirtyRef.current.has(format)) return original;
      return merge_localized_projection(
        original,
        value,
        webview_language_runtime.query_environment().language,
        true
      );
    };
    const persistedContent = {
      typst: persist('typst'),
      latex: persist('latex'),
      markdown: persist('markdown'),
      text: persist('text')
    };
    setContentI18n((previous) => {
      const next = { ...previous };
      for (const format of ['typst', 'latex', 'markdown', 'text'] as const) {
        const value = persistedContent[format];
        if (value && typeof value === 'object') next[format] = value;
      }
      return next;
    });
    const entry = {
      id: trimmedId,
      package: selectedPackage,
      kind: selectedKind,
      title: trimmedTitle,
      content: {
        snl: content.snl || undefined,
        ...persistedContent
      },
      contribution_info:
        mode === 'edit' && !contributorDirtyRef.current
          ? existingMetadataRef.current.contributionInfo
          : contributor.trim() || null,
      pointer:
        mode === 'edit' && !pointerDirtyRef.current
          ? existingMetadataRef.current.pointer
          : pointerFromDraft(pointerDraft, t)
    };
    submittedEditGenerationRef.current = editGenerationRef.current;
    const saveRequestId =
      `save:${Date.now().toString(36)}:${++saveRequestSequenceRef.current}`;
    submittedSaveRequestIdRef.current = saveRequestId;
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      saveRequestId,
      entry,
      expectedRevision: mode === 'edit' ? entryRevisionRef.current : undefined
    });
  }

  // Restore unsaved work stashed before the panel was hidden, and keep the
  // stash current while the form is dirty. Runs before the host's `init`
  // arrives, so `preserveDraft` can see it.
  //
  // Namespaced per entry: since 2026-07-25 ONE panel serves every entry
  // (retargeted instead of recreated, to skip the ~1.09s webview stand-up),
  // so a single shared key would restore entry A's unsaved text over entry
  // B the moment you navigated between them.
  const draftKey = `createEntry:${mode}:${mode === 'edit' ? id : ''}`;
  // Draft persistence takes the API value rather than the ref wrapper. Both
  // paths resolve to the same cached handle.
  const draftApi = getVsCodeApi();
  // Re-runs when the panel is retargeted at a different entry, so the new
  // entry gets ITS stash rather than keeping the previous one's.
  useEffect(() => {
    const restored = loadDraft<{
      id: string;
      title: string;
      selectedKind: string;
      selectedPackage?: string;
      content: Record<ContentFormat, string>;
      activeFormat: ContentFormat;
      snlMode: 'text' | 'gui' | 'canvas';
      canvasForest?: SnlSyntaxTree[];
      pointerDraft?: PointerDraft;
      contributor?: string;
      entryRevision?: string;
    }>(draftApi, draftKey);
    if (!restored) return;
    restoredDraftIdRef.current = restored.id;
    entryRevisionRef.current = restored.entryRevision ?? '__snl_restored_draft_without_revision__';
    markFormDirty(true);
    // The stash records no per-format edit history, so treat every format it
    // carries as edited. Without this `persist` returns the host's original
    // i18n unchanged and the author's restored text is silently dropped.
    // This lives here (not only in the `init` handler) because the draft key
    // depends on mode+id, so a restore can land AFTER init — which is the
    // normal order now that one panel is retargeted between entries.
    for (const format of LOCALIZABLE_CONTENT_FORMATS) {
      contentDirtyRef.current.add(format);
    }
    setId(restored.id);
    setTitle(restored.title);
    setSelectedKind(restored.selectedKind);
    setSelectedPackage(restored.selectedPackage || '_unpackaged');
    setContent(restored.content);
    if (typeof restored.contributor === 'string') {
      setContributor(restored.contributor);
      contributorDirtyRef.current = true;
    } else {
      contributorDirtyRef.current = false;
    }
    setActiveFormat(restored.activeFormat);
    setSnlMode(restored.snlMode);
    if (restored.pointerDraft) {
      setPointerDraft(restored.pointerDraft);
      pointerDirtyRef.current = true;
    }
    // The Canvas forest is NOT recoverable from `content.snl`: a multi-root
    // or half-finished forest has no serialized form at all, and node
    // identity (which drives block positions) is lost either way. Restore it
    // directly, and suppress the reparse that `content.snl` would otherwise
    // trigger. Review 2026-07-25.
    if (restored.canvasForest && restored.canvasForest.length > 0) {
      canvasAuthoredSnlRef.current = restored.content.snl;
      for (const root of restored.canvasForest) ensureTreeIdentity(root);
      setCanvasForest(restored.canvasForest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  usePersistedDraft(
    draftApi,
    draftKey,
    {
      id,
      title,
      selectedKind,
      selectedPackage,
      content,
      activeFormat,
      snlMode,
      canvasForest,
      contributor,
      pointerDraft: pointerDirtyRef.current ? pointerDraft : undefined,
      entryRevision: mode === 'edit' ? entryRevisionRef.current : undefined
    },
    formDirty
  );

  // A completed save makes the stash obsolete — keeping it would resurrect
  // old text the next time the panel opens.
  useEffect(() => {
    if ((status.kind === 'created' || status.kind === 'updated') && !formDirty) {
      restoredDraftIdRef.current = null;
      saveDraft(draftApi, draftKey, undefined);
    }
  }, [status.kind, formDirty]);

  useSaveShortcut(handleSubmit, canCreate, () => {
    // A save already in flight is not a refusal: reporting one here would
    // overwrite the `creating` status, which is the very latch that keeps
    // `canCreate` false — clearing it would let the next Ctrl+S submit the
    // same entry a second time. Review 2026-07-25.
    if (status.kind === 'creating') return;
    // Never leave the key looking dead: say why the save was refused.
    setStatus({ kind: 'invalid', message: saveBlockingReason() });
  });

  /** The most specific reason the save button is currently disabled. */
  function saveBlockingReason(): string {
    if (kinds.length === 0) return t('cannotSaveNoKinds');
    if (!trimmedTitle) return t('cannotSaveTitle');
    if (!trimmedId) return t('cannotSaveId');
    if (!isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined)) {
      return t('cannotSaveDuplicateId', { id: trimmedId });
    }
    if (!selectedKind) return t('cannotSaveKind');
    if (!selectedPackage || !entryPackages.includes(selectedPackage)) {
      return t('cannotSavePackage');
    }
    if (editablePointerError) return t('cannotSaveReason', { reason: editablePointerError });
    return canvasBlockingReason() ?? t('cannotSave');
  }

  /** Why the Canvas is blocking a save, if it is. */
  function canvasBlockingReason(): string | null {
    if (canPersistCanvasForest(canvasForest)) return null;
    return canvasForest.length > 1
      ? t('cannotSaveLooseCanvas')
      : t('cannotSaveCanvasSlot');
  }

  function handleCancel(): void {
    if (mode === 'edit') {
      // Cancel in edit mode is a no-op reset that's rarely useful; just clear
      // the status banner so the user can keep editing. The draft stays —
      // the author did not ask to throw their edits away.
      setStatus({ kind: 'idle' });
      return;
    }
    restoredDraftIdRef.current = null;
    saveDraft(draftApi, draftKey, undefined);
    setTitle('');
    setId('');
    setContent({ snl: '', typst: '', latex: '', markdown: '', text: '' });
    setContentI18n({});
    setPointerDraft({ ...EMPTY_POINTER_DRAFT });
    pointerDirtyRef.current = false;
    contentDirtyRef.current.clear();
    markFormDirty(false);
    setActiveFormat('snl');
    setSnlMode('text');
    setStatus({ kind: 'idle' });
    setSelectedPackage('_unpackaged');
    setSelectedKind(kinds.length > 0 ? kinds[0].id : '');
  }

  useEffect(() => {
    if (!titleEditing) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [titleEditing]);

  const noKinds = kindsLoaded && kinds.length === 0;

  if (mode === 'edit' && targetState === 'notFound') {
    return <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t('editEntry')}
        back={{ label: t('dashboard'), title: t('backDashboard'), message: { type: 'nav.openDashboard' } }}
      />
      <MissingEditorTarget target="entry" id={id} />
    </main>;
  }

  return (
    <main
      style={PANEL_STYLE}
      onInputCapture={() => { markFormDirty(true); }}
    >
      {/* cat 2026-07-09: top nav — back to Dashboard; in edit mode also
          jump to this entry's per-entry Infoview. */}
      <PanelHeader
        vsApi={apiRef.current}
        title={t(mode === 'edit' ? 'editEntryHeader' : 'createEntryHeader')}
        titleAction={
          <>
            <input
              ref={titleInputRef}
              id="snl-entry-title"
              type="text"
              aria-label={t('title')}
              value={title}
              placeholder={t('titlePlaceholder')}
              readOnly={!titleEditing}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => setTitleEditing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === 'Escape') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              className="snl-panel-header__title-input"
              data-editing={titleEditing ? 'true' : 'false'}
            />
            <IconButton
              icon="edit"
              label={t('editTitle')}
              title={t('editTitle')}
              variant="ghost"
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTitleEditing(true)}
            />
          </>
        }
        back={{
          label: t('dashboard'),
          title: t('backDashboard'),
          message: { type: 'nav.openDashboard' }
        }}
        viewInInfoview={
          mode === 'edit' && id
            ? {
                label: t('viewInfoview'),
                title: t('openEntryInfoview', { id }),
                message: { type: 'nav.openInfoview', entryId: id }
              }
            : undefined
        }
      />

      {noKinds ? (
        <div
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            border:
              '1px solid var(--vscode-editorWarning-foreground, #cca700)',
            borderRadius: '3px',
            color: 'var(--vscode-editorWarning-foreground, #cca700)'
          }}
        >
          {t('noKindsBefore')} <strong>{t('initializeKinds')}</strong>{' '}
          {t('noKindsAfter')}
        </div>
      ) : null}

      <fieldset
        disabled={noKinds}
        style={{
          border: 'none',
          margin: 0,
          padding: 0,
          minWidth: 0,
          width: '100%',
          boxSizing: 'border-box',
          opacity: noKinds ? 0.5 : 1
        }}
      >
        {/* 1. Permanent metadata: ID + Entry Package + Entry kind ====== */}
        <div
          data-entry-metadata-row="true"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.75rem',
            marginBottom: '1rem',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ flex: '2 1 18rem', minWidth: 0 }}>
            <Label htmlFor="snl-entry-id">
              {mode === 'edit' ? t('idReadonly') : t('id')}
            </Label>
            {mode === 'edit' ? (
              <input
                id="snl-entry-id"
                type="text"
                value={id}
                placeholder={t('idPlaceholder')}
                onChange={(event) => setId(event.target.value)}
                readOnly
                title={t('immutableIdTitle')}
                style={{
                  ...inputStyle,
                  ...monoStyle,
                  marginBottom: 0,
                  color: 'var(--vscode-descriptionForeground, #999)',
                  opacity: 0.7,
                  cursor: 'not-allowed'
                }}
              />
            ) : (
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <EntityIdSearchBox
                    entries={existingIds}
                    value={id}
                    validate={ENTRY_VALIDATE_RULES.requireUnique}
                    hideResolvedChip
                    idPrefix="snl-entry-id"
                    placeholder={t('idPlaceholder')}
                    onChange={setId}
                    inputStyle={{ ...monoStyle, marginBottom: 0 }}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => {
                    markFormDirty(true);
                    setId(newUuid());
                  }}
                  title={trimmedId ? t('overwriteUuidTitle') : t('fillUuidTitle')}
                  style={{ whiteSpace: 'nowrap', opacity: 0.75 }}
                >
                  {trimmedId ? t('regenerateUuid') : t('useUuid')}
                </Button>
              </div>
            )}
            {mode === 'create' ? (
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', opacity: 0.75, lineHeight: 1.4 }}>
                {t('semanticIdHint')}
              </p>
            ) : null}
          </div>

          <div style={{ flex: '1.25 1 12rem', minWidth: 0 }}>
            <Label htmlFor="snl-entry-package">{t('package')}</Label>
            <select
              id="snl-entry-package"
              value={selectedPackage}
              onInput={(event) => {
                const next = event.currentTarget.value;
                if (next === '__create__') {
                  setShowPackageCreator(true);
                  setPackageCreateError('');
                  return;
                }
                setSelectedPackage(next);
              }}
              onChange={(event) => {
                if (event.target.value === '__create__') {
                  setShowPackageCreator(true);
                  setPackageCreateError('');
                  return;
                }
                markFormDirty(true);
                setSelectedPackage(event.target.value);
              }}
              style={{ ...inputStyle, marginBottom: 0, width: '100%' }}
            >
              <option value="__create__">＋ {t('createPackage')}</option>
              {!entryPackages.includes(selectedPackage) && selectedPackage ? (
                <option value={selectedPackage} disabled>
                  {t('missingPackageOption', { packageId: selectedPackage })}
                </option>
              ) : null}
              {entryPackages.map((packageId) => (
                <option key={packageId} value={packageId}>
                  {packageId === '_unpackaged' ? t('unpackaged') : packageId}
                </option>
              ))}
            </select>
            {!entryPackages.includes(selectedPackage) && selectedPackage ? (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--vscode-errorForeground)' }}>
                {t('missingPackage')}
              </p>
            ) : mode === 'create' ? (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', opacity: 0.75 }}>
                {t('packageHint')}
              </p>
            ) : null}
          </div>

          <div style={{ flex: '1 1 11rem', minWidth: 0 }}>
            <Label>{t('kind')}</Label>
            <EntryKindPicker
              kinds={kinds}
              selectedId={selectedKind}
              label={t('kind')}
              selectionLabel={(item) => t('kindSelection', { name: item.name })}
              details={(item) => t('kindDetails', {
                id: item.id,
                stroke: item.coloring.stroke,
                background: item.coloring.background
              })}
              onSelect={(next) => {
                markFormDirty(true);
                setSelectedKind(next);
              }}
            />
          </div>
        </div>

        {showPackageCreator ? (
          <div style={{ margin: '-0.35rem 0 1rem' }}>
            <Label htmlFor="snl-entry-new-package">{t('newPackageId')}</Label>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'flex-start' }}>
              <input
                id="snl-entry-new-package"
                value={newPackageId}
                placeholder={t('packageIdPlaceholder')}
                onChange={(event) => setNewPackageId(event.target.value)}
                style={{ ...inputStyle, ...monoStyle, marginBottom: 0, flex: '1 1 auto' }}
              />
              <Button
                variant="primary"
                disabled={status.kind === 'creating' || packageCreating || newPackageId.trim().length === 0}
                onClick={() => {
                  const packageId = newPackageId.trim();
                  if (status.kind === 'creating' || !packageId) return;
                  const requestId = `package-${++packageRequestSequenceRef.current}`;
                  activePackageRequestRef.current = requestId;
                  setPackageCreating(true);
                  setPackageCreateError('');
                  apiRef.current?.postMessage({ type: 'createPackage', packageId, requestId });
                }}
              >
                {packageCreating ? t('packageCreating') : t('addPackage')}
              </Button>
              <Button
                variant="ghost"
                disabled={packageCreating}
                onClick={() => {
                  setShowPackageCreator(false);
                  setNewPackageId('');
                  setPackageCreateError('');
                }}
              >
                {t('cancelPackageCreate')}
              </Button>
            </div>
          </div>
        ) : null}
        {packageCreateError ? (
          <p role="alert" style={{ margin: '-0.75rem 0 1rem', fontSize: '0.8rem', color: 'var(--vscode-errorForeground)' }}>
            {packageCreateError}
          </p>
        ) : null}

        {/* 3. Live preview ============================================= */}
        <section style={{ marginBottom: '1rem' }}>
          <h2 style={{ margin: '0 0 0.55rem', fontSize: '1rem', fontWeight: 600 }}>
            {t('livePreview')}
          </h2>
          <LivePreview
            kind={kind}
            entryId={trimmedId || t('newEntryId')}
            title={trimmedTitle}
            content={content}
            entries={existingIds}
            userMacros={userMacros}
            kindPalette={kindPalette}
            postMessage={(message) => apiRef.current?.postMessage(message)}
          />
        </section>

        {/* 4. Content tabs ============================================= */}
        <div style={{ marginBottom: '1rem' }}>
          <Label>{t('content')}</Label>
          <TabList
            aria-label={t('content')}
            style={{
              display: 'flex',
              gap: '0.25rem',
              marginBottom: '0.5rem',
              flexWrap: 'wrap'
            }}
          >
            {FORMAT_TABS.map((tab) => (
              <TabButton
                key={tab.id}
                active={activeFormat === tab.id}
                disabled={tab.id === 'typst' || tab.id === 'latex'}
                title={tab.id === 'typst' || tab.id === 'latex'
                  ? t('unsupportedFormat', { format: tab.label })
                  : undefined}
                onClick={() => setActiveFormat(tab.id)}
              >
                {tab.id === 'text' ? t('textFormat') : tab.label}
              </TabButton>
            ))}
          </TabList>

          {activeFormat === 'snl' ? (
            <TabList
              aria-label={t('editorMode')}
              style={{
                display: 'flex',
                gap: '0.25rem',
                marginBottom: '0.5rem'
              }}
            >
              <TabButton
                tabVariant="pill"
                active={snlMode === 'canvas'}
                onClick={() => setSnlMode('canvas')}
              >
                {t('guiCanvas')}
              </TabButton>
              <TabButton
                tabVariant="pill"
                active={snlMode === 'gui'}
                onClick={() => setSnlMode('gui')}
              >
                {t('guiInductive')}
              </TabButton>
              <TabButton
                tabVariant="pill"
                active={snlMode === 'text'}
                onClick={() => setSnlMode('text')}
              >
                {t('textEditor')}
              </TabButton>
            </TabList>
          ) : null}

          {activeFormat === 'snl' && snlMode === 'gui' ? (
            <GuiInductiveEditor
              editorIdentity={`${mode}:${id}`}
              snl={content.snl}
              entryCandidates={existingIds}
              macroDataDriver={macroDataDriver}
              macroCandidates={macroCandidates}
              macroOrigin={macroOrigin}
              onOpenMacroEditor={(payload) =>
                apiRef.current?.postMessage({
                  type: 'openMacroEditor',
                  ...payload
                })
              }
              onChange={(next) => {
                markFormDirty(true);
                setContent((prev) => ({ ...prev, snl: next }));
              }}
            />
          ) : activeFormat === 'snl' && snlMode === 'canvas' ? (
            <GuiCanvasEditor
              forest={canvasForest}
              macroDataDriver={macroDataDriver}
              macroCandidates={macroCandidates}
              macroOrigin={macroOrigin}
              onOpenMacroEditor={(payload) =>
                apiRef.current?.postMessage({
                  type: 'openMacroEditor',
                  ...payload
                })
              }
              kindPalette={kindPalette}
              onForestChange={(nextForest) => {
                // Forest state is authored work even when it is temporarily
                // multi-root or contains holes and therefore cannot serialize.
                markFormDirty(true);
                setCanvasForest(nextForest);
                if (canPersistCanvasForest(nextForest)) {
                  const nextSnl = serializeTreePreserving(nextForest[0]);
                  setContent((previous) => {
                    if (previous.snl === nextSnl) return previous;
                    canvasAuthoredSnlRef.current = nextSnl;
                    return { ...previous, snl: nextSnl };
                  });
                }
              }}
              onResetFromSnl={() => {
                markFormDirty(true);
                const root = parseOrDefault(content.snl);
                ensureTreeIdentity(root);
                setCanvasForest([root]);
              }}
            />
          ) : (
            <MonacoTextEditor
              value={content[activeFormat]}
              language={activeFormat === 'text' ? 'plaintext' : activeFormat}
              ariaLabel={t('sourceEditorLabel', { format: activeFormat.toUpperCase() })}
              placeholder={t('sourcePlaceholder', { format: activeFormat.toUpperCase() })}
              theme={monacoTheme}
              onChange={(next) => {
                markFormDirty(true);
                if (activeFormat !== 'snl') {
                  contentDirtyRef.current.add(activeFormat);
                }
                setContent((previous) => previous[activeFormat] === next
                  ? previous
                  : { ...previous, [activeFormat]: next });
              }}
              onSave={handleSubmit}
              format={activeFormat === 'snl'
                ? (source) => snlFormatter.format(source)
                : undefined}
              formatLabel={activeFormat === 'snl' ? t('formatSnl') : undefined}
              formatShortcutLabel={activeFormat === 'snl' ? t('formatShortcut') : undefined}
              onFormatError={(error) => setStatus({
                kind: 'invalid',
                message: t('formatFailed', {
                  error: error instanceof Error ? error.message : String(error)
                })
              })}
            />
          )}
        </div>

        {/* 5. Relationships ============================================ */}
        {mode === 'edit' ? (
          <EntryRelationshipsSection
            relationships={relationships}
            onOpenEntry={(entryId) =>
              // Reuse the existing nav contract rather than inventing a
              // message the host does not handle: `nav.openInfoview` with an
              // entryId opens that entry's reading view.
              apiRef.current?.postMessage({
                type: 'nav.openInfoview',
                entryId
              })
            }
          />
        ) : null}

        {/* 6. Contributor (temporary single-string shape) ============== */}
        <CollapsibleEntrySection title={t('contributor')}>
          <div data-testid="entry-contributor-editor">
            <label htmlFor="snl-entry-contributor" style={{ display: 'block', fontWeight: 600 }}>
              {t('contributor')}
            </label>
            <input
              id="snl-entry-contributor"
              className="snl-control"
              type="text"
              value={contributor}
              placeholder={t('contributorPlaceholder')}
              onChange={(event) => {
                contributorDirtyRef.current = true;
                markFormDirty(true);
                setContributor(event.target.value);
              }}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            <p style={{ margin: '0.35rem 0 0', fontSize: '0.8rem', opacity: 0.7 }}>
              {t('contributorTemporary')}
            </p>
          </div>
        </CollapsibleEntrySection>

        {/* 7. Pointer ================================================= */}
        <CollapsibleEntrySection title={t('pointer')}>
          <PointerEditor
            value={pointerDraft}
            onChange={(next) => {
              pointerDirtyRef.current = true;
              markFormDirty(true);
              setPointerDraft(next);
            }}
          />
        </CollapsibleEntrySection>

        {/* 7. Submit / Cancel ========================================= */}
        {!canPersistCanvasForest(canvasForest) ? (
          <p
            role="alert"
            style={{
              margin: '0 0 0.65rem',
              color: 'var(--vscode-editorWarning-foreground, #cca700)',
              fontWeight: 600
            }}
          >
            {canvasForest.length > 1
              ? t('canvasMultipleRoots')
              : t('canvasSingleSlot')}
          </p>
        ) : null}
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canCreate}
          >
            {status.kind === 'creating'
              ? mode === 'edit' ? t('updating') : t('creating')
              : mode === 'edit' ? t('updateEntry') : t('createEntry')}
          </Button>
          <Button
            variant="secondary"
            onClick={handleCancel}
          >
            {mode === 'edit' ? t('resetBanner') : t('cancel')}
          </Button>
        </div>

        <StatusLine status={status} />
      </fieldset>
    </main>
  );
}

/**
 * Live preview for the Entry editor. Routes through the SAME `<EntrySurface>`
 * that the Infoview / hover popovers use, so the WYSIWYG surface exactly
 * matches what a reader will see. Body-surface dispatch (snl > markdown >
 * latex > text) is owned by EntryRender itself — we just feed the full
 * `content` bag.
 *
 * Wrapped in a local `<HoverPopoverProvider>` because EntryRender's hooks
 * consume its context. `postMessage` is a no-op inside the preview —
 * clicking an in-body reference shouldn't navigate away from the editor,
 * and pointer resolution ("↗ source" button) only fires against a saved
 * entry, which draft edits don't have.
 */
function LivePreview({
  kind,
  entryId,
  title,
  content,
  entries,
  userMacros,
  kindPalette,
  postMessage
}: {
  kind: EntryKind | undefined;
  entryId: string;
  title: string;
  content: Record<ContentFormat, string>;
  entries: EntryOption[];
  userMacros: MacroRecord;
  kindPalette: KindPalette | undefined;
  postMessage: (message: unknown) => void;
}): React.ReactElement {
  const entry: EntryData = useMemo(
    () => ({
      id: entryId,
      kind: kind?.id ?? '',
      title,
      content: {
        snl: content.snl,
        typst: content.typst,
        latex: content.latex,
        markdown: content.markdown,
        text: content.text
      },
      contribution_info: null,
      pointer: null
    }),
    [entryId, kind?.id, title, content]
  );

  // Adapt local EntryKind shape to EntryRender's (identical fields today
  // but kept type-distinct so a future divergence is caught at the border).
  const renderKind: RenderEntryKind | null = kind
    ? {
        id: kind.id,
        name: kind.name,
        coloring: kind.coloring,
        numbering: kind.numbering,
        style: kind.style
      }
    : null;

  const previewEntries = useMemo(
    () => mergeDraftIntoEntryPool(entries, {
      id: entryId,
      title,
      snl: content.snl
    }),
    [entries, entryId, title, content.snl]
  );
  const localDetails = useMemo(
    () => ({ [entryId]: { entry, kind: renderKind } }),
    [entryId, entry, renderKind]
  );

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={previewEntries}
      userMacros={userMacros}
      kindPalette={kindPalette}
      localDetails={localDetails}
    >
      <div className="snl-entry-live-preview">
        <EntrySurface
          entry={entry}
          kind={renderKind}
          entries={previewEntries}
          postMessage={postMessage}
          userMacros={userMacros}
          kindPalette={kindPalette}
          counterLabel={undefined}
          disableTitleJump={true}
        />
      </div>
    </HoverPopoverProvider>
  );
}


function CollapsibleEntrySection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const [open, setOpen] = useState(false);
  const reactId = React.useId();
  const panelId = `entry-section-${reactId.replace(/[^a-z0-9_-]+/gi, '-')}`;
  return (
    <section
      style={{
        marginBottom: '1rem',
        borderTop: '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        paddingTop: '0.4rem'
      }}
    >
      <Disclosure
        expanded={open}
        controls={panelId}
        onToggle={() => setOpen((value) => !value)}
        title={t('sectionToggle', { title, action: open ? t('collapse') : t('expand') })}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'baseline',
          gap: '0.6rem',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left'
        }}
      >
        <span aria-hidden="true" style={{ opacity: 0.7, fontFamily: 'monospace', width: '1em' }}>
          {open ? '▾' : '▸'}
        </span>
        <span role="heading" aria-level={2} style={{ fontSize: '1rem', fontWeight: 600 }}>
          {title}
        </span>
      </Disclosure>
      {open ? <div id={panelId} style={{ paddingTop: '0.55rem' }}>{children}</div> : null}
    </section>
  );
}

function PointerEditor({
  value,
  onChange
}: {
  value: PointerDraft;
  onChange: (next: PointerDraft) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const error = pointerDraftError(value, t);
  const errorId = 'snl-entry-pointer-error';
  const describedBy = value.enabled ? errorId : undefined;
  const fileInvalid = !!error && (
    error.startsWith(t('chooseProjectFile').replace(/\.$/, '')) || error.startsWith(t('relativeProjectPath').replace(/\.$/, '')) || error.startsWith(t('pathCannotLeaveRoot').replace(/\.$/, ''))
  );
  const lineInvalid = !!error && (
    error.startsWith(t('positiveStartLine').replace(/\.$/, '')) || error.startsWith(t('validEndLine').replace(/\.$/, ''))
  );
  const regexInvalid = !!error && (
    error.startsWith(t('regexRequired').replace(/\.$/, '')) || error.startsWith(t('invalidRegex', { message: '' }).split(/[：:]/)[0])
  );
  const occurrenceInvalid = !!error && error.startsWith(t('positiveOccurrence').replace(/\.$/, ''));
  const update = (patch: Partial<PointerDraft>): void => onChange({ ...value, ...patch });
  return (
    <div data-testid="entry-pointer-editor">
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        {t('bindSource')}
      </label>
      {value.enabled ? (
        <>
          <Label htmlFor="snl-entry-pointer-file">{t('projectRelativeFile')}</Label>
          <input
            id="snl-entry-pointer-file"
            type="text"
            value={value.file}
            onChange={(event) => update({ file: event.target.value })}
            aria-invalid={fileInvalid || undefined}
            aria-describedby={describedBy}
            placeholder={t('projectFilePlaceholder')}
            style={{ ...inputStyle, ...monoStyle }}
          />
          <Label htmlFor="snl-entry-pointer-mode">{t('mode')}</Label>
          <select
            id="snl-entry-pointer-mode"
            value={value.mode}
            onChange={(event) => update({ mode: event.target.value as PointerMode })}
            aria-describedby={describedBy}
            style={inputStyle}
          >
            <option value="lines">{t('lineRange')}</option>
            <option value="regex">{t('regularExpression')}</option>
          </select>
          {value.mode === 'lines' ? (
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 10rem' }}>
                <Label htmlFor="snl-entry-pointer-line">{t('startLine')}</Label>
                <input
                  id="snl-entry-pointer-line"
                  type="number"
                  min={1}
                  step={1}
                  value={value.line}
                  onChange={(event) => update({ line: event.target.value })}
                  aria-invalid={lineInvalid || undefined}
                  aria-describedby={describedBy}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: '1 1 10rem' }}>
                <Label htmlFor="snl-entry-pointer-end-line">{t('endLine')}</Label>
                <input
                  id="snl-entry-pointer-end-line"
                  type="number"
                  min={1}
                  step={1}
                  value={value.endLine}
                  onChange={(event) => update({ endLine: event.target.value })}
                  aria-invalid={lineInvalid || undefined}
                  aria-describedby={describedBy}
                  placeholder={t('sameAsStart')}
                  style={inputStyle}
                />
              </div>
            </div>
          ) : (
            <>
              <Label htmlFor="snl-entry-pointer-pattern">{t('regexPattern')}</Label>
              <input
                id="snl-entry-pointer-pattern"
                type="text"
                value={value.pattern}
                onChange={(event) => update({ pattern: event.target.value })}
                aria-invalid={regexInvalid || undefined}
                aria-describedby={describedBy}
                placeholder={t('regexPlaceholder')}
                style={{ ...inputStyle, ...monoStyle }}
              />
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 10rem' }}>
                  <Label htmlFor="snl-entry-pointer-flags">{t('regexFlags')}</Label>
                  <input
                    id="snl-entry-pointer-flags"
                    type="text"
                    value={value.flags}
                    onChange={(event) => update({ flags: event.target.value })}
                    aria-invalid={regexInvalid || undefined}
                    aria-describedby={describedBy}
                    placeholder={t('exampleIm')}
                    style={{ ...inputStyle, ...monoStyle }}
                  />
                </div>
                <div style={{ flex: '1 1 10rem' }}>
                  <Label htmlFor="snl-entry-pointer-occurrence">{t('occurrence')}</Label>
                  <input
                    id="snl-entry-pointer-occurrence"
                    type="number"
                    min={1}
                    step={1}
                    value={value.occurrence}
                    onChange={(event) => update({ occurrence: event.target.value })}
                    aria-invalid={occurrenceInvalid || undefined}
                    aria-describedby={describedBy}
                    placeholder="1"
                    style={inputStyle}
                  />
                </div>
              </div>
            </>
          )}
          <p
            id={errorId}
            role={error ? 'alert' : undefined}
            aria-live="polite"
            style={{ margin: '0.15rem 0 0', fontSize: '0.8rem', opacity: error ? 1 : 0.65, color: error ? 'var(--vscode-errorForeground, #f48771)' : undefined }}
          >
            {error ?? t('pointerHint')}
          </p>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.65 }}>
          {t('noPointer')}
        </p>
      )}
    </div>
  );
}

function EntryKindPicker({
  kinds,
  selectedId,
  label,
  selectionLabel,
  details,
  onSelect
}: {
  kinds: EntryKind[];
  selectedId: string;
  label: string;
  selectionLabel: (kind: EntryKind) => string;
  details: (kind: EntryKind) => string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = kinds.find((item) => item.id === selectedId) ?? kinds[0];
  const listboxId = 'snl-entry-kind-options';

  useEffect(() => {
    if (!open) return;
    const selectedOption = [...(rootRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
      .find((option) => option.dataset.kindId === selectedId);
    selectedOption?.focus();
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open, selectedId]);

  const moveOptionFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || options.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowUp'
          ? (current - 1 + options.length) % options.length
          : (current + 1) % options.length;
    options[next]?.focus();
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <Button
        ref={triggerRef}
        id="snl-entry-kind"
        role="combobox"
        aria-label={selected ? selectionLabel(selected) : label}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        variant="secondary"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        style={{
          width: '100%',
          justifyContent: 'flex-start',
          background: selected?.coloring.background,
          color: selected?.coloring.stroke,
          borderColor: selected?.coloring.stroke,
          borderWidth: '2px'
        }}
      >
        <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {selected?.name ?? ''}
        </span>
        <Icon name="chevron-down" size={14} />
      </Button>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          onKeyDown={moveOptionFocus}
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.25rem)',
            left: 'auto',
            right: 0,
            zIndex: 120,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.2rem',
            width: 'calc(100vw - 2rem)',
            maxWidth: '20rem',
            padding: '0.3rem',
            border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border, #555))',
            borderRadius: '4px',
            background: 'var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526))',
            boxShadow: '0 4px 14px rgba(0,0,0,.35)'
          }}
        >
          {kinds.map((item) => (
            <button
              key={item.id}
              type="button"
              role="option"
              data-kind-id={item.id}
              aria-selected={item.id === selectedId}
              onClick={() => {
                onSelect(item.id);
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
              }}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(7rem, 1fr) minmax(0, 1.5fr)',
                gap: '0.55rem',
                alignItems: 'center',
                padding: '0.45rem 0.55rem',
                border: `2px solid ${item.coloring.stroke}`,
                borderRadius: '4px',
                background: item.coloring.background,
                color: item.coloring.stroke,
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer'
              }}
            >
              <strong>{item.name}</strong>
              <span style={{ fontSize: '0.75rem', opacity: 0.85 }}>
                {details(item)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Label({
  htmlFor,
  children
}: {
  htmlFor?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        marginBottom: '0.35rem',
        fontWeight: 600,
        fontSize: '0.95rem'
      }}
    >
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// {t('guiCanvas')} — DOM/SVG canvas shell
// ---------------------------------------------------------------------------

interface CanvasBlockPosition {
  x: number;
  y: number;
}

interface CanvasBlockBounds extends CanvasBlockPosition {
  width: number;
  height: number;
}

interface CanvasExtent {
  width: number;
  height: number;
}

export function canvasExtentForBlocks(
  viewport: CanvasExtent,
  blocks: readonly CanvasBlockBounds[],
  padding: number
): CanvasExtent {
  let width = Math.max(0, viewport.width);
  let height = Math.max(0, viewport.height);
  for (const block of blocks) {
    const right = block.x + Math.max(0, block.width) + padding;
    const bottom = block.y + Math.max(0, block.height) + padding;
    if (Number.isFinite(right)) width = Math.max(width, right);
    if (Number.isFinite(bottom)) height = Math.max(height, bottom);
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

interface CanvasPointerTarget {
  path: readonly number[];
  rect: DOMRect;
}

function canvasTreePaths(
  tree: SnlSyntaxTree,
  prefix: readonly number[] = []
): Array<readonly number[]> {
  return tree.children.flatMap((child, index) => {
    const path = [...prefix, index];
    return [path, ...canvasTreePaths(child, path)];
  });
}

function unionRects(rects: readonly DOMRect[]): DOMRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Resolve the rendered macro under the pointer. Most nodes have their own
 * data-tree-path wrapper. Dynamic KaTeX environments cannot always carry that
 * wrapper, so for those nodes we infer a padded hit box from all rendered
 * descendants and prefer it over a shallower direct ancestor.
 */
export function resolveCanvasPointerTarget(
  target: HTMLElement,
  block: HTMLElement,
  tree: SnlSyntaxTree,
  clientX: number,
  clientY: number
): CanvasPointerTarget | null {
  const directElement = target.closest<HTMLElement>('[data-tree-path]');
  const directEncoded =
    directElement && block.contains(directElement)
      ? directElement.getAttribute('data-tree-path') ?? ''
      : '';
  const directPath = directEncoded
    ? directEncoded.split('.').map(Number).filter(Number.isInteger)
    : [];
  let resolved: CanvasPointerTarget | null = directElement
    ? { path: directPath, rect: directElement.getBoundingClientRect() }
    : null;

  const pathElements = Array.from(
    block.querySelectorAll<HTMLElement>('[data-tree-path]')
  );
  for (const path of canvasTreePaths(tree)) {
    if (path.length <= (resolved?.path.length ?? -1)) continue;
    const encoded = path.join('.');
    const own = pathElements.find(
      (element) => element.getAttribute('data-tree-path') === encoded
    );
    // Cat 2026-07-25: a node that has its own wrapper still competes here.
    // `closest()` only walks DOM ancestors, so when KaTeX lays a deeper
    // node's box under the pointer without making it a DOM ancestor of the
    // hit target, the click used to fall back to a shallower node (often the
    // root). Geometry decides, and deeper always wins.
    const padding = own ? 0 : 18;
    const baseRect = own
      ? own.getBoundingClientRect()
      : (() => {
          const prefix = `${encoded}.`;
          return unionRects(
            pathElements
              .filter((element) => (element.getAttribute('data-tree-path') ?? '').startsWith(prefix))
              .map((element) => element.getBoundingClientRect())
              .filter((rect) => rect.width > 0 || rect.height > 0)
          );
        })();
    if (!baseRect || (baseRect.width === 0 && baseRect.height === 0)) continue;
    const hitRect = new DOMRect(
      baseRect.left - padding,
      baseRect.top - padding,
      baseRect.width + padding * 2,
      baseRect.height + padding * 2
    );
    if (
      clientX >= hitRect.left &&
      clientX <= hitRect.right &&
      clientY >= hitRect.top &&
      clientY <= hitRect.bottom
    ) {
      resolved = { path, rect: hitRect };
    }
  }
  return resolved;
}

interface CanvasPendingDrag {
  pointerId: number;
  rootIndex: number;
  path: readonly number[];
  blockId: string;
  startClientX: number;
  startClientY: number;
  startPosition: CanvasBlockPosition;
  active: boolean;
}

interface CanvasFocus {
  rootIndex: number;
  path: readonly number[];
  /**
   * Drop-target only: the path points one past a variadic Macro's last child,
   * so the drop grows its arity rather than filling an existing slot.
   */
  append?: boolean;
}

/**
 * What a Canvas inline editor is allowed to rewrite.
 *
 *   - 'macro'   (F2)      — only this block's own Macro name; Style is separate.
 *                           Children are preserved verbatim.
 *   - 'subtree' (Ctrl+F2) — the whole subtree serialized as SNL DSL.
 */
type CanvasEditScope = 'macro' | 'subtree';

interface CanvasNodeEditor extends CanvasFocus {
  scope: CanvasEditScope;
  left: number;
  top: number;
  value: string;
  error: string | null;
}

interface CanvasContextMenu extends CanvasFocus {
  left: number;
  top: number;
}

function sameCanvasTarget(
  left: CanvasFocus | null,
  right: CanvasFocus | null
): boolean {
  return Boolean(
    left &&
    right &&
    left.rootIndex === right.rootIndex &&
    left.path.join('.') === right.path.join('.')
  );
}

/**
 * Where a freshly-added root block starts. The first block is centred on the
 * canvas (cat 2026-07-25: "默认应该把根节点放在画布正中间"); later blocks fan out
 * from there so they don't stack on top of each other.
 */
/**
 * Canvas arity shortcuts, keyed by `KeyboardEvent.code` first so the numpad
 * and the main row stay distinguishable, with a `key` fallback for layouts
 * that do not report a code.
 *
 * Cat 2026-07-25 asked for numpad priority and for this to be user-rebindable
 * later, so the bindings live in one exported table rather than inline
 * conditionals — a future settings surface has exactly one place to read.
 */
export const CANVAS_ARITY_KEYS: {
  increase: { codes: readonly string[]; keys: readonly string[] };
  decrease: { codes: readonly string[]; keys: readonly string[] };
} = {
  increase: { codes: ['NumpadAdd', 'Equal'], keys: ['+', '='] },
  decrease: { codes: ['NumpadSubtract', 'Minus'], keys: ['-', '_'] }
};

export function canvasArityDelta(event: {
  code?: string;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): number | null {
  // Ctrl/Cmd +/- is browser zoom and Alt +/- belongs to the OS; claiming
  // those would hijack a shortcut the author expects to work everywhere.
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const { increase, decrease } = CANVAS_ARITY_KEYS;
  if (event.code && increase.codes.includes(event.code)) return 1;
  if (event.code && decrease.codes.includes(event.code)) return -1;
  // `key` fallback for layouts that report no code at all.
  if (increase.keys.includes(event.key)) return 1;
  if (decrease.keys.includes(event.key)) return -1;
  return null;
}

export function canvasInitialPosition(
  index: number,
  canvas: { clientWidth: number; clientHeight: number } | null,
  block: { offsetWidth: number; offsetHeight: number } | null
): CanvasBlockPosition {
  // Only the first root is centred; extra blocks keep the original grid so
  // detached subtrees land in predictable, non-overlapping slots.
  if (index > 0) {
    return {
      x: 24 + (index % 2) * 330,
      y: 24 + Math.floor(index / 2) * 220
    };
  }
  const width = canvas?.clientWidth ?? 0;
  const height = canvas?.clientHeight ?? 0;
  if (width <= 0 || height <= 0) return { x: 24, y: 24 };
  return {
    x: Math.max(8, Math.round((width - (block?.offsetWidth ?? Math.min(320, width / 2))) / 2)),
    y: Math.max(8, Math.round((height - (block?.offsetHeight ?? Math.min(160, height / 2))) / 2))
  };
}

const CANVAS_ZOOM_MIN = 0.5;
const CANVAS_ZOOM_MAX = 2;

export function canvasZoomFromWheel(current: number, deltaY: number): number {
  const bounded = Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, current));
  if (!Number.isFinite(deltaY) || deltaY === 0) return bounded;
  const next = bounded * Math.exp(-deltaY * 0.0015);
  return Math.round(
    Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, next)) * 1000
  ) / 1000;
}

export function canvasLogicalViewportWidth(viewportWidth: number, zoom: number): number {
  const boundedZoom = Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, zoom));
  return viewportWidth / Math.min(1, boundedZoom);
}

export function canvasVisualDeltaToLogical(visualDelta: number, zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? visualDelta / zoom : visualDelta;
}

type CanvasPathPrefixedTreeProps = React.ComponentProps<typeof SnlSyntaxTreeView> & {
  canonicalPath: number[];
};

/**
 * A nested SnlSyntaxTreeView reports paths relative to its own root. Canvas
 * interactions, however, require paths relative to the forest root. Prefix the
 * renderer-owned annotations whenever its imperative DOM changes.
 */
function CanvasPathPrefixedTreeView({
  canonicalPath,
  ...props
}: CanvasPathPrefixedTreeProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const prefix = canonicalPath.join('.');

  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const decorate = (): void => {
      host.querySelectorAll<HTMLElement>('[data-tree-path]').forEach((element) => {
        const relative = element.dataset.canvasRelativeTreePath ??
          element.getAttribute('data-tree-path') ?? '';
        element.dataset.canvasRelativeTreePath = relative;
        const canonical = relative ? `${prefix}.${relative}` : prefix;
        if (element.getAttribute('data-tree-path') !== canonical) {
          element.setAttribute('data-tree-path', canonical);
        }
      });
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(host, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [prefix]);

  return (
    <div ref={hostRef}>
      <SnlSyntaxTreeView {...props} />
    </div>
  );
}

export function GuiCanvasEditor({
  forest,
  macroDataDriver,
  macroCandidates = [],
  macroOrigin = {},
  onOpenMacroEditor = () => undefined,
  kindPalette,
  onForestChange,
  onResetFromSnl
}: {
  forest: SnlSyntaxTree[];
  macroDataDriver: MacroDataDriver;
  macroCandidates?: readonly SnooglSearchCandidate[];
  macroOrigin?: Record<string, string>;
  onOpenMacroEditor?: (req: MacroOpenRequest) => void;
  kindPalette: KindPalette | undefined;
  onForestChange: (next: SnlSyntaxTree[]) => void;
  onResetFromSnl: () => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const [positions, setPositions] = React.useState<Record<string, CanvasBlockPosition>>({});
  const [canvasExtent, setCanvasExtent] = React.useState<CanvasExtent>({ width: 0, height: 0 });
  const [canvasZoom, setCanvasZoom] = React.useState(1);
  const [draggingBlockId, setDraggingBlockId] = React.useState<string | null>(null);
  const [hoveredBlockId, setHoveredBlockId] = React.useState<string | null>(null);
  const [focused, setFocused] = React.useState<CanvasFocus | null>(null);
  const [editingNode, setEditingNode] = React.useState<CanvasNodeEditor | null>(null);
  const [addingRootFromMacro, setAddingRootFromMacro] = React.useState(false);
  const [dropTarget, setDropTarget] = React.useState<CanvasFocus | null>(null);
  const [contextMenu, setContextMenu] = React.useState<CanvasContextMenu | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const canvasZoomRef = React.useRef(1);
  const pendingZoomAnchorRef = React.useRef<{
    logicalX: number;
    logicalY: number;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  const wheelFrameRef = React.useRef<number | null>(null);
  const wheelBatchRef = React.useRef<{
    nextZoom: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const editorRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const addRootRef = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Async arity lookup belongs to the exact SNooGL selection that launched it.
  // A second selection, Escape, or an external forest replacement invalidates
  // the older result before it can append a stale/duplicate root.
  const addRootRequestRef = React.useRef(0);
  const nodeEditRequestRef = React.useRef(0);
  const forestRef = React.useRef(forest);
  const suppressClickRef = React.useRef(false);
  const suppressCanvasClickRef = React.useRef(false);
  const dragRef = React.useRef<CanvasPendingDrag | null>(null);
  const lastPointerTargetRef = React.useRef<CanvasFocus | null>(null);
  // Local undo stack (Ctrl/Cmd+Z). Canvas edits are structural and easy to
  // mis-aim, so every mutation pushes the pre-change forest before applying.
  const undoStackRef = React.useRef<Array<{ forest: SnlSyntaxTree[]; focused: CanvasFocus | null }>>([]);
  /**
   * Synchronous `dynamic_arity` lookup.
   *
   * `macroDataDriver.query_macro` is async, but the keyboard handler is not:
   * awaiting inside it would let two fast `+` presses both read the
   * pre-change forest. Every rendered Macro is resolved into this cache, so
   * the shortcut can decide instantly. Cat 2026-07-25.
   */
  const dynamicArityRef = React.useRef<Map<string, boolean>>(new Map());
  const [dynamicArityVersion, setDynamicArityVersion] = React.useState(0);
  const noteDynamicArity = React.useCallback((macroName: string, dynamic: boolean): void => {
    if (dynamicArityRef.current.get(macroName) === dynamic) return;
    dynamicArityRef.current.set(macroName, dynamic);
    setDynamicArityVersion((version) => version + 1);
  }, []);
  const isDynamicMacro = (macroName: string): boolean =>
    dynamicArityRef.current.get(macroName) === true;
  const macroStylesByName = React.useMemo(
    () => new Map(
      macroCandidates.map((candidate) => [candidate.id, candidate.styles ?? []] as const)
    ),
    [macroCandidates]
  );
  forestRef.current = forest;
  canvasZoomRef.current = canvasZoom;

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const commitWheelBatch = (): void => {
      wheelFrameRef.current = null;
      const batch = wheelBatchRef.current;
      wheelBatchRef.current = null;
      if (!batch) return;
      const current = canvasZoomRef.current;
      const next = batch.nextZoom;
      if (next === current) return;
      const rect = viewport.getBoundingClientRect();
      const pointerX = batch.clientX - rect.left;
      const pointerY = batch.clientY - rect.top;
      pendingZoomAnchorRef.current = {
        logicalX: (viewport.scrollLeft + pointerX) / current,
        logicalY: (viewport.scrollTop + pointerY) / current,
        pointerX,
        pointerY
      };
      // One synchronous commit per animation frame keeps the DOM geometry and
      // zoom ref coherent before the next wheel batch, without forcing layout
      // for every high-frequency trackpad event.
      flushSync(() => setCanvasZoom(next));
    };
    const onWheel = (event: WheelEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [role="listbox"], [role="dialog"], [role="menu"]')) {
        return;
      }
      const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, viewport.clientHeight)
          : 1;
      const normalizedDeltaY = event.deltaY * lineScale;
      if (normalizedDeltaY === 0) return;
      event.preventDefault();
      const pending = wheelBatchRef.current;
      wheelBatchRef.current = {
        nextZoom: canvasZoomFromWheel(
          pending?.nextZoom ?? canvasZoomRef.current,
          normalizedDeltaY
        ),
        clientX: event.clientX,
        clientY: event.clientY
      };
      if (wheelFrameRef.current === null) {
        wheelFrameRef.current = window.requestAnimationFrame(commitWheelBatch);
      }
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', onWheel);
      if (wheelFrameRef.current !== null) {
        window.cancelAnimationFrame(wheelFrameRef.current);
        wheelFrameRef.current = null;
      }
      wheelBatchRef.current = null;
    };
  }, []);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const anchor = pendingZoomAnchorRef.current;
    if (!viewport || !anchor) return;
    viewport.scrollLeft = anchor.logicalX * canvasZoom - anchor.pointerX;
    viewport.scrollTop = anchor.logicalY * canvasZoom - anchor.pointerY;
    pendingZoomAnchorRef.current = null;
  }, [canvasZoom]);

  React.useEffect(() => () => {
    // A MacroDataDriver request may outlive the Canvas. Never publish into the
    // parent after the user switches modes or closes the editor.
    addRootRequestRef.current += 1;
    nodeEditRequestRef.current += 1;
  }, []);

  /** Apply a structural change, recording the previous state for undo. */
  const applyForestChange = (
    next: SnlSyntaxTree[],
    nextFocused: CanvasFocus | null | undefined = undefined
  ): boolean => {
    if (next === forestRef.current) return false;
    undoStackRef.current.push({ forest: forestRef.current, focused });
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    forestRef.current = next;
    if (nextFocused !== undefined) setFocused(nextFocused);
    onForestChange(next);
    return true;
  };

  const undoForestChange = (): void => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    forestRef.current = previous.forest;
    closeCanvasInputs();
    setContextMenu(null);
    setFocused(previous.focused);
    onForestChange(previous.forest);
  };

  React.useEffect(() => {
    setPositions((previous) => {
      const next: Record<string, CanvasBlockPosition> = {};
      forest.forEach((root, index) => {
        const id = treeIdentity(root);
        next[id] = previous[id] ?? canvasInitialPosition(
          index,
          canvasRef.current,
          index === 0
            ? canvasRef.current?.querySelector<HTMLElement>('[data-canvas-root-index="0"]') ?? null
            : null
        );
      });
      return next;
    });
  }, [forest]);

  // The first root starts centred on the canvas. Only ever done once per
  // mount: later identity changes (edits, Clear) must not yank a block the
  // user has already dragged somewhere.
  const centredRootRef = React.useRef(false);
  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const first = forest[0];
    if (!canvas || !first || centredRootRef.current) return;
    const id = treeIdentity(first);
    const block = canvas.querySelector<HTMLElement>('[data-canvas-root-index="0"]');
    if (!block) return;
    const canvasRect = canvas.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    if (canvasRect.width === 0 || blockRect.width === 0) return;
    centredRootRef.current = true;
    setPositions((previous) => ({
      ...previous,
      [id]: {
        x: Math.max(8, Math.round((canvasRect.width - blockRect.width) / 2)),
        y: Math.max(8, Math.round((canvasRect.height - blockRect.height) / 2))
      }
    }));
  }, [forest]);

  const measureCanvasExtent = React.useCallback((): void => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas || viewport.clientWidth <= 0) return;
    const computedMinHeight = Number.parseFloat(window.getComputedStyle(canvas).minHeight);
    const fallbackHeight = Number.isFinite(computedMinHeight) && computedMinHeight > 0
      ? computedMinHeight
      : 512;
    const minimumHeight = viewport.clientHeight > 0
      ? canvasLogicalViewportWidth(viewport.clientHeight, canvasZoom)
      : fallbackHeight;
    const blocks = [...canvas.querySelectorAll<HTMLElement>('[data-canvas-root-index]')]
      .map((block): CanvasBlockBounds => ({
        x: block.offsetLeft,
        y: block.offsetTop,
        width: Math.max(block.offsetWidth, block.scrollWidth),
        height: Math.max(block.offsetHeight, block.scrollHeight)
      }));
    const next = canvasExtentForBlocks(
      { width: canvasLogicalViewportWidth(viewport.clientWidth, canvasZoom), height: minimumHeight },
      blocks,
      24
    );
    setCanvasExtent((previous) =>
      previous.width === next.width && previous.height === next.height ? previous : next
    );
  }, [canvasZoom]);

  React.useLayoutEffect(() => {
    measureCanvasExtent();
  }, [forest, positions, canvasZoom, measureCanvasExtent]);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureCanvasExtent);
    observer.observe(viewport);
    canvas.querySelectorAll<HTMLElement>('[data-canvas-root-index]').forEach((block) =>
      observer.observe(block)
    );
    return () => observer.disconnect();
  }, [forest, measureCanvasExtent]);

  React.useEffect(() => {
    if (focused) {
      const root = forest[focused.rootIndex];
      if (!root || !getNodeAtPath(root, focused.path.join('.'))) {
        setFocused(null);
      }
    }
    // Any external forest replacement invalidates the source snapshot held by
    // an open editor. Internal editor commits clear editingNode in the same
    // state transition, so this only cancels genuinely stale overlays.
    if (editingNode) setEditingNode(null);
    // Invalidate every arity lookup started against the old forest.
    addRootRequestRef.current += 1;
    nodeEditRequestRef.current += 1;
    // The add-root input is anchored to nothing in the tree, but a forest
    // replacement (Reset, external push, undo) still means its draft is
    // orphaned — destroy it rather than leave it floating (Cat 2026-07-26).
    setAddingRootFromMacro(false);
  }, [forest]);

  // Resolve dynamic_arity for every Macro currently on the Canvas so the
  // synchronous shortcut path always has an answer ready. The cache is
  // dropped whenever the Macro source changes, so editing a Macro from
  // fixed to variadic (or back) mid-session is picked up.
  React.useEffect(() => {
    dynamicArityRef.current.clear();
    setDynamicArityVersion((version) => version + 1);
  }, [macroDataDriver]);

  React.useEffect(() => {
    let cancelled = false;
    const names = new Set<string>();
    const visit = (node: SnlSyntaxTree): void => {
      const name = node.macro_name.trim();
      if (name && !node.env_mode) names.add(name);
      node.children.forEach(visit);
    };
    forest.forEach(visit);
    void (async () => {
      for (const name of names) {
        if (dynamicArityRef.current.has(name)) continue;
        try {
          const macro = await macroDataDriver.query_macro({ macro_name: name });
          if (cancelled) return;
          noteDynamicArity(name, macro?.dynamic_arity === true);
        } catch {
          if (cancelled) return;
          noteDynamicArity(name, false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [forest, macroDataDriver, noteDynamicArity]);

  const updateDropTarget = (next: CanvasFocus | null): void => {
    setDropTarget((previous) => sameCanvasTarget(previous, next) ? previous : next);
  };

  const findDropTarget = (
    clientX: number,
    clientY: number,
    draggedRootIndex: number
  ): CanvasFocus | null => {
    if (typeof document.elementsFromPoint !== 'function') return null;
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const holeElement = (element as HTMLElement).closest<HTMLElement>(
        '[data-kind="argPlaceholder"], .snlArgPlaceholder'
      );
      if (!holeElement) continue;
      const pathElement = holeElement.closest<HTMLElement>('[data-tree-path]');
      const block = holeElement.closest<HTMLElement>('[data-canvas-root-index]');
      if (!pathElement || !block) continue;
      const rootIndex = Number(block.dataset.canvasRootIndex);
      if (!Number.isInteger(rootIndex) || rootIndex === draggedRootIndex) continue;
      const encoded = pathElement.getAttribute('data-tree-path') ?? '';
      const path = encoded ? encoded.split('.').map(Number) : [];
      if (!isCanvasHole(getNodeAtPath(forestRef.current[rootIndex], encoded))) continue;
      return { rootIndex, path };
    }
    // Route C (cat 2026-07-25): a variadic Macro has no fixed slots, so
    // dropping anywhere on its own box appends a new argument. Checked after
    // the slot search so an explicit empty slot always wins.
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const pathElement = (element as HTMLElement).closest<HTMLElement>('[data-tree-path]');
      const block = pathElement?.closest<HTMLElement>('[data-canvas-root-index]');
      if (!pathElement || !block) continue;
      const rootIndex = Number(block.dataset.canvasRootIndex);
      if (!Number.isInteger(rootIndex) || rootIndex === draggedRootIndex) continue;
      const encoded = pathElement.getAttribute('data-tree-path') ?? '';
      const node = getNodeAtPath(forestRef.current[rootIndex], encoded);
      if (!node || !isDynamicMacro(node.macro_name)) continue;
      const path = encoded ? encoded.split('.').map(Number) : [];
      // The append position is one past the last child.
      return { rootIndex, path: [...path, node.children.length], append: true };
    }
    return null;
  };

  const beginPointer = (
    event: React.PointerEvent<HTMLDivElement>,
    rootIndex: number,
    blockId: string
  ): void => {
    // Cleared unconditionally: every early return below (right button, open
    // editor, empty slot) must invalidate the previous gesture's target so a
    // stale entry can never hijack a later click / double-click / right-click.
    lastPointerTargetRef.current = null;
    if (event.button !== 0 || editingNode) return;
    const resolved =
      resolveCanvasPointerTarget(
        event.target as HTMLElement,
        event.currentTarget,
        forest[rootIndex],
        event.clientX,
        event.clientY
      ) ?? {
        path: [],
        rect: event.currentTarget.getBoundingClientRect()
      };
    if (isCanvasHole(getNodeAtPath(forest[rootIndex], resolved.path.join('.')))) {
      return;
    }
    const canvas = event.currentTarget.closest<HTMLElement>('[data-entry-gui-canvas]');
    const canvasRect = canvas?.getBoundingClientRect();
    const startPosition =
      resolved.path.length > 0 && canvas && canvasRect
        ? {
            x: canvasVisualDeltaToLogical(resolved.rect.left - canvasRect.left, canvasZoomRef.current),
            y: canvasVisualDeltaToLogical(resolved.rect.top - canvasRect.top, canvasZoomRef.current)
          }
        : positions[blockId] ?? { x: 24, y: 24 };
    // Pointer-down must suppress the browser's native text-selection gesture;
    // the Canvas owns this drag surface, while editing uses a separate input.
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      rootIndex,
      path: resolved.path,
      blockId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPosition,
      active: false
    };
    // Cat 2026-07-25: a plain click must focus exactly the subtree that a
    // drag from this same spot would carry away. Record the drag's resolved
    // target here so the click handler can reuse it verbatim instead of
    // re-resolving (and possibly landing on a shallower ancestor).
    lastPointerTargetRef.current = { rootIndex, path: resolved.path };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const visualDx = event.clientX - drag.startClientX;
    const visualDy = event.clientY - drag.startClientY;
    const dx = canvasVisualDeltaToLogical(visualDx, canvasZoomRef.current);
    const dy = canvasVisualDeltaToLogical(visualDy, canvasZoomRef.current);
    if (!drag.active && Math.hypot(visualDx, visualDy) < 6) return;

    if (!drag.active) {
      drag.active = true;
      if (drag.path.length > 0) {
        const sourceRootIndex = drag.rootIndex;
        const sourcePath = [...drag.path];
        // A variadic parent must not keep the vacated slot: the drop lands
        // somewhere else and the blank would be left behind for good. It can
        // still take the subtree back by appending (route C).
        const nextForest = detachCanvasSubtree(
          forestRef.current,
          drag.rootIndex,
          drag.path,
          parentIsDynamic({ rootIndex: drag.rootIndex, path: drag.path })
        );
        if (nextForest === forestRef.current) {
          dragRef.current = null;
          return;
        }
        const detached = nextForest[nextForest.length - 1];
        ensureTreeIdentity(detached);
        const detachedId = treeIdentity(detached);
        drag.blockId = detachedId;
        drag.rootIndex = nextForest.length - 1;
        if (
          focused?.rootIndex === sourceRootIndex &&
          sourcePath.every((part, index) => focused.path[index] === part)
        ) {
          setFocused({
            rootIndex: drag.rootIndex,
            path: focused.path.slice(sourcePath.length)
          });
        }
        // Must run before forestRef is advanced: applyForestChange snapshots
        // the current forest for undo.
        applyForestChange(nextForest);
        forestRef.current = nextForest;
      }
      suppressClickRef.current = true;
      setDraggingBlockId(drag.blockId);
    }

    event.preventDefault();
    const nextDropTarget = findDropTarget(
      event.clientX,
      event.clientY,
      drag.rootIndex
    );
    const canvas = canvasRef.current;
    const targetElement = nextDropTarget ? elementForTarget(nextDropTarget) : null;
    const canvasRect = canvas?.getBoundingClientRect();
    const snappedPosition = targetElement && canvas && canvasRect
      ? (() => {
          const targetRect = targetElement.getBoundingClientRect();
          return {
            x: canvasVisualDeltaToLogical(targetRect.left - canvasRect.left, canvasZoomRef.current),
            y: canvasVisualDeltaToLogical(targetRect.top - canvasRect.top, canvasZoomRef.current)
          };
        })()
      : null;
    setPositions((previous) => ({
      ...previous,
      [drag.blockId]: snappedPosition ?? {
        x: drag.startPosition.x + dx,
        y: drag.startPosition.y + dy
      }
    }));
    updateDropTarget(nextDropTarget);
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = drag.active
      ? findDropTarget(event.clientX, event.clientY, drag.rootIndex)
      : null;
    if (drag.active && target) {
      const attached = attachCanvasRoot(
        forestRef.current,
        drag.rootIndex,
        target.rootIndex,
        target.path,
        target.append === true
      );
      if (attached !== forestRef.current) {
        setEditingNode(null);
        // One drag = one undo step. The detach half already snapshotted the
        // pre-drag forest, so drop it and let the attach entry stand in.
        const detachEntry = drag.path.length > 0 ? undoStackRef.current.pop() : undefined;
        applyForestChange(attached, null);
        if (detachEntry) {
          undoStackRef.current[undoStackRef.current.length - 1] = detachEntry;
        }
      }
    }
    dragRef.current = null;
    setDraggingBlockId(null);
    updateDropTarget(null);
    if (drag.active) {
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingBlockId(null);
    updateDropTarget(null);
    suppressClickRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const elementForTarget = (target: CanvasFocus): HTMLElement | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const block = canvas.querySelector<HTMLElement>(
      `[data-canvas-root-index="${target.rootIndex}"]`
    );
    if (!block) return null;
    // An append target points one past the last child, so it has no element
    // of its own — highlight the variadic parent that will grow instead.
    const encoded = (target.append ? target.path.slice(0, -1) : target.path).join('.');
    const pathElements = Array.from(
      block.querySelectorAll<HTMLElement>('[data-tree-path]')
    );
    const exact = pathElements.find(
      (element) => (element.getAttribute('data-tree-path') ?? '') === encoded
    );
    if (exact) return exact;
    if (target.path.length === 0) return block;

    const prefix = `${encoded}.`;
    const descendants = pathElements.filter((element) =>
      (element.getAttribute('data-tree-path') ?? '').startsWith(prefix)
    );
    if (descendants.length === 0) return null;
    let common = descendants[0].parentElement;
    while (
      common &&
      common !== block &&
      !descendants.every((element) => common!.contains(element))
    ) {
      common = common.parentElement;
    }
    return common && block.contains(common) ? common : null;
  };

  const startEditingTarget = (
    target: CanvasFocus,
    scope: CanvasEditScope = 'macro'
  ): void => {
    const node = getNodeAtPath(forestRef.current[target.rootIndex], target.path.join('.'));
    if (!node) return;
    const element = elementForTarget(target);
    const canvas = canvasRef.current;
    if (!element || !canvas) return;
    // An empty slot has no Macro of its own to rename — filling it always
    // means authoring a whole subtree.
    const effectiveScope: CanvasEditScope = isCanvasHole(node) ? 'subtree' : scope;
    const rect = element.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    setFocused(target);
    setContextMenu(null);
    // The two floating inputs are mutually exclusive by construction.
    setAddingRootFromMacro(false);
    setEditingNode({
      ...target,
      scope: effectiveScope,
      left: canvasVisualDeltaToLogical(rect.left - canvasRect.left, canvasZoomRef.current),
      top: canvasVisualDeltaToLogical(rect.top - canvasRect.top, canvasZoomRef.current),
      value: isCanvasHole(node)
        ? ''
        : effectiveScope === 'macro'
          ? stringifyLeafHead(node)
          : serializeTreePreserving(node),
      error: null
    });
  };

  /**
   * Resolve the mouse position to the subtree a drag from the same spot
   * would detach. Prefers the target the pointer-down handler already
   * resolved so click focus and drag payload can never disagree.
   */
  const targetForMouseEvent = (
    event: React.MouseEvent<HTMLDivElement>
  ): CanvasFocus | null => {
    const block = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-canvas-root-index]'
    );
    if (!block) return null;
    const rootIndex = Number(block.dataset.canvasRootIndex);
    if (!Number.isInteger(rootIndex) || !forestRef.current[rootIndex]) return null;
    const remembered = lastPointerTargetRef.current;
    // Only reuse the drag-resolved target when this very gesture landed on the
    // same block; otherwise re-resolve from the DOM.
    if (remembered && remembered.rootIndex === rootIndex) {
      const element = elementForTarget(remembered);
      if (element && (element === event.target || element.contains(event.target as Node))) {
        return remembered;
      }
    }
    const resolved = resolveCanvasPointerTarget(
      event.target as HTMLElement,
      block,
      forestRef.current[rootIndex],
      event.clientX,
      event.clientY
    ) ?? { path: [], rect: block.getBoundingClientRect() };
    return { rootIndex, path: resolved.path };
  };

  const insideOpenEditor = (node: Node | null): boolean => {
    if (!node) return false;
    // Both floating inputs count: the node editor AND the add-root input.
    // Missing the latter is how it used to survive clicks that should have
    // destroyed it (Cat 2026-07-26).
    return [editorRef.current, addRootRef.current].some((control) => {
      if (!control) return false;
      const surface = control.closest('[data-macro-id-control]');
      return Boolean(control.contains(node) || surface?.contains(node));
    });
  };

  /** Tear down every floating Canvas input. One exit door, no leaks. */
  const closeCanvasInputs = (): void => {
    addRootRequestRef.current += 1;
    nodeEditRequestRef.current += 1;
    setEditingNode(null);
    setAddingRootFromMacro(false);
  };

  /** Return keyboard focus without letting the browser scroll the Entry form. */
  const restoreCanvasFocus = (): void => {
    window.setTimeout(() => canvasRef.current?.focus({ preventScroll: true }), 0);
  };

  /**
   * The context menu and the arity control are rendered inside the canvas, so
   * the canvas' own capture-phase click handler and the block pointer
   * handlers would otherwise swallow or preventDefault their clicks — which
   * is exactly why the menu felt dead. These attributes mark those subtrees
   * as off-limits.
   *
   * The click guard is defensive against capture-phase ordering: jsdom lets
   * the menu item's onClick run even after the canvas clears the menu, so
   * only the pointerdown path is observable in tests.
   */
  const insideContextMenu = (node: Node | null): boolean =>
    Boolean(
      node &&
        (node as HTMLElement).closest?.(
          '[data-canvas-menu], [data-canvas-arity-control], [data-canvas-macro-control]'
        )
    );

  const insideRenderedSnl = (node: Node | null): boolean =>
    Boolean(node && (node as HTMLElement).closest?.('.katex-html'));

  const handleCanvasClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    if (insideContextMenu(event.target as Node)) return;
    // SnlSyntaxTreeView's reading interaction deliberately resolves `partial`
    // nodes through to a non-partial ancestor. Canvas owns click semantics, so
    // stop the inner delegated click while still resolving/focusing the exact
    // tree path in this capture handler.
    if (insideRenderedSnl(event.target as Node)) event.stopPropagation();
    if (suppressCanvasClickRef.current) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setContextMenu(null);
    // A stray click anywhere on the Canvas dismisses a pending root insert.
    setAddingRootFromMacro(false);
    const target = targetForMouseEvent(event);
    if (!target) {
      setFocused(null);
      return;
    }
    setFocused(target);
    const node = getNodeAtPath(
      forestRef.current[target.rootIndex],
      target.path.join('.')
    );
    if (isCanvasHole(node)) startEditingTarget(target, 'subtree');
  };

  /** Double click == click here + F2: edit this node's own macro. */
  const handleCanvasDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    if (insideContextMenu(event.target as Node)) return;
    const target = targetForMouseEvent(event);
    if (!target) return;
    event.preventDefault();
    setAddingRootFromMacro(false);
    setFocused(target);
    startEditingTarget(target, 'macro');
  };

  const handleCanvasContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (insideOpenEditor(event.target as Node)) return;
    // The menu itself is inside the canvas; never re-open on top of itself.
    if ((event.target as HTMLElement).closest('[data-canvas-menu]')) {
      event.preventDefault();
      return;
    }
    const target = targetForMouseEvent(event);
    event.preventDefault();
    event.stopPropagation();
    const canvas = canvasRef.current;
    const canvasRect = canvas?.getBoundingClientRect();
    const left = canvas && canvasRect
      ? canvasVisualDeltaToLogical(event.clientX - canvasRect.left, canvasZoomRef.current)
      : event.clientX;
    const top = canvas && canvasRect
      ? canvasVisualDeltaToLogical(event.clientY - canvasRect.top, canvasZoomRef.current)
      : event.clientY;
    closeCanvasInputs();
    // Blank canvas space gets its own menu whose only action adds a root.
    if (!target) {
      setFocused(null);
      setContextMenu({ rootIndex: -1, path: [], left, top });
      return;
    }
    setFocused(target);
    setContextMenu({ ...target, left, top });
  };

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // A floating input owns the keyboard while it is open.
    if (editingNode || addingRootFromMacro) return;
    if (
      !focused &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'f'
    ) {
      event.preventDefault();
      setAddingRootFromMacro(true);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (contextMenu) {
        setContextMenu(null);
        return;
      }
      setFocused(null);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoForestChange();
      return;
    }
    // Cat 2026-07-25 navigation model:
    //   Tab / ArrowRight        -> next sibling (roots cycle among roots)
    //   Shift+Tab / ArrowLeft   -> previous sibling
    //   Enter / ArrowDown       -> first child (no-op on a leaf)
    //   Shift+Enter / ArrowUp   -> parent (no-op at a root)
    const move =
      event.key === 'Tab'
        ? (event.shiftKey ? 'previous' : 'next')
        : event.key === 'ArrowRight'
          ? 'next'
          : event.key === 'ArrowLeft'
            ? 'previous'
            : event.key === 'Enter'
              ? (event.shiftKey ? 'parent' : 'child')
              : event.key === 'ArrowDown'
                ? 'child'
                : event.key === 'ArrowUp'
                  ? 'parent'
                  : null;
    if (move) {
      event.preventDefault();
      const next = moveCanvasCursor(forestRef.current, focused, move);
      if (next) setFocused(next);
      return;
    }
    if (event.key === 'F2' && focused) {
      event.preventDefault();
      // Cat 2026-07-25: F2 now edits only this block's Macro; the old
      // whole-subtree DSL editor moved to Ctrl/Cmd+F2.
      startEditingTarget(focused, event.ctrlKey || event.metaKey ? 'subtree' : 'macro');
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && focused) {
      event.preventDefault();
      const next = deleteCanvasTarget(
        forestRef.current,
        focused.rootIndex,
        focused.path,
        parentIsDynamic(focused)
      );
      applyForestChange(next, null);
      return;
    }
    // Dynamic-arity nodes own their argument count, so `+` / `-` edit it
    // directly (numpad preferred — see CANVAS_ARITY_KEYS).
    if (focused) {
      const delta = canvasArityDelta(event);
      if (delta !== null) {
        const node = getNodeAtPath(
          forestRef.current[focused.rootIndex],
          focused.path.join('.')
        );
        if (node && isDynamicMacro(node.macro_name)) {
          event.preventDefault();
          changeDynamicArity(focused, delta);
        }
      }
    }
  };

  /** True when the focused node's PARENT is a variadic Macro. */
  const parentIsDynamic = (target: CanvasFocus): boolean => {
    if (target.path.length === 0) return false;
    const parent = getNodeAtPath(
      forestRef.current[target.rootIndex],
      target.path.slice(0, -1).join('.')
    );
    return Boolean(parent && isDynamicMacro(parent.macro_name));
  };

  const changeCanvasStyle = (
    target: CanvasFocus,
    selected: string,
    styleNames: readonly string[]
  ): void => {
    const root = forestRef.current[target.rootIndex];
    const node = getNodeAtPath(root, target.path.join('.'));
    if (!root || !node) return;
    const defaultStyle = styleNames[0] ?? '';
    const replacement: SnlSyntaxTree = {
      ...node,
      style_name:
        selected === '' || selected === defaultStyle ? undefined : selected
    };
    inheritTreeIdentity(node, replacement);
    const next = replaceCanvasTarget(
      forestRef.current,
      target.rootIndex,
      target.path,
      replacement
    );
    applyForestChange(next, target);
  };

  const changeDynamicArity = (target: CanvasFocus, delta: number): void => {
    const node = getNodeAtPath(
      forestRef.current[target.rootIndex],
      target.path.join('.')
    );
    if (!node) return;
    const next = setCanvasDynamicArity(
      forestRef.current,
      target.rootIndex,
      target.path,
      node.children.length + delta,
      ensureTreeIdentity
    );
    applyForestChange(next);
  };

  /** Resolve whether an inserted Macro is fixed, variadic/temporary, or unknown. */
  const macroArityForNode = async (
    node: SnlSyntaxTree
  ): Promise<number | 'dynamic' | null> => {
    // Delimited `%…%` / `$…$` / `$$…$$` nodes are temporary Macros. They
    // intentionally bypass the Macro DB, but remain structurally extensible;
    // a newly created one therefore follows the variadic one-slot affordance.
    if (node.env_mode !== undefined) return 'dynamic';
    const name = node.macro_name.trim();
    if (!name) return null;
    try {
      const macro = await macroDataDriver.query_macro({ macro_name: name });
      if (!macro) return null;
      if (macro.dynamic_arity === true) return 'dynamic';
      return macroTemplateArity(macro);
    } catch {
      return null;
    }
  };

  /**
   * Position and metadata for the floating focused-Macro control. Every real
   * Macro gets ↗; variadic ones share the same panel with [- n +].
   */
  const focusedMacroControl = React.useMemo(() => {
    if (!focused || editingNode || contextMenu) return null;
    const node = getNodeAtPath(forest[focused.rootIndex], focused.path.join('.'));
    if (!node || isCanvasHole(node) || !node.macro_name.trim()) return null;
    const element = elementForTarget(focused);
    const canvas = canvasRef.current;
    if (!element || !canvas) return null;
    const rect = element.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      target: focused,
      node,
      dynamic: isDynamicMacro(node.macro_name),
      count: node.children.length,
      left: canvasVisualDeltaToLogical(rect.left - canvasRect.left, canvasZoomRef.current),
      top: canvasVisualDeltaToLogical(rect.bottom - canvasRect.top, canvasZoomRef.current) + 4
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, editingNode, contextMenu, forest, dynamicArityVersion]);

  const commitNodeEdit = async (): Promise<void> => {
    if (!editingNode) return;
    const request = ++nodeEditRequestRef.current;
    const sourceForest = forestRef.current;
    const previousNode = getNodeAtPath(
      sourceForest[editingNode.rootIndex],
      editingNode.path.join('.')
    );
    let replacement: SnlSyntaxTree;
    if (editingNode.scope === 'macro') {
      // Macro scope rewrites only the head; children stay exactly as they are.
      const head = editingNode.value.trim();
      if (head.includes('(') || head.includes(',')) {
        setEditingNode((previous) => previous
          ? { ...previous, error: t('macroEditSingleId') }
          : null);
        return;
      }
      const parsedHead = tryParseSnlSyntaxTree(head);
      if (!parsedHead.ok) {
        setEditingNode((previous) => previous ? { ...previous, error: parsedHead.error } : null);
        return;
      }
      if (parsedHead.tree.style_name !== undefined) {
        setEditingNode((previous) => previous
          ? { ...previous, error: t('macroEditNameOnly') }
          : null);
        return;
      }
      const base = previousNode ?? parsedHead.tree;
      replacement = {
        ...base,
        macro_name: parsedHead.tree.macro_name,
        kind: parsedHead.tree.kind,
        env_mode: parsedHead.tree.env_mode,
        binder_explicit: parsedHead.tree.binder_explicit,
        scope: parsedHead.tree.binder_explicit ? parsedHead.tree.scope : base.scope,
        mdata: parsedHead.tree.binder_explicit
          ? { ...((base.mdata && typeof base.mdata === 'object' && !Array.isArray(base.mdata))
              ? base.mdata as Record<string, unknown>
              : {}), ...((parsedHead.tree.mdata && typeof parsedHead.tree.mdata === 'object' && !Array.isArray(parsedHead.tree.mdata))
              ? parsedHead.tree.mdata as Record<string, unknown>
              : {}) }
          : withoutBindingMetadata(base.mdata),
        style_name: previousNode ? previousNode.style_name : undefined,
        children: previousNode ? previousNode.children : parsedHead.tree.children
      };
      if (previousNode) inheritTreeIdentity(previousNode, replacement);
      else ensureTreeIdentity(replacement);
    } else {
      const parsed = tryParseSnlSyntaxTree(editingNode.value.trim());
      if (!parsed.ok) {
        setEditingNode((previous) => previous ? { ...previous, error: parsed.error } : null);
        return;
      }
      if (previousNode) inheritTreeIdentity(previousNode, parsed.tree);
      else ensureTreeIdentity(parsed.tree);
      replacement = parsed.tree;
    }
    const replaced = replaceCanvasTarget(
      sourceForest,
      editingNode.rootIndex,
      editingNode.path,
      replacement
    );
    if (replaced === sourceForest) return;
    // Cat 2026-07-25: the new Macro's arity decides what happens to the old
    // children — surplus subtrees pop out as their own root blocks, missing
    // slots become empty placeholders the author fills in manually. Never
    // swallow a subtree and never resurrect one.
    const arity = await macroArityForNode(replacement);
    if (
      request !== nodeEditRequestRef.current ||
      forestRef.current !== sourceForest
    ) return;
    const isNewMacro =
      !previousNode ||
      isCanvasHole(previousNode) ||
      previousNode.macro_name !== replacement.macro_name ||
      previousNode.env_mode !== replacement.env_mode;
    const targetArity: number | null =
      arity === 'dynamic'
        ? (isNewMacro && replacement.children.length === 0 ? 1 : null)
        : arity;
    const next = targetArity === null
      ? replaced
      : reconcileCanvasArity(
          replaced,
          editingNode.rootIndex,
          editingNode.path,
          targetArity,
          // Evicted subtrees become their own blocks; they must keep a stable
          // identity so their canvas position is preserved rather than reset.
          ensureTreeIdentity
        );
    applyForestChange(next);
    setEditingNode(null);
    restoreCanvasFocus();
  };

  React.useEffect(() => {
    if (!editingNode && !addingRootFromMacro) return;
    const commitOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (insideOpenEditor(target)) return;
      suppressCanvasClickRef.current = true;
      document.addEventListener('click', () => {
        suppressCanvasClickRef.current = false;
      }, { once: true });
      document.addEventListener('pointerup', () => {
        window.setTimeout(() => { suppressCanvasClickRef.current = false; }, 0);
      }, { once: true });
      // Clicking away has the same semantics as Escape: discard the draft.
      closeCanvasInputs();
      restoreCanvasFocus();
    };
    document.addEventListener('pointerdown', commitOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', commitOnOutsidePointer, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingNode, addingRootFromMacro]);

  // A right-click menu must also close when the user clicks anywhere outside
  // the Canvas (the canvas click handler only sees clicks inside it).
  React.useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const canvas = canvasRef.current;
      const target = event.target as Node | null;
      if (canvas && target && canvas.contains(target)) return;
      setContextMenu(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [contextMenu]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const decorate = (): void => {
      canvas.querySelectorAll('.snl-canvas-focused').forEach((element) =>
        element.classList.remove('snl-canvas-focused')
      );
      canvas.querySelectorAll('.snl-canvas-drop-target').forEach((element) =>
        element.classList.remove('snl-canvas-drop-target')
      );
      if (focused) elementForTarget(focused)?.classList.add('snl-canvas-focused');
      if (dropTarget) elementForTarget(dropTarget)?.classList.add('snl-canvas-drop-target');
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(canvas, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [forest, focused, dropTarget]);

  const renderTemporaryChildRails = (
    node: SnlSyntaxTree,
    path: number[]
  ): React.ReactNode => {
    if (node.env_mode === undefined) {
      return node.children.map((child, index) =>
        renderTemporaryChildRails(child, [...path, index])
      );
    }
    if (node.children.length === 0) return null;
    return (
      <div
        data-canvas-temporary-children
        style={{ display: 'flex', gap: '0.35rem', alignItems: 'flex-start', marginTop: '0.35rem' }}
      >
        {node.children.map((child, index) => {
          const childPath = [...path, index];
          const hole = isCanvasHole(child);
          return (
            <div
              key={treeIdentity(child)}
              data-canvas-temporary-child
              data-tree-path={childPath.join('.')}
              data-kind={child.kind}
              className={hole ? 'snlArgPlaceholder' : undefined}
              title={hole ? t('leafPlaceholder') : undefined}
              style={{
                minWidth: hole ? '2.5rem' : undefined,
                minHeight: hole ? '1.75rem' : undefined,
                padding: '0.2rem 0.35rem',
                boxSizing: 'border-box',
                border: hole
                  ? '1px dashed var(--vscode-input-placeholderForeground, #888)'
                  : '1px solid var(--vscode-panel-border, #555)',
                borderRadius: '4px',
                background: hole
                  ? 'var(--vscode-input-background, #2a2a2a)'
                  : 'var(--vscode-editorWidget-background, #252526)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {hole ? (
                <span aria-hidden="true" style={{ opacity: 0.65 }}>+</span>
              ) : (
                <CanvasPathPrefixedTreeView
                  canonicalPath={childPath}
                  tree={child}
                  macro_data_driver={macroDataDriver}
                  reader_runtime={webview_language_runtime}
                  kindPalette={kindPalette}
                  hooks={{ renderTooltip: () => null, renderers: extensionRenderers }}
                />
              )}
              {renderTemporaryChildRails(child, childPath)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section>
      <div
        ref={viewportRef}
        data-entry-gui-canvas-viewport
        style={{
          width: '100%',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
          contain: 'inline-size',
          height: '32rem',
          overflowX: 'auto',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          border: '1px solid var(--vscode-panel-border, #444)',
          borderRadius: '6px',
          backgroundColor: 'var(--vscode-editor-background)'
        }}
      >
      <div
        ref={canvasRef}
        data-entry-gui-canvas
        aria-label={t('canvasAria')}
        tabIndex={0}
        onClickCapture={handleCanvasClick}
        onMouseMoveCapture={(event) => {
          // Block SnlSyntaxTreeView's reading hover/highlight before its own
          // bubble handler can resolve a partial node to an ancestor.
          if (insideRenderedSnl(event.target as Node)) event.stopPropagation();
        }}
        onDoubleClickCapture={handleCanvasDoubleClick}
        onContextMenu={handleCanvasContextMenu}
        onKeyDown={handleCanvasKeyDown}
        style={{
          position: 'relative',
          zoom: canvasZoom,
          minWidth: '100%',
          width: canvasExtent.width > 0 ? canvasExtent.width : '100%',
          height: canvasExtent.height > 0 ? canvasExtent.height : '32rem',
          boxSizing: 'border-box',
          overflow: 'visible',
          fontSize: '1.05rem',
          backgroundImage:
            'radial-gradient(circle, var(--vscode-editorWidget-border, #555) 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      >
        {forest.map((root, rootIndex) => {
          const blockId = treeIdentity(root);
          const position = positions[blockId] ?? { x: 24, y: 24 };
          return (
            <div
              key={blockId}
              data-canvas-root={blockId}
              data-canvas-root-index={rootIndex}
              onPointerEnter={() => setHoveredBlockId(blockId)}
              onPointerLeave={() => setHoveredBlockId((current) => current === blockId ? null : current)}
              onPointerDownCapture={(event) => beginPointer(event, rootIndex, blockId)}
              onPointerMoveCapture={movePointer}
              onPointerUpCapture={endPointer}
              onPointerCancelCapture={cancelPointer}
              style={{
                position: 'absolute',
                left: position.x,
                top: position.y,
                display: 'inline-block',
                width: 'max-content',
                maxWidth: 'none',
                boxSizing: 'border-box',
                overflow: 'visible',
                padding: '0.3rem',
                border: '1px solid var(--vscode-focusBorder, #007fd4)',
                borderRadius: '5px',
                background: hoveredBlockId === blockId
                  ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.08))'
                  : 'var(--vscode-editorWidget-background, #252526)',
                boxShadow: '0 3px 12px rgba(0,0,0,0.28)',
                touchAction: 'none',
                zIndex: draggingBlockId === blockId ? 1000 : hoveredBlockId === blockId ? 1 : 0,
                cursor: draggingBlockId === blockId ? 'grabbing' : 'grab',
                userSelect: 'none',
                WebkitUserSelect: 'none'
              }}
            >
              <SnlSyntaxTreeView
                tree={root}
                macro_data_driver={macroDataDriver}
                reader_runtime={webview_language_runtime}
                kindPalette={kindPalette}
                hooks={{ renderTooltip: () => null, renderers: extensionRenderers }}
              />
            </div>
          );
        })}
        {editingNode ? (
          <MacroIdInput
            ref={editorRef}
            multiline
            autoSize
            autoFocus
            className="snl-canvas-node-input"
            aria-label={t('editFocusedSnl')}
            selectAllOnMount
            macroCandidates={macroCandidates}
            snooglInsertsMacroId={editingNode.scope === 'subtree'}
            value={editingNode.value}
            onChange={(value) => setEditingNode({
              ...editingNode,
              value,
              error: null
            })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                commitNodeEdit();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditingNode(null);
                restoreCanvasFocus();
              }
            }}
            title={
              editingNode.error ??
              (editingNode.scope === 'macro'
                ? t('editMacroInput')
                : t('enterSnlDsl'))
            }
            style={{
              position: 'absolute',
              left: editingNode.left,
              top: editingNode.top,
              maxWidth: `calc(100% - ${Math.max(0, editingNode.left) + 8}px)`,
              zIndex: 20,
              borderColor: editingNode.error
                ? 'var(--vscode-errorForeground, #f48771)'
                : undefined
            }}
          />
        ) : null}
        {addingRootFromMacro ? (
          <MacroIdInput
            ref={addRootRef}
            autoFocus
            openSnooglOnMount
            aria-label={t('insertCanvasRoot')}
            macroCandidates={macroCandidates}
            value=""
            onChange={(value) => {
              const parsed = tryParseSnlSyntaxTree(value.trim());
              if (!parsed.ok) return;
              // Root insertion used to bypass the arity reconciliation shared
              // by every existing-node edit. Consequently a fixed-arity Macro
              // selected from SNooGL entered the Canvas with zero children and
              // no placeholders. Resolve before publishing the new forest, so
              // the first observable frame already has the required slots.
              void (async () => {
                const request = ++addRootRequestRef.current;
                const sourceForest = forestRef.current;
                ensureTreeIdentity(parsed.tree);
                const arity = await macroArityForNode(parsed.tree);
                if (
                  request !== addRootRequestRef.current ||
                  forestRef.current !== sourceForest
                ) return;
                const next = [...sourceForest, parsed.tree];
                const rootIndex = next.length - 1;
                const targetArity: number | null =
                  arity === 'dynamic'
                    ? (parsed.tree.children.length === 0 ? 1 : null)
                    : arity;
                const reconciled = targetArity === null
                  ? next
                  : reconcileCanvasArity(
                      next,
                      rootIndex,
                      [],
                      targetArity,
                      ensureTreeIdentity
                    );
                setAddingRootFromMacro(false);
                applyForestChange(reconciled, { rootIndex, path: [] });
                restoreCanvasFocus();
              })();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') {
                event.preventDefault();
                closeCanvasInputs();
                restoreCanvasFocus();
              }
            }}
            style={{
              position: 'absolute',
              left: 24,
              top: 24,
              width: '18rem',
              zIndex: 20
            }}
          />
        ) : null}
        {focusedMacroControl ? (
          <div
            data-canvas-macro-control
            data-canvas-arity-control={focusedMacroControl.dynamic ? true : undefined}
            aria-label={focusedMacroControl.dynamic ? t('argumentCount') : t('macroActions')}
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              left: focusedMacroControl.left,
              top: focusedMacroControl.top,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              padding: '0.15rem 0.3rem',
              borderRadius: '0.35rem',
              background: 'var(--vscode-editorWidget-background, #252526)',
              border: '1px solid var(--vscode-editorWidget-border, #454545)',
              zIndex: 19
            }}
          >
            {focusedMacroControl.dynamic ? (
              <>
                <IconButton
                  icon="remove"
                  label={t('removeArgument')}
                  variant="secondary"
                  size="sm"
                  disabled={focusedMacroControl.count === 0}
                  onClick={() => changeDynamicArity(focusedMacroControl.target, -1)}
                />
                <span aria-label={t('argumentCountValue')} style={{ minWidth: '1.2rem', textAlign: 'center' }}>
                  {focusedMacroControl.count}
                </span>
                <IconButton
                  icon="add"
                  label={t('addArgument')}
                  variant="secondary"
                  size="sm"
                  onClick={() => changeDynamicArity(focusedMacroControl.target, 1)}
                />
              </>
            ) : null}
            {(() => {
              const node = focusedMacroControl.node;
              const name = node.macro_name.trim();
              const known = Boolean(macroOrigin[name]);
              const styleNames = macroStylesByName.get(name) ?? [];
              const selectedStyle = node.style_name ?? styleNames[0] ?? '';
              const explicitStyleMissing =
                Boolean(node.style_name) && !styleNames.includes(node.style_name!);
              return (
                <>
                  {styleNames.length > 0 || explicitStyleMissing ? (
                    <select
                      aria-label={t('macroStyle')}
                      value={selectedStyle}
                      onChange={(event) =>
                        changeCanvasStyle(
                          focusedMacroControl.target,
                          event.target.value,
                          styleNames
                        )
                      }
                      onKeyDown={(event) => event.stopPropagation()}
                      title={t('selectMacroStyle')}
                      style={{
                        maxWidth: '9rem',
                        padding: '0.15rem 0.3rem',
                        background: 'var(--vscode-dropdown-background, #2a2a2a)',
                        color: 'var(--vscode-dropdown-foreground, #ddd)',
                        border: '1px solid var(--vscode-dropdown-border, #555)'
                      }}
                    >
                      {explicitStyleMissing && styleNames.length === 0 ? (
                        <option value="">{t('clearStyle')}</option>
                      ) : null}
                      {explicitStyleMissing ? (
                        <option value={node.style_name}>{node.style_name} {t('missing')}</option>
                      ) : null}
                      {styleNames.map((style, index) => (
                        <option key={style} value={style}>
                          {style}{index === 0 ? t('defaultSuffix') : ''}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <IconButton
                    icon={known ? 'edit' : 'add'}
                    label={known ? t('editMacro') : t('createMacro')}
                    variant="ghost"
                    size="sm"
                    title={
                      known
                        ? t('openEditMacro', { name, origin: macroOrigin[name] })
                        : t('openCreateMacroPrefill', { name })
                    }
                    onClick={() =>
                      onOpenMacroEditor({
                        name,
                        env_mode: node.env_mode === 'block' ? undefined : node.env_mode,
                        style_name: node.style_name
                      })
                    }
                  />
                </>
              );
            })()}
          </div>
        ) : null}
        {contextMenu ? (
          <CanvasContextMenuView
            menu={contextMenu}
            node={contextMenu.rootIndex < 0 ? undefined : getNodeAtPath(
              forestRef.current[contextMenu.rootIndex],
              contextMenu.path.join('.')
            )}
            onAddRoot={() => {
              setEditingNode(null);
              setAddingRootFromMacro(true);
            }}
            onEditMacro={() => startEditingTarget(contextMenu, 'macro')}
            onEditSubtree={() => startEditingTarget(contextMenu, 'subtree')}
            isDynamic={
              contextMenu.rootIndex >= 0 &&
              isDynamicMacro(
                getNodeAtPath(
                  forestRef.current[contextMenu.rootIndex],
                  contextMenu.path.join('.')
                )?.macro_name ?? ''
              )
            }
            onAddArgument={() => {
              setContextMenu(null);
              changeDynamicArity(contextMenu, 1);
            }}
            onRemoveArgument={() => {
              setContextMenu(null);
              changeDynamicArity(contextMenu, -1);
            }}
            onDetach={() => {
              if (contextMenu.path.length === 0) return;
              const next = detachCanvasSubtree(
                forestRef.current,
                contextMenu.rootIndex,
                contextMenu.path,
                parentIsDynamic(contextMenu)
              );
              setContextMenu(null);
              applyForestChange(next, { rootIndex: next.length - 1, path: [] });
            }}
            onDelete={() => {
              const next = deleteCanvasTarget(
                forestRef.current,
                contextMenu.rootIndex,
                contextMenu.path,
                parentIsDynamic(contextMenu)
              );
              setContextMenu(null);
              applyForestChange(next, null);
            }}
            onClose={(direction) => {
              setContextMenu(null);
              if (direction === 'next') {
                const focusable = [...document.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
                )];
                const canvas = canvasRef.current;
                const lastCanvasIndex = focusable.reduce(
                  (last, element, index) => canvas?.contains(element) ? index : last,
                  -1
                );
                focusable.slice(lastCanvasIndex + 1).find(
                  (element) => !element.closest('[role="menu"]')
                )?.focus();
              } else {
                window.setTimeout(() => canvasRef.current?.focus(), 0);
              }
            }}
          />
        ) : null}
      </div>
      </div>
      {!canPersistCanvasForest(forest) ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.45rem' }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setFocused(null);
              closeCanvasInputs();
              updateDropTarget(null);
              onResetFromSnl();
            }}
          >
            {t('resetCanvas')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// {t('guiInductive')} — library-outline-styled tree editor
// ---------------------------------------------------------------------------

/**
 * Canvas right-click menu (cat 2026-07-25). Right click on a block owns the
 * gesture: it focuses that subtree and offers the same operations the
 * keyboard exposes, so the Canvas never falls through to the host menu.
 */
function CanvasContextMenuView({
  menu,
  node,
  isDynamic,
  onAddRoot,
  onEditMacro,
  onEditSubtree,
  onAddArgument,
  onRemoveArgument,
  onDetach,
  onDelete,
  onClose
}: {
  menu: CanvasContextMenu;
  node: SnlSyntaxTree | undefined;
  isDynamic: boolean;
  onAddRoot: () => void;
  onEditMacro: () => void;
  onEditSubtree: () => void;
  onAddArgument: () => void;
  onRemoveArgument: () => void;
  onDetach: () => void;
  onDelete: () => void;
  onClose: (direction: 'restore' | 'next') => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const onBlankSpace = menu.rootIndex < 0;
  const isRoot = menu.path.length === 0;
  const isHole = isCanvasHole(node);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const items: Array<{
    label: string;
    hint?: string;
    disabled?: boolean;
    danger?: boolean;
    run: () => void;
  }> =
    onBlankSpace
      ? [{ label: t('addRootMacro'), hint: 'Ctrl+F', run: onAddRoot }]
      : [
          { label: t('editMacroMenu'), hint: 'F2', disabled: isHole, run: onEditMacro },
          { label: t('editSubtreeSnl'), hint: 'Ctrl+F2', run: onEditSubtree },
          // Only a variadic Macro owns its argument count; a fixed-arity one
          // gets it from the template and must not be edited by hand.
          ...(isDynamic
            ? [
                { label: t('addArgument'), hint: '+', run: onAddArgument },
                {
                  label: t('removeArgument'),
                  hint: '-',
                  disabled: (node?.children.length ?? 0) === 0,
                  run: onRemoveArgument
                }
              ]
            : []),
          {
            label: t('detachBlock'),
            disabled: isRoot || isHole,
            run: onDetach
          },
          { label: t('delete'), hint: 'Del', disabled: isHole, danger: true, run: onDelete }
        ];

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, []);

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const enabled = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)'
    )];
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose(event.key === 'Tab' && !event.shiftKey ? 'next' : 'restore');
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || enabled.length === 0) {
      return;
    }
    event.preventDefault();
    const current = Math.max(0, enabled.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? enabled.length - 1
        : event.key === 'ArrowUp'
          ? (current - 1 + enabled.length) % enabled.length
          : (current + 1) % enabled.length;
    enabled[next]?.focus();
  };
  return (
    <div
      ref={menuRef}
      role="menu"
      data-canvas-menu
      aria-label={t('canvasBlockActions')}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={moveMenuFocus}
      style={{
        position: 'absolute',
        left: menu.left,
        top: menu.top,
        zIndex: 50,
        minWidth: '14rem',
        padding: '0.25rem',
        borderRadius: '5px',
        border: '1px solid var(--vscode-widget-border, #555)',
        background: 'var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526))',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        fontSize: '0.9rem'
      }}
    >
      {items.map((item) => (
        <MenuItemButton
          key={item.label}
          disabled={item.disabled}
          danger={item.danger}
          onClick={() => {
            if (item.disabled) return;
            item.run();
            onClose('restore');
          }}
          style={{
            justifyContent: 'space-between',
            gap: '1rem',
            color: item.disabled ? 'var(--vscode-disabledForeground, #777)' : undefined
          }}
        >
          <span>{item.label}</span>
          {item.hint ? <span style={{ opacity: 0.6 }}>{item.hint}</span> : null}
        </MenuItemButton>
      ))}
    </div>
  );
}

//
// Cat 2026-07-12 reset. The old row was `[input] [+child] [-delete]` with an
// unconditional +child button and a light-mode inline input. This version
// mimics the Library outline (see CreateLibraryApp.tsx `OutlineRow`):
//
//   [chevron?] [#0.1.2] [ ─────── name input ─────── ] [+ child] [− delete]
//                                                       (hover only)
//
// Design notes:
//   1. Input CSS unified to the dark-mode `inputStyle` used across the panel
//      so it stops looking pasted-in.
//   2. Number label sits on the SAME line as the input, and is a full path
//      (`0.1.2`) that grows with depth. Indent + label length correlate so
//      deeper rows look visually anchored.
//   3. Rows with children render a chevron (▶/▼) on the far left; leaves
//      render a same-width spacer so numbers align. Toggle is per-row, held
//      in a `Set<path>` at the editor root.
//   4. +child / −delete only appear on hover (CSS `.snl-tree-row:hover
//      .snl-tree-row-toolbar`), same pattern as OutlineRow.
//   5. When the input text (parsed as a single leaf) resolves to a macro in
//      the merged DB with a `kind`, the input border+bg flip to that kind's
//      palette color. Delimited leaves (`$…$`, `%…%`) also color per their
//      inherent env_mode → mapped kind.
//   6. Syntax the parser understands stays in the text box verbatim: `$foo$`,
//      `$$x + y$$`, `%my text%`, `@$x$`, `foo[style]`, `foo.bar.baz`. On
//      serialize, each row's text is treated as a single leaf's source, then
//      re-hydrated to preserve `env_mode` / `kind='binder'` / `style`. This
//      keeps the round-trip clean without demanding new UI knobs — the raw
//      characters are the source of truth until we build proper inline
//      editors.
//
// The `SnlSyntaxTreeEditor` from @sjtu-ai4math/snl-basics is no longer used here —
// it renders its own recursion + a light-mode autocomplete dropdown that
// clashed with the new row layout. Autocomplete can come back as a separate
// enhancement later.

/**
 * Parse a single-node source string produced by the user (raw text they
 * typed into the row input) into the leaf-level fields of an SnlSyntaxTree.
 * Preserves env_mode / kind='binder' / style tag from the surface syntax.
 *
 * Falls back to `{name: raw, ...}` if the input can't be interpreted as a
 * single leaf — that way the user's typing is never destroyed mid-edit.
 */
function parseLeafSource(raw: string): {
  macro_name: string;
  style_name?: string;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { macro_name: '' };
  }
  // Prefix sigils such as binder `@`, `%`, and `$` remain literal characters
  // in the Macro channel. InductiveNode separately recognizes a suffix
  // `macro@entryId` and moves the part after `@` into the Context Entry field.
  // Parentheses and brackets retain their existing structural meaning:
  //   - `(` / `,` are handled at the row boundary (children), so if they
  //     show up inside the head we treat the whole raw string as an
  //     opaque name (defensive; the paren guard on the caller side
  //     usually keeps them out).
  //   - A trailing `[style]` is recognized only so the Macro-name input can
  //     immediately strip it; the independent dropdown is the sole Style writer.
  if (trimmed.includes('(') || trimmed.includes(',')) {
    return { macro_name: raw };
  }
  const styleMatch = trimmed.match(/^(.*)\[([^\[\]]*)\]$/);
  if (styleMatch) {
    return {
      macro_name: styleMatch[1],
      style_name: styleMatch[2].length > 0 ? styleMatch[2] : undefined
    };
  }
  return { macro_name: trimmed };
}

function splitContextEntrySurface(
  raw: string
): { macroSurface: string; contextEntryId: string } | null {
  const parsed = tryParseSnlSyntaxTree(raw);
  if (parsed.ok && parsed.tree.children.length === 0) {
    const contextEntryId = readContextEntryId(parsed.tree);
    if (contextEntryId !== undefined) {
      return {
        macroSurface: stringifyLeafHead(parsed.tree),
        contextEntryId
      };
    }
    return null;
  }

  // A just-typed trailing `@` is not parseable yet. Treat it as a context
  // separator only when everything before it is already one complete leaf.
  if (raw.endsWith('@')) {
    const macroSurface = raw.slice(0, -1);
    const prefix = tryParseSnlSyntaxTree(macroSurface);
    if (prefix.ok && prefix.tree.children.length === 0) {
      return { macroSurface, contextEntryId: '' };
    }
  }
  return null;
}

/**
 * Render an SnlSyntaxTree leaf's identity back to the source text the user
 * would have typed for it. Inverse of `parseLeafSource` (round-trippable for
 * the surface forms the row input accepts).
 */
function stringifyLeafSource(node: SnlSyntaxTree): string {
  const contextEntryId = readContextEntryId(node);
  const contextPart = contextEntryId ? `@${contextEntryId}` : '';
  const stylePart = node.style_name ? `[${node.style_name}]` : '';
  return `${stringifyLeafHead(node)}${contextPart}${stylePart}`;
}

function readContextEntryId(node: SnlSyntaxTree): string | undefined {
  if (!node.mdata || typeof node.mdata !== 'object' || Array.isArray(node.mdata)) {
    return undefined;
  }
  const src = (node.mdata as Record<string, unknown>).src;
  return typeof src === 'string' ? src : undefined;
}

export function withContextEntryId(node: SnlSyntaxTree, value: string): SnlSyntaxTree['mdata'] {
  const base =
    node.mdata && typeof node.mdata === 'object' && !Array.isArray(node.mdata)
      ? { ...(node.mdata as Record<string, unknown>) }
      : {};
  const trimmed = value.trim();
  if (trimmed) base.src = trimmed;
  else delete base.src;
  return Object.keys(base).length > 0 ? base : null;
}

function withoutBindingMetadata(mdata: SnlSyntaxTree['mdata']): SnlSyntaxTree['mdata'] {
  if (!mdata || typeof mdata !== 'object' || Array.isArray(mdata)) return mdata;
  const next = { ...(mdata as Record<string, unknown>) };
  delete next.bindRef;
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Same as `stringifyLeafSource` but omits the `[style]` suffix. Used for
 * the InductiveNode name-box `rawInput`, paired with a separate style
 * box on the right.
 *
 * Cat 2026-07-15 (v2): the name box shows prefix sigils literally. The
 * editor no longer reconstructs `%…%`, `$…$`, `$${'$'}…$${'$'}`
 * from `node.env_mode` / `node.kind`. Those fields are meaningful for
 * trees that came from an external SNL parse; for those, the name still
 * carries the identifier without the sigils and we prepend/wrap them so
 * the first render truthfully mirrors the source. But on ANY user edit,
 * `commitRaw` clears env_mode + kind and stores whatever the user typed
 * verbatim into `name` — so if you backspace the binder `@` off `@foo` it
 * actually goes away instead of the useEffect re-adding it. See
 * "GUI Editor 应该只管圆括号和方括号" for the design directive.
 */
function stringifyLeafHead(node: SnlSyntaxTree): string {
  // `kind: binder` is also assigned to bound occurrences by annotate-bind.
  // Only binder_explicit records an authored prefix `@` on this node.
  const binderPrefix = node.binder_explicit ? '@' : '';
  if (node.env_mode === 'text') {
    return `${binderPrefix}%${node.macro_name}%`;
  }
  if (node.env_mode === 'formula_inline') {
    return `${binderPrefix}$${node.macro_name}$`;
  }
  if (node.env_mode === 'formula_display') {
    return `${binderPrefix}$${'$'}${node.macro_name}$${'$'}`;
  }
  return `${binderPrefix}${node.macro_name}`;
}

/**
 * Resolve the effective `kind` for a row so we can color its input frame.
 * Priority: node.kind (set by parser for `@`-binder / annotate-bind) →
 * macro's declared kind in the merged DB → env_mode-driven default →
 * 'fvar' fallback (mirrors DEFAULT_KIND_PALETTE fallback used elsewhere).
 */
function resolveRowKind(node: SnlSyntaxTree, macro: SnlMacro | undefined): string {
  if (node.kind && node.kind !== '') return node.kind;
  if (macro?.kind) return macro.kind;
  if (node.env_mode === 'text') return 'const';
  if (node.env_mode === 'formula_inline' || node.env_mode === 'formula_display') {
    return 'const';
  }
  return 'fvar';
}

export function useQueriedMacro(
  driver: MacroDataDriver,
  macroName: string
): SnlMacro | undefined {
  const [result, setResult] = useState<{
    driver: MacroDataDriver;
    macroName: string;
    macro: SnlMacro | undefined;
  }>(() => ({ driver, macroName, macro: undefined }));
  // Epoch guard: `query_macro` has an LRU cache, so a cache HIT for the new
  // name can resolve long before an in-flight MISS for the previous one. The
  // AbortController only guards the driver's entry point, not a promise that
  // already resolved, so without this a late answer for an old name lands on
  // the current node — either opening slots that belong to the previous Macro
  // or clearing a result that had already arrived. Review 2026-07-25.
  const epochRef = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++epochRef.current;
    const settle = (value: SnlMacro | undefined): void => {
      if (epochRef.current === epoch) {
        setResult({ driver, macroName, macro: value });
      }
    };
    settle(undefined);
    void driver.query_macro({ macro_name: macroName, signal: controller.signal })
      .then((value) => settle(value ?? undefined))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          settle(undefined);
        }
      });
    return () => controller.abort();
  }, [driver, macroName]);
  // Effects clear state only after a render commits. Bind the stored result to
  // both query inputs so the first render for a new name/driver cannot expose
  // the previous Macro's kind, frame color, tooltip, Style list, or arity.
  return result.driver === driver && result.macroName === macroName
    ? result.macro
    : undefined;
}

/**
 * Fixed-arity a macro's default-style template implies. Returns the
 * required child count (i.e. max #N + 1 across all styles, since child
 * slots are numbered from 0). Returns 0 for dynamic-arity macros or
 * templates with no `#N` placeholders. Ignores escaped `\#`. Mirrors
 * `maxChildIndex` in CreateMacroApp.tsx — kept local to avoid a shared
 * module just for one 8-line helper.
 */
function macroTemplateArity(macro: SnlMacro): number {
  let max = -1;
  for (const style of macro.styles ?? []) {
    const tpl = resolve_style_template(style, webview_language_runtime);
    const re = /(?<!\\)#(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tpl)) !== null) {
      const idx = Number(m[1]);
      if (Number.isFinite(idx) && idx > max) max = idx;
    }
  }
  return max + 1;
}

function paletteFor(kindId: string): KindColoring {
  return DEFAULT_KIND_PALETTE[kindId] ?? DEFAULT_KIND_PALETTE.fvar;
}

/**
 * Payload for opening the Macro editor from a row (cat 2026-07-12). Sent
 * verbatim as a `openMacroEditor` message; the host picks edit vs create
 * and, on create, uses env_mode to prefill the mode + template.
 */
interface MacroOpenRequest {
  name: string;
  env_mode?: 'formula_inline' | 'formula_display' | 'text';
  style_name?: string;
}

export function GuiInductiveEditor({
  editorIdentity,
  snl,
  entryCandidates = [],
  macroDataDriver,
  macroCandidates,
  macroOrigin,
  onOpenMacroEditor,
  onChange
}: {
  editorIdentity?: string;
  snl: string;
  entryCandidates?: readonly EntryOption[];
  macroDataDriver: MacroDataDriver;
  macroCandidates: readonly SnooglSearchCandidate[];
  macroOrigin: Record<string, string>;
  onOpenMacroEditor: (req: MacroOpenRequest) => void;
  onChange: (nextSnl: string) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const [tree, setTree] = useState<SnlSyntaxTree>(() => {
    const initial = parseOrDefault(snl);
    ensureTreeIdentity(initial);
    return initial;
  });
  const [parseError, setParseError] = useState<string | null>(null);
  // Collapse follows stable UI node identity, not a dotted array-index path.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const undoStackRef = useRef<SnlSyntaxTree[]>([]);
  const previousEditorIdentityRef = useRef(editorIdentity);
  if (previousEditorIdentityRef.current !== editorIdentity) {
    previousEditorIdentityRef.current = editorIdentity;
    undoStackRef.current = [];
  }

  const lastSerializedRef = useRef<string>(serializeTreePreserving(tree));

  useEffect(() => {
    if (snl === lastSerializedRef.current) return;
    const parsed = tryParseSnlSyntaxTree(snl.trim() || '_snl_stub');
    if (parsed.ok) {
      ensureTreeIdentity(parsed.tree);
      undoStackRef.current = [];
      setTree(parsed.tree);
      setParseError(null);
      lastSerializedRef.current = serializeTreePreserving(parsed.tree);
    } else {
      setParseError(parsed.error);
    }
  }, [snl]);

  const propagate = useCallback(
    (nextTree: SnlSyntaxTree, recordUndo = true): void => {
      ensureTreeIdentity(nextTree);
      setTree((previous: SnlSyntaxTree) => {
        if (recordUndo && nextTree !== previous) {
          undoStackRef.current.push(previous);
          if (undoStackRef.current.length > 100) undoStackRef.current.shift();
        }
        return nextTree;
      });
      // Unfilled `+ child` rows now survive serialization: `foo(a,)` and
      // `foo(,b)` are valid SNL that round trips (cat 2026-07-25), so the
      // Inductive and Canvas editors agree on what a half-finished tree
      // means. Only the one unserializable shape is pruned — see
      // `stripEmptyPlaceholders`.
      const pruned = stripEmptyPlaceholders(nextTree);
      const nextSnl = serializeTreePreserving(pruned);
      lastSerializedRef.current = nextSnl;
      setParseError(null);
      onChange(nextSnl);
    },
    [onChange]
  );

  /**
   * Set a row's child count, addressed by path and applied against the LATEST
   * tree rather than a render-time snapshot.
   *
   * Arity auto-fill runs from an effect, so every unfilled sibling fires in
   * the same commit. Routing those writes through `onChange({...node})` made
   * each sibling overwrite the previous one's result — only the last sibling
   * kept its slots. A functional, path-addressed update composes instead.
   * Review 2026-07-25.
   */
  const setRowArity = useCallback(
    (path: string, count: number): void => {
      setTree((previous) => {
        const next = withArityAtPath(previous, path, count);
        if (next === previous) return previous;
        undoStackRef.current.push(previous);
        if (undoStackRef.current.length > 100) undoStackRef.current.shift();
        ensureTreeIdentity(next);
        const nextSnl = serializeTreePreserving(stripEmptyPlaceholders(next));
        lastSerializedRef.current = nextSnl;
        onChange(nextSnl);
        return next;
      });
    },
    [onChange]
  );

  // Path-based tree operations (cat 2026-07-15): add parent/sibling, indent,
  // outdent. Implemented as single top-level transforms so cross-node
  // rearrangements (indent/outdent) don't need to chain multiple
  // stale-state onChange calls up the tree. Path is the same dotted
  // form used by `collapsed` — '' for root, '0', '0.1', etc.
  const treeOp = useCallback(
    (
      op: 'wrapParent' | 'addSibling' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
      path: string,
      furthest = false
    ): void => {
      const next = furthest ? applyTreeOpFurthest(tree, op, path) : applyTreeOp(tree, op, path);
      if (next !== tree) propagate(next);
    },
    [tree, propagate]
  );

  const toggleCollapsed = useCallback((nodeId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const runShortcutAction = useCallback((action: string): void => {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest<HTMLElement>('[data-snl-tree-node-id]');
    if (!row || !editorRootRef.current?.contains(row)) return;
    const nodeId = row.dataset.snlTreeNodeId ?? '';
    const path = row.dataset.snlTreePath ?? '';
    if (action === 'inductive.undo') {
      const previous = undoStackRef.current.pop();
      if (previous) propagate(previous, false);
      return;
    }
    if (action === 'inductive.openStyle') {
      if (active?.matches('.snl-tree-style-select')) {
        const editors = Array.from<HTMLElement>(
          editorRootRef.current.querySelectorAll<HTMLElement>('[data-snl-macro-input]')
        );
        const current = row.querySelector<HTMLElement>('[data-snl-macro-input]');
        const next = current ? editors[editors.indexOf(current) + 1] : undefined;
        next?.focus();
        return;
      }
      const style = row.querySelector<HTMLSelectElement>('.snl-tree-style-select:not(:disabled)');
      if (style) style.focus();
      else {
        const editors = Array.from<HTMLElement>(
          editorRootRef.current.querySelectorAll<HTMLElement>('[data-snl-macro-input]')
        );
        const current = row.querySelector<HTMLElement>('[data-snl-macro-input]');
        const next = current ? editors[editors.indexOf(current) + 1] : undefined;
        next?.focus();
      }
      return;
    }
    if (action === 'inductive.nextNode') {
      const editors = Array.from<HTMLElement>(
        editorRootRef.current.querySelectorAll<HTMLElement>('[data-snl-macro-input]')
      );
      const current = active?.matches('[data-snl-macro-input]')
        ? active
        : row.querySelector<HTMLElement>('[data-snl-macro-input]');
      const next = current ? editors[editors.indexOf(current) + 1] : undefined;
      next?.focus();
      return;
    }
    if (action === 'inductive.extractSelection') {
      const input = active?.matches('[data-snl-macro-input]')
        ? active as HTMLInputElement
        : row.querySelector<HTMLInputElement>('[data-snl-macro-input]');
      if (!input) return;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      const current = getNodeAtPath(tree, path);
      if (!current) return;
      const extracted = extractInductiveSelection(current, input.value, start, end);
      if (extracted) propagate(transformAtPath(tree, path, () => extracted));
      return;
    }
    const op = action === 'inductive.moveUp' ? 'moveUp'
      : action === 'inductive.moveDown' ? 'moveDown'
        : action === 'inductive.outdent' ? 'outdent'
          : action === 'inductive.indent' ? 'indent'
            : null;
    if (!op) return;
    treeOp(op, path);
    requestAnimationFrame(() => {
      const rows = editorRootRef.current?.querySelectorAll<HTMLElement>('[data-snl-tree-node-id]');
      const moved = rows
        ? Array.from(rows as NodeListOf<HTMLElement>).find(
            (candidate: HTMLElement) => candidate.dataset.snlTreeNodeId === nodeId
          )
        : undefined;
      moved?.querySelector<HTMLElement>('[data-snl-macro-input]')?.focus();
    });
  }, [treeOp, tree, propagate]);

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as { type?: string; action?: string } | undefined;
      if (message?.type === 'shortcutAction' && typeof message.action === 'string') {
        runShortcutAction(message.action);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [runShortcutAction]);

  useEffect(() => {
    return () => {
      getVsCodeApi()?.postMessage({ type: 'shortcutContext', inductiveInputFocus: false });
    };
  }, []);

  return (
    <div
      ref={editorRootRef}
      className="snl-inductive-editor"
      onFocusCapture={(event: React.FocusEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        getVsCodeApi()?.postMessage({
          type: 'shortcutContext',
          inductiveInputFocus: target.matches('[data-snl-macro-input], .snl-tree-style-select')
        });
      }}
      onBlurCapture={(event: React.FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget as HTMLElement | null;
        getVsCodeApi()?.postMessage({
          type: 'shortcutContext',
          inductiveInputFocus: Boolean(
            next &&
            event.currentTarget.contains(next) &&
            next.matches('[data-snl-macro-input], .snl-tree-style-select')
          )
        });
      }}
      style={{
        border:
          '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
        borderRadius: '3px',
        padding: '0.4rem 0.3rem',
        background: 'var(--vscode-editorWidget-background, #252526)'
      }}
    >
      {/* Pure-CSS hover/focus reveal for the per-row toolbar. The row reserves
          the toolbar's width only while it is visible, so the flexible Macro
          input contracts instead of letting the actions spill outside. */}
      <style>{`
        .snl-inductive-editor {
          container-name: snl-inductive;
          container-type: inline-size;
        }
        .snl-tree-row-toolbar {
          position: absolute;
          right: 0.3rem;
          top: 50%;
          transform: translateY(-50%);
          opacity: 0;
          pointer-events: none;
          transition: opacity 90ms ease-in;
        }
        .snl-tree-row {
          padding-block: 0.15rem;
          padding-right: 0.3rem;
          transition: padding-right 90ms ease-in, padding-bottom 90ms ease-in;
        }
        .snl-tree-row:hover .snl-tree-row-toolbar,
        .snl-tree-row:focus-within .snl-tree-row-toolbar {
          opacity: 1;
          pointer-events: auto;
        }
        .snl-tree-row:hover,
        .snl-tree-row:focus-within {
          padding-right: 8.4rem;
        }
        @container snl-inductive (max-width: 30rem) {
          .snl-tree-row {
            flex-wrap: wrap;
            align-items: flex-start;
          }
          .snl-tree-row > [data-macro-id-control='true'] {
            flex: 1 1 9rem !important;
            width: auto !important;
            min-width: 0 !important;
          }
          .snl-tree-context-entry-control {
            flex: 1 1 9rem !important;
            min-width: 5rem !important;
          }
          .snl-tree-style-select {
            flex: 0 1 7rem !important;
          }
          .snl-tree-row:hover,
          .snl-tree-row:focus-within {
            padding-right: 0.3rem;
            padding-bottom: 4.9rem;
          }
          .snl-tree-row-toolbar {
            top: auto;
            bottom: 0.15rem;
            transform: none;
          }
          .snl-tree-row:has(.snl-tree-add-menu) {
            padding-bottom: 0.3rem;
          }
          .snl-tree-row:has(.snl-tree-add-menu) .snl-tree-row-toolbar {
            position: static;
            flex: 1 0 100%;
            margin-left: auto;
            justify-content: flex-end;
          }
        }
        @media (hover: none), (pointer: coarse) {
          .snl-tree-row {
            flex-wrap: wrap;
            align-items: flex-start;
            padding-right: 0.3rem;
            padding-bottom: 4.9rem;
          }
          .snl-tree-row-toolbar {
            top: auto;
            bottom: 0.15rem;
            transform: none;
            opacity: 1;
            pointer-events: auto;
          }
          .snl-tree-row:has(.snl-tree-add-menu) {
            padding-bottom: 0.3rem;
          }
          .snl-tree-row:has(.snl-tree-add-menu) .snl-tree-row-toolbar {
            position: static;
            flex: 1 0 100%;
            margin-left: auto;
            justify-content: flex-end;
          }
        }
      `}</style>

      {parseError ? (
        <div
          style={{
            margin: '0 0.3rem 0.4rem',
            padding: '0.3rem 0.5rem',
            background: 'rgba(220, 60, 60, 0.12)',
            border: '1px solid rgba(220, 60, 60, 0.55)',
            color: 'var(--vscode-errorForeground, #f48771)',
            borderRadius: '3px',
            fontSize: '0.78rem'
          }}
        >
          {t('unparseableSnl', { error: parseError })}
        </div>
      ) : null}

      <InductiveNode
        node={tree}
        path=""
        numberPath=""
        depth={0}
        siblingCount={1 /* root has no siblings; move-up/down guarded by path==='' */}
        onChange={propagate}
        onDelete={undefined /* root cannot be deleted */}
        macroDataDriver={macroDataDriver}
        entryCandidates={entryCandidates}
        macroCandidates={macroCandidates}
        macroOrigin={macroOrigin}
        onOpenMacroEditor={onOpenMacroEditor}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        treeOp={treeOp}
        setRowArity={setRowArity}
      />
      <p
        style={{
          margin: '0.4rem 0.3rem 0',
          fontSize: '0.72rem',
          opacity: 0.55,
          fontStyle: 'italic'
        }}
      >
        {t('inductiveHelp')}
      </p>
    </div>
  );
}

/** Best-effort parse: returns a stub root when the text is empty / invalid. */
function parseOrDefault(text: string): SnlSyntaxTree {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return createSnlSyntaxTreeNode('_snl_stub');
  }
  const parsed = tryParseSnlSyntaxTree(trimmed);
  return parsed.ok ? parsed.tree : createSnlSyntaxTreeNode('_snl_stub');
}

/**
 * Serialize a tree back to SNL source, preserving the surface syntax that
 * `serializeSnlSyntaxTree` from @sjtu-ai4math/snl-basics drops on the floor.
 *
 * The library's serializer emits `name(children)` verbatim — it ignores
 * `env_mode`, `style`, and `kind='binder'`. That's fine when the tree came
 * from a parser that stripped delimiters into the payload, but for us it's
 * catastrophic: a leaf `{name:'foo', env_mode:'text'}` (which the user typed
 * as `%foo%`) round-trips as bare `foo`, and the parser rejects it on the
 * next reparse. Cat 2026-07-12: "GUI Editor 改完会把 % 等语法元素吃掉".
 *
 * Fix: use `stringifyLeafSource` for the head at every level so `%…%` /
 * `$…$` / `$$…$$` / `@` / `[style]` all survive. Children still recurse.
 */
export function serializeTreePreserving(node: SnlSyntaxTree): string {
  const head = stringifyLeafSource(node);
  const childrenPart =
    node.children.length > 0
      ? `(${node.children.map(serializeTreePreserving).join(',')})`
      : '';
  return `${head}${childrenPart}`;
}

/**
 * Drop empty placeholder rows that cannot be serialized.
 *
 * Cat 2026-07-25: an empty row is now a real SNL empty node — `foo(a,)` and
 * `foo(,b)` parse fine and round trip — so unfilled slots are KEPT, matching
 * what the Canvas editor does. Switching between the two editors must not
 * silently drop the author's slots.
 *
 * The one exception is a lone empty child (`foo(<empty>)`), which would
 * serialize to `foo()` and reparse as ZERO arguments, losing the slot. That
 * single shape is still pruned so the text stays readable-back.
 */
export function stripEmptyPlaceholders(node: SnlSyntaxTree): SnlSyntaxTree {
  const kids = node.children.map(stripEmptyPlaceholders);
  const isEmptyRow = (child: SnlSyntaxTree): boolean =>
    child.macro_name.trim() === '' && child.children.length === 0;
  if (kids.length === 1 && isEmptyRow(kids[0])) {
    return { ...node, children: [] };
  }
  return { ...node, children: kids };
}

/**
 * Structural tree operations invoked from row-side buttons (cat
 * 2026-07-15). All three are pure — they return a new tree and never
 * mutate. Path is the dotted form used elsewhere ('', '0', '0.1', ...).
 *
 *   - wrapParent: insert an empty parent above the row at `path`. The
 *     original row becomes the sole child of the new parent. Root can
 *     be wrapped (result: the whole tree becomes the new root's only
 *     child).
 *   - indent: turn the row at `path` into a child of its immediate
 *     preceding sibling. No-op if the row has no preceding sibling
 *     (first child) or if `path` is root.
 *   - outdent: promote the row at `path` up one level, inserted right
 *     after its former parent among the grandparent's children. No-op
 *     for root or for direct children of root (nothing to outdent to).
 *
 * Returns the same object when the op is a no-op, so treeOp can bail
 * without triggering a needless propagate.
 */
/**
 * Return `tree` with the node at `path` padded to `count` children.
 *
 * Grows with empty rows and shrinks only while the surplus is entirely
 * empty — the same contract the arity effect used to apply in place, but
 * expressed as a pure transform so concurrent sibling updates compose
 * instead of overwriting each other. Returns the SAME tree when nothing
 * changes, so callers keep their no-op semantics.
 */
export function withArityAtPath(
  tree: SnlSyntaxTree,
  path: string,
  count: number
): SnlSyntaxTree {
  const steps = path === '' ? [] : path.split('.').map(Number);
  const isEmptyRow = (child: SnlSyntaxTree): boolean =>
    child.macro_name.trim() === '' && child.children.length === 0;

  const walk = (node: SnlSyntaxTree, depth: number): SnlSyntaxTree => {
    if (depth === steps.length) {
      if (count > node.children.length) {
        return {
          ...node,
          children: [
            ...node.children,
            ...Array.from(
              { length: count - node.children.length },
              () => createSnlSyntaxTreeNode('')
            )
          ]
        };
      }
      const surplus = node.children.slice(count);
      if (surplus.length === 0 || !surplus.every(isEmptyRow)) return node;
      return { ...node, children: node.children.slice(0, count) };
    }
    const index = steps[depth];
    const child = node.children[index];
    if (!child) return node;
    const nextChild = walk(child, depth + 1);
    if (nextChild === child) return node;
    const children = node.children.slice();
    children[index] = nextChild;
    return { ...node, children };
  };

  return walk(tree, 0);
}

export function extractInductiveSelection(
  node: SnlSyntaxTree,
  surface: string,
  start: number,
  end: number
): SnlSyntaxTree | null {
  if (start < 0 || end <= start || end > surface.length) return null;
  const selected = surface.slice(start, end);
  const binderPrefix = surface.startsWith('@') ? '@' : '';
  const headSurface = binderPrefix ? surface.slice(1) : surface;
  const delimiter = headSurface.startsWith('$$') && headSurface.endsWith('$$') ? '$$'
    : headSurface.startsWith('$') && headSurface.endsWith('$') ? '$'
      : headSurface.startsWith('%') && headSurface.endsWith('%') ? '%'
        : '';
  const bodyStart = binderPrefix.length + delimiter.length;
  const bodyEnd = delimiter ? surface.length - delimiter.length : surface.length;
  if (start < bodyStart || end > bodyEnd) return null;
  const body = surface.slice(bodyStart, bodyEnd);
  let max = node.children.length - 1;
  const placeholder = /(?<!\\)#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = placeholder.exec(body)) !== null) max = Math.max(max, Number(match[1]));
  const nextIndex = max + 1;
  const relativeStart = start - bodyStart;
  const relativeEnd = end - bodyStart;
  const nextBody = `${body.slice(0, relativeStart)}#${nextIndex}${body.slice(relativeEnd)}`;
  const nextHead = `${binderPrefix}${delimiter ? `${delimiter}${nextBody}${delimiter}` : nextBody}`;
  const childSurface = delimiter ? `${delimiter}${selected}${delimiter}` : selected;
  const nextParsed = tryParseSnlSyntaxTree(nextHead);
  const childParsed = tryParseSnlSyntaxTree(childSurface);
  if (!nextParsed.ok || !childParsed.ok) return null;
  inheritTreeIdentity(node, nextParsed.tree);
  ensureTreeIdentity(childParsed.tree);
  return {
    ...nextParsed.tree,
    style_name: node.style_name,
    mdata: node.mdata,
    children: [...node.children, childParsed.tree]
  };
}

function applyTreeOp(
  tree: SnlSyntaxTree,
  op: 'wrapParent' | 'addSibling' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
  path: string
): SnlSyntaxTree {
  if (op === 'wrapParent') {
    if (path === '') {
      // Wrap the whole root inside a new empty parent.
      return { ...createSnlSyntaxTreeNode(''), children: [tree] };
    }
    return transformAtPath(tree, path, (row) => ({
      ...createSnlSyntaxTreeNode(''),
      children: [row]
    }));
  }
  const parts = path.split('.').filter((s) => s.length > 0);
  if (parts.length === 0) return tree;
  const idx = Number(parts[parts.length - 1]);
  const parentPath = parts.slice(0, -1).join('.');
  if (op === 'addSibling') {
    return transformChildrenAtPath(tree, parentPath, (kids) => {
      const nextKids = kids.slice();
      nextKids.splice(idx + 1, 0, createSnlSyntaxTreeNode(''));
      return nextKids;
    });
  }
  if (op === 'indent') {
    if (idx === 0) return tree; // no preceding sibling
    return transformChildrenAtPath(tree, parentPath, (kids) => {
      const moving = kids[idx];
      const prev = kids[idx - 1];
      const nextKids = kids.slice();
      nextKids.splice(idx, 1);
      nextKids[idx - 1] = { ...prev, children: [...prev.children, moving] };
      return nextKids;
    });
  }
  if (op === 'moveUp' || op === 'moveDown') {
    // Sibling reorder among the same parent's children (cat 2026-07-15).
    // No-op at the edge (first row can't move up; last row can't move down).
    return transformChildrenAtPath(tree, parentPath, (kids) => {
      const swapWith = op === 'moveUp' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= kids.length) return kids;
      const nextKids = kids.slice();
      [nextKids[idx], nextKids[swapWith]] = [nextKids[swapWith], nextKids[idx]];
      return nextKids;
    });
  }
  // outdent: needs a grandparent (parentPath must be non-root).
  if (op === 'outdent') {
    if (parentPath === '') return tree;
    const parentParts = parentPath.split('.').filter((s) => s.length > 0);
    const parentIdx = Number(parentParts[parentParts.length - 1]);
    const grandpaPath = parentParts.slice(0, -1).join('.');
    // Snapshot the moving row BEFORE mutating the parent's children,
    // otherwise the closure reads a stale reference.
    const parentNode = getNodeAtPath(tree, parentPath);
    if (!parentNode) return tree;
    const moving = parentNode.children[idx];
    if (!moving) return tree;
    // Two-step: (1) remove `moving` from parent; (2) insert it after
    // parent in grandpa. Do both in a single transformChildrenAtPath on
    // the grandpa — build a fresh parent shorn of `moving`, then insert
    // `moving` right after it.
    return transformChildrenAtPath(tree, grandpaPath, (kids) => {
      const oldParent = kids[parentIdx];
      const newParent = {
        ...oldParent,
        children: oldParent.children.filter((_, j) => j !== idx)
      };
      const nextKids = kids.slice();
      nextKids[parentIdx] = newParent;
      nextKids.splice(parentIdx + 1, 0, moving);
      return nextKids;
    });
  }
  return tree;
}

function findNodePath(tree: SnlSyntaxTree, target: SnlSyntaxTree): string | undefined {
  if (tree === target) return '';
  for (let index = 0; index < tree.children.length; index += 1) {
    const childPath = findNodePath(tree.children[index], target);
    if (childPath !== undefined) return childPath === '' ? String(index) : `${index}.${childPath}`;
  }
  return undefined;
}

function applyTreeOpFurthest(
  tree: SnlSyntaxTree,
  op: 'indent' | 'outdent' | 'moveUp' | 'moveDown' | 'wrapParent' | 'addSibling',
  path: string
): SnlSyntaxTree {
  if (op === 'wrapParent' || op === 'addSibling') return applyTreeOp(tree, op, path);
  const target = getNodeAtPath(tree, path);
  if (!target) return tree;
  let current = tree;
  let currentPath = path;
  while (true) {
    const next = applyTreeOp(current, op, currentPath);
    if (next === current) return current;
    const nextPath = findNodePath(next, target);
    if (nextPath === undefined || nextPath === currentPath) return current;
    current = next;
    currentPath = nextPath;
  }
}

function transformAtPath(
  tree: SnlSyntaxTree,
  path: string,
  fn: (n: SnlSyntaxTree) => SnlSyntaxTree
): SnlSyntaxTree {
  if (path === '') return fn(tree);
  const parts = path.split('.').filter((s) => s.length > 0);
  const [head, ...rest] = parts;
  const idx = Number(head);
  if (!Number.isInteger(idx) || idx < 0 || idx >= tree.children.length) {
    return tree;
  }
  const nextChild = transformAtPath(tree.children[idx], rest.join('.'), fn);
  if (nextChild === tree.children[idx]) return tree;
  const nextChildren = tree.children.slice();
  nextChildren[idx] = nextChild;
  return { ...tree, children: nextChildren };
}

function transformChildrenAtPath(
  tree: SnlSyntaxTree,
  path: string,
  fn: (kids: SnlSyntaxTree[]) => SnlSyntaxTree[]
): SnlSyntaxTree {
  return transformAtPath(tree, path, (n) => ({ ...n, children: fn(n.children) }));
}

function getNodeAtPath(
  tree: SnlSyntaxTree,
  path: string
): SnlSyntaxTree | undefined {
  if (path === '') return tree;
  const parts = path.split('.').filter((s) => s.length > 0);
  let cur: SnlSyntaxTree | undefined = tree;
  for (const p of parts) {
    const i = Number(p);
    if (!cur || !Number.isInteger(i) || i < 0 || i >= cur.children.length) {
      return undefined;
    }
    cur = cur.children[i];
  }
  return cur;
}

/**
 * One row in the inductive editor. See the file-level block comment above
 * `GuiInductiveEditor` for the layout / interaction contract.
 */
function InductiveNode({
  node,
  path,
  numberPath,
  depth,
  siblingCount,
  onChange,
  onDelete,
  macroDataDriver,
  entryCandidates,
  macroCandidates,
  macroOrigin,
  onOpenMacroEditor,
  collapsed,
  onToggleCollapsed,
  treeOp,
  setRowArity
}: {
  node: SnlSyntaxTree;
  /** Dotted path from root; root = "", children = "0", "0.1", ... */
  path: string;
  /** Zero-based visible number, e.g. "0", "1.0", "1.0.1" (root = ""). */
  numberPath: string;
  depth: number;
  /**
   * Number of children the parent has (i.e. this row's sibling group
   * size, including self). Root is passed 1. Used to disable ↓ move-down
   * at the last row without a second tree lookup. Cat 2026-07-15.
   */
  siblingCount: number;
  onChange: (next: SnlSyntaxTree) => void;
  /** Undefined for the root row. */
  onDelete: (() => void) | undefined;
  macroDataDriver: MacroDataDriver;
  entryCandidates: readonly EntryOption[];
  macroCandidates: readonly SnooglSearchCandidate[];
  macroOrigin: Record<string, string>;
  onOpenMacroEditor: (req: MacroOpenRequest) => void;
  collapsed: Set<string>;
  onToggleCollapsed: (nodeId: string) => void;
  /**
   * Path-based structural ops routed to the top-level GuiInductiveEditor
   * (cat 2026-07-15). Row-side buttons '+ parent', '⇥ indent', '⇤ outdent',
   * '↑ move up', '↓ move down' all dispatch through here so cross-node
   * rearrangements don't need multi-level onChange chaining.
   */
  setRowArity: (path: string, count: number) => void;
  treeOp: (
    op: 'wrapParent' | 'addSibling' | 'indent' | 'outdent' | 'moveUp' | 'moveDown',
    path: string,
    furthest?: boolean
  ) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  const nodeId = treeIdentity(node);
  const [rawInput, setRawInput] = React.useState<string>(() =>
    stringifyLeafHead(node)
  );
  const [contextInputOpen, setContextInputOpen] = React.useState(
    () => readContextEntryId(node) !== undefined
  );
  const contextDraftOpenRef = React.useRef(false);
  const contextAutoFocusRequestedRef = React.useRef(false);
  const previousNodeIdRef = React.useRef(nodeId);

  React.useEffect(() => {
    if (contextInputOpen) contextAutoFocusRequestedRef.current = false;
  }, [contextInputOpen]);


  // Sync from external changes (e.g. text mode edit → re-parse → new tree).
  // Only reset if the incoming node's stringified form differs from what we
  // last showed, so mid-typing user edits aren't clobbered.
  React.useEffect(() => {
    const canonical = stringifyLeafHead(node);
    setRawInput((prev) => (prev.trim() === canonical.trim() ? prev : canonical));
    const contextEntryId = readContextEntryId(node);
    const externalNodeReplacement = previousNodeIdRef.current !== nodeId;
    previousNodeIdRef.current = nodeId;
    if (externalNodeReplacement) {
      contextDraftOpenRef.current = false;
      setContextInputOpen(contextEntryId !== undefined);
    } else if (contextEntryId !== undefined) {
      contextDraftOpenRef.current = false;
      setContextInputOpen(true);
    } else if (!contextDraftOpenRef.current) {
      setContextInputOpen(false);
    }
  }, [nodeId, node.macro_name, node.env_mode, node.kind, node.style_name, node.mdata]);

  const commitRaw = (nextRaw: string): void => {
    const leaf = parseLeafSource(nextRaw);
    const contextSurface = splitContextEntrySurface(leaf.macro_name);
    const typedContext = contextSurface?.contextEntryId;
    const nextMacroName = contextSurface?.macroSurface ?? leaf.macro_name;
    if (contextSurface) {
      contextDraftOpenRef.current = typedContext === '';
      contextAutoFocusRequestedRef.current = true;
      setContextInputOpen(true);
    }
    // Bracket syntax and an `@entry` suffix belong to their independent
    // channels, never to the Macro identity field.
    setRawInput(nextMacroName);
    onChange({
      ...node,
      macro_name: nextMacroName,
      // Cat 2026-07-15: the GUI editor no longer manages sigils. Any
      // user edit collapses the node's parsed env_mode/kind meta into
      // whatever literal chars are now in `name`, so backspacing a
      // sigil actually deletes it (previously `kind: leaf.kind ||
      // node.kind` re-latched the old `binder` and the `@` came back).
      env_mode: undefined,
      kind: '',
      binder_explicit: undefined,
      scope: undefined,
      // Macro text owns identity/env syntax only. Style is changed exclusively
      // by the adjacent dropdown, so typing/pasting `id[style]` cannot mutate it.
      style_name: node.style_name,
      mdata: withoutBindingMetadata(
        typedContext !== undefined
          ? withContextEntryId(node, typedContext)
          : node.mdata
      ),
      children: node.children
    });
  };


  const addChild = (): void => {
    // New child inherits nothing — empty leaf. Expand the parent so the new
    // child is visible immediately.
    if (collapsed.has(nodeId)) onToggleCollapsed(nodeId);
    onChange({
      ...node,
      children: [...node.children, createSnlSyntaxTreeNode('')]
    });
  };
  const updateChild = (i: number, next: SnlSyntaxTree): void => {
    const nextChildren = node.children.slice();
    nextChildren[i] = next;
    onChange({ ...node, children: nextChildren });
  };
  const deleteChild = (i: number): void => {
    const nextChildren = node.children.filter((_, idx) => idx !== i);
    onChange({ ...node, children: nextChildren });
  };

  const hasKids = node.children.length > 0;
  const isCollapsed = collapsed.has(nodeId);
  const macroEntry = useQueriedMacro(macroDataDriver, node.macro_name);
  /**
   * The Macro whose arity has already been reconciled for this row, so
   * reclaiming surplus slots happens once per Macro change rather than on
   * every render — otherwise `+ child` would be undone as fast as it is
   * clicked.
   */
  const reconciledMacroRef = useRef<string | null>(null);
  const effectiveKind = resolveRowKind(node, macroEntry);
  const palette = paletteFor(effectiveKind);
  const macroMatched = Boolean(macroEntry) || node.env_mode !== undefined;

  /**
   * Open the child rows a fixed-arity Macro requires, as soon as the row
   * actually resolves to one.
   *
   * This used to live in `commitRaw`, which made it dead in the common case:
   * `useQueriedMacro` is keyed on `node.macro_name`, so at the moment the
   * author finishes typing `pair` the lookup for `pair` has not run yet —
   * `macroEntry` still holds the PREVIOUS name's result, the
   * `leaf.macro_name === node.macro_name` guard fails, and no slots appear.
   * It only ever fired when re-committing an already-resolved name.
   *
   * Reacting to the resolved macro instead fires exactly once, when the
   * answer arrives. Cat 2026-07-25.
   */
  useEffect(() => {
    // `useQueriedMacro` binds each result to its driver + name, so a defined
    // `macroEntry` always describes the current row even before effects run.
    if (!macroEntry || macroEntry.dynamic_arity === true) return;
    const requiredArity = macroTemplateArity(macroEntry);
    if (requiredArity > node.children.length) {
      setRowArity(path, requiredArity);
      // Expand the row so the new slots are visible immediately — otherwise
      // the author just sees the frame border change color with no other cue.
      if (collapsed.has(nodeId)) onToggleCollapsed(nodeId);
      return;
    }
    // Retyping one Macro over another leaves the previous Macro's slots
    // behind (`pair` opens two, then `atom` needs none and the row would
    // serialize as `atom(,)`). Reclaim that surplus — but only on the edit
    // that actually changed the Macro, and only while the surplus is
    // entirely empty.
    //
    // Both conditions matter. Without the first, `+ child` on a fixed-arity
    // row is undone the instant the author clicks it and the button looks
    // broken; without the second, work the author already typed would be
    // silently deleted. Review 2026-07-25.
    if (reconciledMacroRef.current === macroEntry.name) return;
    reconciledMacroRef.current = macroEntry.name;
    if (node.children.length > requiredArity) setRowArity(path, requiredArity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macroEntry, node.macro_name, node.children.length]);

  // Frame: kind palette when the row resolved to a pool macro (or an
  // env_mode leaf); default gray when the name doesn't match anything.
  // fvar-kind macros DO get the palette's fvar color (red) — that's the
  // author's declared kind, so it's what we surface. If a macro looks red
  // and shouldn't, fix its `kind` in .SNL_Doc/term_macros/*.json.
  const frameBorder = macroMatched
    ? palette.stroke
    : 'var(--vscode-input-border, var(--vscode-contrastBorder, #555))';
  const frameBackground = macroMatched
    ? kindBackgroundTint(palette.background)
    : 'var(--vscode-input-background, #2a2a2a)';

  // Style is a separate dropdown channel; MacroIdInput owns identity only.
  const contextEntryId = readContextEntryId(node) ?? '';
  const styleTags = (macroEntry?.styles ?? [])
    .map((style) => style.style_name)
    .filter((style): style is string => Boolean(style));
  const defaultStyleTag = styleTags[0] ?? '';
  const styleAvailable = styleTags.length > 0;
  const styleIsExplicit = node.style_name !== undefined && node.style_name !== '';
  const styleDisplay = styleIsExplicit ? node.style_name! : defaultStyleTag;
  const styleUsesDefault = styleAvailable && styleDisplay === defaultStyleTag;
  const explicitStyleMissing =
    styleIsExplicit && !styleTags.includes(node.style_name!);
  const styleSelectable = styleAvailable || explicitStyleMissing;

  const commitStyle = (nextValue: string): void => {
    const trimmed = nextValue.trim();
    // Empty or default → implicit (drop the field so serialization stays
    // as `foo(…)` rather than `foo[default](…)`).
    const nextStyle =
      trimmed === '' || trimmed === defaultStyleTag ? undefined : trimmed;
    onChange({ ...node, style_name: nextStyle });
  };

  const pathParts = path.split('.').filter((part) => part.length > 0);
  const siblingIndex = pathParts.length > 0 ? Number(pathParts[pathParts.length - 1]) : -1;
  const canIndent = pathParts.length > 0 && siblingIndex > 0;
  const canOutdent = pathParts.length >= 2;
  const canMoveUp = pathParts.length > 0 && siblingIndex > 0;
  const canMoveDown = pathParts.length > 0 && siblingIndex < siblingCount - 1;
  const trimmedMacroName = node.macro_name.trim();
  const macroKnown = trimmedMacroName !== '' && Boolean(macroOrigin[trimmedMacroName]);
  const macroActionTitle = macroKnown
    ? t('openEditMacro', { name: trimmedMacroName, origin: macroOrigin[trimmedMacroName] })
    : node.env_mode === 'text'
      ? t('openCreateMacroText', { name: trimmedMacroName })
      : node.env_mode === 'formula_inline'
        ? t('openCreateMacroInline', { name: trimmedMacroName })
        : node.env_mode === 'formula_display'
          ? t('openCreateMacroDisplay', { name: trimmedMacroName })
          : trimmedMacroName === ''
            ? t('openCreateMacroBlank')
            : t('openCreateMacroPrefill', { name: trimmedMacroName });

  const restoreDashboardFocus = (): void => {
    window.requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-snl-tree-node-id]'))
        .find((candidate) => candidate.dataset.snlTreeNodeId === nodeId);
      row?.querySelector<HTMLButtonElement>('[data-snl-add-position-trigger]')?.focus();
    });
  };

  const handleDashboardAction = (command: TreeNodeActionCommand): void => {
    const furthest = 'toEdge' in command && command.toEdge;
    switch (command.kind) {
      case 'moveUp': treeOp('moveUp', path, furthest); break;
      case 'moveDown': treeOp('moveDown', path, furthest); break;
      case 'outdent': treeOp('outdent', path, furthest); break;
      case 'indent': treeOp('indent', path, furthest); break;
      case 'addParent': treeOp('wrapParent', path); restoreDashboardFocus(); break;
      case 'addChild': addChild(); restoreDashboardFocus(); break;
      case 'addSibling':
        if (path !== '') treeOp('addSibling', path);
        restoreDashboardFocus();
        break;
      case 'delete': onDelete?.(); break;
    }
  };

  return (
    <div>
      <div
        className="snl-tree-row"
        data-snl-tree-node-id={nodeId}
        data-snl-tree-path={path}
        style={{
          display: 'flex',
          position: 'relative',
          overflow: 'visible',
          alignItems: 'center',
          gap: '0.35rem',
          paddingLeft: `${0.3 + depth * 1.1}rem`,
          // Very subtle depth-tint so nested rows visually anchor.
          background:
            depth === 0
              ? 'transparent'
              : `rgba(255,255,255,${Math.min(0.015 * depth, 0.08)})`
        }}
      >
        {/* Chevron toggle OR spacer, so numbers/inputs line up regardless. */}
        {hasKids ? (
          <Button
            type="button"
            onClick={() => onToggleCollapsed(nodeId)}
            style={chevronButtonStyle}
            aria-label={isCollapsed ? t('expandNode') : t('collapseNode')}
            title={isCollapsed ? t('expandNode') : t('collapseNode')}
          >
            {isCollapsed ? '▶' : '▼'}
          </Button>
        ) : (
          <span
            style={{ width: '1.1rem', flexShrink: 0, display: 'inline-block' }}
          />
        )}

        {/* Full zero-based number path (e.g. #1.0.2). Root shows nothing so the input
            starts flush. Width scales with depth so indent visually
            correlates with number length. */}
        <span
          data-snl-node-number
          style={{
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.9rem',
            color: 'var(--vscode-descriptionForeground, #888)',
            minWidth: numberPath ? `${Math.max(2, numberPath.length + 1)}ch` : 0,
            flexShrink: 0
          }}
        >
          {numberPath ? `#${numberPath}` : ''}
        </span>

        {/* Name input — dark-mode uniform styling + kind-colored frame. */}
        <MacroIdInput
          data-snl-macro-input
          value={rawInput}
          macroCandidates={macroCandidates}
          onChange={commitRaw}
          placeholder={depth === 0 ? t('rootMacroPlaceholder') : t('leafPlaceholder')}
          spellCheck={false}
          style={{
            ...inputStyle,
            flex: '1 1 auto',
            minWidth: 0,
            padding: '0.25rem 0.5rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '1rem',
            borderColor: frameBorder,
            background: frameBackground,
            color: 'var(--vscode-input-foreground, #ddd)'
          }}
          title={
            macroMatched
              ? t('kindTooltip', { kind: effectiveKind, source: macroEntry ? '' : t('envModeSource') })
              : t('macroNotFound')
          }
        />

        {contextInputOpen ? (
          <div
            className="snl-tree-context-entry-control"
            onKeyDownCapture={(event) => {
              if (
                contextEntryId.trim() === '' &&
                (event.key === 'Enter' || event.key === 'Escape')
              ) {
                event.preventDefault();
                event.stopPropagation();
                contextDraftOpenRef.current = false;
                setContextInputOpen(false);
                onChange({ ...node, mdata: withContextEntryId(node, '') });
              }
            }}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && event.currentTarget.contains(next)) return;
              if (contextEntryId.trim() === '') {
                contextDraftOpenRef.current = false;
                setContextInputOpen(false);
                onChange({ ...node, mdata: withContextEntryId(node, '') });
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.2rem',
              flex: '0 1 11rem',
              minWidth: '5rem'
            }}
          >
            <label
              htmlFor={`snl-context-entry-${nodeId}`}
              title={t('contextEntryId')}
              style={{ paddingTop: '0.3rem', fontFamily: 'monospace' }}
            >
              <span aria-hidden="true">@</span>
              <span
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: 'hidden',
                  clip: 'rect(0, 0, 0, 0)',
                  whiteSpace: 'nowrap',
                  border: 0
                }}
              >
                {t('contextEntryId')}
              </span>
            </label>
            <EntityIdSearchBox
              entries={entryCandidates}
              value={contextEntryId}
              validate={ENTRY_VALIDATE_RULES.requireMatch}
              hideResolvedChip
              autoFocus={contextAutoFocusRequestedRef.current}
              idPrefix={`snl-context-entry-${nodeId}`}
              placeholder={t('entryId')}
              onChange={(value) => {
                contextDraftOpenRef.current = value.trim() === '';
                onChange({ ...node, mdata: withContextEntryId(node, value) });
              }}
              style={{ flex: '1 1 auto', minWidth: 0 }}
              inputStyle={{
                padding: '0.25rem 0.4rem',
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                fontSize: '0.8rem'
              }}
            />
          </div>
        ) : null}

        <select
          className="snl-tree-style-select"
          value={styleDisplay}
          disabled={!styleSelectable}
          onChange={(event) => commitStyle(event.target.value)}
          aria-label={t('macroStyleFor', { name: node.macro_name || t('unresolvedMacro') })}
          title={
            explicitStyleMissing
              ? t('missingStyle', { style: node.style_name! })
              : !styleAvailable
                ? t('styleUnavailable')
                : styleIsExplicit
                  ? t('explicitStyle', { style: node.style_name! })
                  : t('implicitStyle', { style: defaultStyleTag })
          }
          style={{
            ...inputStyle,
            width: '7rem',
            minWidth: '4rem',
            flexShrink: 1,
            padding: '0.25rem 0.4rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.8rem',
            opacity: !styleSelectable ? 0.35 : 1,
            background: 'var(--vscode-dropdown-background, var(--vscode-input-background, #2a2a2a))',
            color: styleUsesDefault
              ? 'var(--vscode-descriptionForeground, #999)'
              : 'var(--vscode-dropdown-foreground, var(--vscode-input-foreground, #ddd))',
            borderColor:
              'var(--vscode-dropdown-border, var(--vscode-input-border, #555))',
            cursor: !styleSelectable ? 'not-allowed' : 'default'
          }}
        >
          {!styleAvailable ? (
            <option value="">{explicitStyleMissing ? t('clearStyle') : t('macroStyle')}</option>
          ) : null}
          {explicitStyleMissing ? (
            <option value={node.style_name}>{node.style_name} {t('missing')}</option>
          ) : null}
          {styleTags.map((style, index) => (
            <option key={style} value={style}>
              {style}{index === 0 ? ' ★' : ''}
            </option>
          ))}
        </select>

        <div
          className="snl-tree-row-toolbar"
          style={{ zIndex: 10 }}
        >
          <TreeNodeActionDashboard
            capabilities={{
              canMoveUp,
              canMoveDown,
              canIndent,
              canOutdent,
              canAddParent: true,
              canAddChild: true,
              canAddSibling: path !== '',
              canDelete: onDelete !== undefined
            }}
            leadingActions={
              <IconButton
                icon={macroKnown ? 'edit' : 'add'}
                label={macroKnown ? t('editMacro') : t('createMacro')}
                variant="ghost"
                size="sm"
                className="snl-tree-compact-action"
                onClick={() =>
                  onOpenMacroEditor({
                    name: trimmedMacroName,
                    env_mode: node.env_mode === 'block' ? undefined : node.env_mode,
                    style_name: node.style_name
                  })
                }
                title={macroActionTitle}
                style={{
                  color: macroKnown
                    ? 'var(--vscode-textLink-foreground, #4a9eff)'
                    : 'var(--vscode-descriptionForeground, #999)'
                }}
              />
            }
            onAction={handleDashboardAction}
          />
        </div>
      </div>

      {hasKids && !isCollapsed ? (
        <div>
          {node.children.map((child, i) => {
            const childPath = path === '' ? String(i) : `${path}.${i}`;
            const childNumber =
              numberPath === '' ? String(i) : `${numberPath}.${i}`;
            return (
              <InductiveNode
                key={treeIdentity(child)}
                node={child}
                path={childPath}
                numberPath={childNumber}
                depth={depth + 1}
                siblingCount={node.children.length}
                onChange={(next) => updateChild(i, next)}
                onDelete={() => deleteChild(i)}
                macroDataDriver={macroDataDriver}
                entryCandidates={entryCandidates}
                macroCandidates={macroCandidates}
                macroOrigin={macroOrigin}
                onOpenMacroEditor={onOpenMacroEditor}
                collapsed={collapsed}
                onToggleCollapsed={onToggleCollapsed}
                treeOp={treeOp}
                setRowArity={setRowArity}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Map a light-mode palette background (`#DAF0FF` etc.) to a dark-mode tint
 * that's readable behind white text. We take the kind's stroke color at ~15%
 * alpha over the panel bg — small enough to keep contrast, strong enough to
 * signal "this matches kind X".
 */
function kindBackgroundTint(lightBg: string): string {
  // Naive: use the light bg at 18% alpha over transparent. VS Code themes
  // supply their own base; the tint reads as a subtle colored wash on dark.
  const hex = /^#([0-9a-fA-F]{6})$/.exec(lightBg.trim());
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},0.18)`;
  }
  return 'var(--vscode-input-background, #2a2a2a)';
}

const chevronButtonStyle: React.CSSProperties = {
  width: '1.1rem',
  height: '1.1rem',
  padding: 0,
  fontSize: '0.65rem',
  lineHeight: 1,
  border: 'none',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground, #888)',
  cursor: 'pointer',
  flexShrink: 0
};

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  const t = useUiMessages(CREATE_ENTRY_MESSAGES);
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = t('createdStatus', { id: status.id });
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = t('updatedStatus', { id: status.id });
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = t('warningStatus', { message: status.message });
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'notFound') {
    text = t('errorStatus', { message: status.message });
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'unknownKind') {
    text = t('warningStatus', { message: status.message });
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'invalid') {
    text = t('invalidStatus', { message: status.message });
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noSnlDoc' ||
    status.kind === 'noWorkspace' ||
    status.kind === 'error'
  ) {
    text = t('errorStatus', { message: status.message });
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.4rem 0.55rem',
  marginBottom: 0,
  color: 'var(--vscode-input-foreground, #ddd)',
  background: 'var(--vscode-input-background, #2a2a2a)',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  borderRadius: '2px',
  fontFamily: 'inherit',
  fontSize: '0.95rem'
};

const monoStyle: React.CSSProperties = {
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};
