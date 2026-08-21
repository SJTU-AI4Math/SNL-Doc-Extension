// SNL Create/Edit Macro editor (v6 schema, 2026-07-04 UI overhaul).
//
// The preview renders the being-edited macro (registered under `_snl_draft`)
// applied to a set of argument slots. Empty slots render as translucent
// numbered placeholder boxes (via injected `_snl_arg_N` macros); non-empty
// slots are parsed as SNL source and substituted as real subtrees.
//
// v6 schema (see snlDoc.ts / @sjtu-ai4math/snl-basics):
//   - `mode` is 4 flat parallel values:
//     formula_inline / formula_display / text / block
//     (old `display` axis is folded into mode itself).
//   - `dynamic_arity: boolean` replaces `arity: 'fixed' | 'variadic'`.
//     UI: single checkbox "☐ Dynamic Arity". When ticked, the KaTeX
//     template textarea shrinks to leave room for three delimiter fields
//     (Left / Separator / Right) that populate `template_left` /
//     `separator` / `template_right` on the style.
//   - Free-text `tags?: string[]` at both macro and style level.
//     Backslashes forbidden.
//
// 2026-07-04 UI overhaul:
//   * Title: "Create/Edit Macro in <package display name>" (fallback file).
//     No subtitle row.
//   * Row 1: Name (1/4) | Kind (1/4) | Description (1/2). No "Already
//     taken" hint (host will 400 on true collision).
//   * Modes UI: a single vertical Mode switcher (4 values), placed to the
//     LEFT of the Preview + template block, styled to match Styles buttons.
//   * Style rename: DOUBLE-CLICK a style switch button to inline-rename it.
//     Enter or blur commits; Escape cancels. Single-click still selects.
//   * "Argument overrides" section is labeled "Argument overrides during
//     preview" to disambiguate from real macro arguments.
//   * Tags: collapsible list editors appended at the end of the Style panel
//     (per-style) and at the end of the whole Panel (per-macro).
//   * Empty-template preview shows `\text{SNL Macro Preview}` instead of
//     the raw internal `_snl_draft` name.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemedKindColoring } from '../../src/kindColoring';
import { resolveWebviewKindColoring } from './render/kindColoring';
import {
  editorDraftKey,
  loadDraft,
  saveDraft,
  usePersistedDraft,
  useSaveShortcut
} from './components/draftState';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
import { is_i18n, read_localized } from '@sjtu-ai4math/snl-basics/runtime';
import './create-macro.css';
import {
  tryParseSnlSyntaxTree,
  isSnlIdentifier,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  type SnlMacro,
  type SnlMacroStyle,
  type SnlSyntaxTree,
  type SnlRenderHooks,
  type Localized
} from '@sjtu-ai4math/snl-basics';
import { analyzeLatexTemplatePlaceholders } from '../../src/templatePlaceholders';
import {
  readTableTemplateOptions,
  type TableCssColors,
  type TableTemplateOptions
} from '../../src/tableTemplateOptions';
import {
  wireMacroEntriesToRenderable,
  type WireMacro,
  type WireMacroTemplate
} from './render/macroWire';
import {
  createMacroDataDriver,
  type MacroRecord
} from './render/macroData';
import { extensionRenderers } from './render/blockRenderers';
import { CollapsibleScope } from './render/CollapsibleScope';
import { macroKindsToPalette } from './render/macroKindPalette';
import {
  MacroPreviewRuntimeProvider,
  createMacroPreviewRuntime
} from './render/MacroPreview';
import {
  useVsCodeApiRef,
  PANEL_STYLE
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { LocalizedLanguageSelector } from './components/LocalizedLanguageSelector';
import { MissingEditorTarget } from './components/MissingEditorTarget';
import { Button } from './components/Button';
import { IconButton } from './components/IconButton';
import { Disclosure } from './components/Disclosure';
import { TabButton, TabList } from './components/Tabs';
import { MacroIdInput } from './components/MacroIdInput';
import { EntityIdSearchBox } from './components/EntityIdSearchBox';
import { ColorField } from './components/KindFormFields';
import type { EntryOption } from './render/EntryRender';
import { areEntityReferencesResolved } from './components/formValidation';
import {
  use_preferences_revision,
  use_supported_languages,
  webview_language_runtime
} from './runtime/preferencesRuntime';
import type { SnooglSearchCandidate } from '../../src/snooglSearch';
import { BUILT_IN_LANGUAGE_CATALOG } from '../../src/languageCatalog';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';
import {
  LOCALIZED_GENERAL_LANGUAGE,
  LocalizedEditScope,
  materializeLocalizedValueForSave,
  useLocalizedBinding,
  useLocalizedEditLanguage
} from './components/LocalizedEditScope';
import {
  parseBlockRendererSpec,
  serializeBlockRendererSpec,
  serializeTableRendererSpec,
  tableOptionsFromRendererParams
} from './render/blockRendererSpec';

const CREATE_MACRO_MESSAGES = defineUiMessages(
  'createMacro',
  {
    createTitle: 'Create Macro in {package}',
    editTitle: 'Edit Macro in {package}',
    dashboard: 'Dashboard',
    backToDashboard: 'Back to Dashboard',
    name: 'Name',
    readonly: '(readonly)',
    unique: '(unique)',
    immutableName: 'Macro names are immutable; delete + recreate to rename',
    kind: 'Kind',
    unset: '(unset)',
    newMacroKind: '+ New macro kind…',
    colorPreview: 'stroke {stroke} / background {background}',
    description: 'Description',
    optional: '(optional)',
    descriptionPlaceholder: 'Short human-readable description',
    contentStyle: 'Content — style "{style}"',
    tabKatex: 'KaTeX template',
    tabTypstBuiltin: 'Typst built_in',
    tabTypstSynthesis: 'Typst synthesis',
    tabLatexBuiltin: 'LaTeX built_in',
    tabLatexSynthesis: 'LaTeX synthesis',
    tabMarkdown: 'Markdown',
    tabText: 'Text',
    blockModeHelp: 'Block mode — this macro renders through a React component picked by the Render preset below. Children are passed to the renderer as a flat variadic list; the LaTeX template and variadic delimiters are ignored, so they are hidden here.',
    dynamicArityHelp: 'Dynamic arity — configure the left / separator / right delimiters below. The macro renders as left + children.join(sep) + right. For more complex shapes (matrix rows, per-cell styling), split it into multiple macros.',
    latexTemplateHelp: 'LaTeX template — use #0, #1, … for children. \\# = literal #. Do NOT write \\htmlData — the wrapper is added automatically.',
    katexPlaceholder: 'e.g. \\frac{arg0}{arg1}',
    styleTags: 'Style tags — "{style}"',
    dynamicArity: 'Dynamic Arity',
    rendersAs: 'renders as {expression}',
    argumentOverrides: 'Argument overrides during preview',
    addArg: '+ Add Arg',
    removeArg: '− Remove Arg',
    resetArgs: 'Reset all args',
    noDynamicArgs: 'No argument slots. Use "+ Add Arg".',
    noFixedArgs: 'No #N placeholders in the template — nothing to fill.',
    argLabel: 'arg {index}',
    argPlaceholder: 'SNL source to substitute (empty = box[{index}])',
    parseError: 'parse error: {error}',
    sources: 'Sources',
    entries: 'Entries',
    urls: 'URLs',
    urlPlaceholder: 'https://…',
    macroTags: 'Macro tags',
    updating: 'Updating…',
    creating: 'Creating…',
    updateMacro: 'Update Macro',
    createMacro: 'Create Macro',
    templateRequired: 'KaTeX template is required.',
    namePlaceholder: 'e.g. Add.add',
    editWholeTitle: 'Collapse back to a single ID input (Edit whole ID)',
    editWholeAria: 'Edit whole ID',
    editWhole: '✎ whole',
    invalidSegment: 'Invalid segment — cannot contain @ # $ %, whitespace, or bracket chars ( ) [ ] {braces}.',
    nameSegment: 'name',
    namespaceSegment: 'namespace',
    renderMode: 'Render mode',
    mode: 'Mode',
    modeFormulaInline: 'Formula (inline)',
    modeFormulaDisplay: 'Formula (display)',
    modeText: 'Text (I18N)',
    templateI18nHeading: 'Template (I18N)',
    modeBlock: 'Block',
    leftDelimiter: 'Left delimiter',
    leftDelimiterPlaceholder: 'e.g. \\begin{environment} or [',
    separator: 'Separator',
    separatorPlaceholder: 'e.g. \\\\ or , ',
    rightDelimiter: 'Right delimiter',
    rightDelimiterPlaceholder: 'e.g. \\end{environment} or ]',
    none: '(none)',
    tagCount: '{count} tag(s)',
    noTags: 'No tags. Tags are free-text labels used by downstream search indices. Backslashes are not allowed.',
    tagPlaceholder: 'tag',
    addTag: '+ Add tag',
    removeTag: 'Remove tag {index}',
    styles: 'Styles',
    moveEarlier: 'Move earlier (toward default)',
    addStyle: '+ Add style',
    removeStyle: 'Remove style {style}',
    duplicateStyleTags: 'Duplicate style tags — each style tag must be unique.',
    fallbackHelp: '★ = the sole implicit default (styles[0]). Explicit [style] always wins; language changes only the selected text style’s localized template.',
    generalLanguage: 'General',
    localizedExplicit: 'Explicit translation',
    localizedFallback: 'Fallback from {language}',
    localizedInvariant: 'Language-invariant value',
    localizedMissing: 'Missing translation',
    clearTranslation: 'Delete this translation',
    localizedModeConfirm: 'Changing this localized text Style to a structural mode keeps only the currently selected {language} projection and deletes its other translations. Continue?',
    language: 'Language',
    renderPreset: 'Render preset',
    presetNone: '— none —',
    customKey: 'Custom key…',
    customRenderHint: 'Custom render key — consumer must register a matching renderer. Empty key = no dispatch.',
    noRenderHint: 'No render preset. The block will render with plain default layout.',
    presetListHint: 'Unordered list — LaTeX \\begin{environment} → <ul><li>…',
    presetEnumerateHint: 'Ordered list — LaTeX \\begin{environment} → <ol><li>…',
    presetTableHint: 'Table — choose rows → table or blocks → one row. Cell merging is not configured here.',
    tableComposition: 'Table composition',
    tableRows: 'Rows → table',
    tableCells: 'Blocks → row',
    tableLight: 'Light',
    tableDark: 'Dark',
    tableTextColor: 'text',
    tableBackgroundColor: 'background',
    tableBorderColor: 'border',
    presetCenteredHint: 'Horizontally-centered block wrapper.',
    presetCollapsibleHint: 'Collapsible block — the first child is the always-visible summary; the rest fold behind a toggle.',
    presetImageHint: 'Image — path is relative to .SNL_Doc/assets.',
    numbering: 'Numbering',
    numberingDecimal: '123',
    numberingLowerAlpha: 'abc',
    numberingUpperAlpha: 'ABC',
    numberingDots: '· · ·',
    numberingEllipsis: '...',
    imagePath: 'Image path',
    imageLayout: 'Image layout',
    imageAlt: 'Image alt text',
    imagePathRequired: 'Image path is required.',
    imagePathInvalid: 'Use a safe path relative to .SNL_Doc/assets.',
    imageInline: 'Inline',
    imageBlock: 'Block',
    emptyStyle: '(empty)',
    renameStyle: 'Double-click to rename',
    searchEntry: 'Search entry id or title…',
    add: '+ Add',
    removeEntrySource: 'Remove Entry source {index}',
    removeUrlSource: 'Remove URL source {index}',
    nonHttp: "doesn't start with http",
    synthesisMode: 'Synthesis mode',
    synthesisFormula: 'Formula',
    synthesisText: 'Text',
    previewError: 'Preview error: {error}',
    macroPreview: 'SNL Macro Preview',
    createdStatus: 'Created "{name}"',
    updatedStatus: 'Updated "{name}"',
    invalidStatus: '❌ Invalid: {reason}',
    errorStatus: '❌ Error: {message}'
  },
  {
    createTitle: '在 {package} 中创建宏',
    editTitle: '在 {package} 中编辑宏',
    dashboard: '仪表板',
    backToDashboard: '返回仪表板',
    name: '名称',
    readonly: '（只读）',
    unique: '（唯一）',
    immutableName: '宏名称不可更改；如需重命名，请删除后重新创建',
    kind: '种类',
    unset: '（未设置）',
    newMacroKind: '+ 新建宏种类…',
    colorPreview: '描边 {stroke} / 背景 {background}',
    description: '说明',
    optional: '（可选）',
    descriptionPlaceholder: '简短易读的说明',
    contentStyle: '内容 — 样式“{style}”',
    tabKatex: 'KaTeX 模板',
    tabTypstBuiltin: 'Typst built_in',
    tabTypstSynthesis: 'Typst 合成',
    tabLatexBuiltin: 'LaTeX built_in',
    tabLatexSynthesis: 'LaTeX 合成',
    tabMarkdown: 'Markdown',
    tabText: '文本',
    blockModeHelp: '块模式 — 此宏通过下方“渲染预设”选择的 React 组件渲染。子节点会作为扁平可变参数列表传给渲染器；LaTeX 模板和可变参数分隔符会被忽略，因此这里将其隐藏。',
    dynamicArityHelp: '动态参数 — 请在下方配置左侧、分隔符和右侧定界符。宏按 left + children.join(sep) + right 渲染。矩阵行或逐单元格样式等复杂结构请拆分为多个宏。',
    latexTemplateHelp: 'LaTeX 模板 — 使用 #0、#1、… 表示子节点。\\# 表示字面量 #。不要写 \\htmlData；外层包装会自动添加。',
    katexPlaceholder: '例如 \\frac{arg0}{arg1}',
    styleTags: '样式标签 — “{style}”',
    dynamicArity: '动态参数',
    rendersAs: '渲染为 {expression}',
    argumentOverrides: '预览参数覆盖',
    addArg: '+ 添加参数',
    removeArg: '− 移除参数',
    resetArgs: '重置所有参数',
    noDynamicArgs: '没有参数槽。请使用“+ 添加参数”。',
    noFixedArgs: '模板中没有 #N 占位符，无内容可填写。',
    argLabel: '参数 {index}',
    argPlaceholder: '要替换的 SNL 源码（留空 = 方框[{index}]）',
    parseError: '解析错误：{error}',
    sources: '来源',
    entries: '条目',
    urls: '网址',
    urlPlaceholder: 'https://…',
    macroTags: '宏标签',
    updating: '正在更新…',
    creating: '正在创建…',
    updateMacro: '更新宏',
    createMacro: '创建宏',
    templateRequired: '必须填写 KaTeX 模板。',
    namePlaceholder: '例如 Add.add',
    editWholeTitle: '折叠为单个 ID 输入框（编辑完整 ID）',
    editWholeAria: '编辑完整 ID',
    editWhole: '✎ 完整 ID',
    invalidSegment: '无效片段 — 不能包含 @ # $ %、空白或括号字符 ( ) [ ] {braces}。',
    nameSegment: '名称',
    namespaceSegment: '命名空间',
    renderMode: '渲染模式',
    mode: '模式',
    modeFormulaInline: '公式（行内）',
    modeFormulaDisplay: '公式（展示）',
    modeText: '文本（I18N）',
    templateI18nHeading: '模板（I18N）',
    modeBlock: '块',
    leftDelimiter: '左侧定界符',
    leftDelimiterPlaceholder: '例如 \\begin{environment} 或 [',
    separator: '分隔符',
    separatorPlaceholder: '例如 \\\\ 或 , ',
    rightDelimiter: '右侧定界符',
    rightDelimiterPlaceholder: '例如 \\end{environment} 或 ]',
    none: '（无）',
    tagCount: '{count} 个标签',
    noTags: '暂无标签。标签是供下游搜索索引使用的自由文本；不允许使用反斜杠。',
    tagPlaceholder: '标签',
    addTag: '+ 添加标签',
    removeTag: '移除标签 {index}',
    styles: '样式',
    moveEarlier: '向前移动（靠近默认样式）',
    addStyle: '+ 添加样式',
    removeStyle: '移除样式 {style}',
    duplicateStyleTags: '样式标签重复；每个样式标签必须唯一。',
    fallbackHelp: '★ = 唯一隐式默认样式（styles[0]）。显式 [style] 始终优先；切换语言只会选择当前文本样式内的本地化模板。',
    generalLanguage: '通用',
    localizedExplicit: '当前语言的显式翻译',
    localizedFallback: '回退自 {language}',
    localizedInvariant: '与语言无关的值',
    localizedMissing: '缺少翻译',
    clearTranslation: '删除当前翻译',
    localizedModeConfirm: '将这个本地化文本样式切换为结构模式，只会保留当前选择的 {language} 投影，并删除其他翻译。是否继续？',
    language: '语言',
    renderPreset: '渲染预设',
    presetNone: '— 无 —',
    customKey: '自定义键…',
    customRenderHint: '自定义渲染键 — 使用方必须注册匹配的渲染器。空键表示不分派。',
    noRenderHint: '未设置渲染预设；该块将使用普通默认布局。',
    presetListHint: '无序列表 — LaTeX \\begin{environment} → <ul><li>…',
    presetEnumerateHint: '有序列表 — LaTeX \\begin{environment} → <ol><li>…',
    presetTableHint: '表格 — 可选择“行拼表”或“块拼一行”；这里暂不配置单元格合并。',
    tableComposition: '表格组合方式',
    tableRows: '行 → 表格',
    tableCells: '块 → 一行',
    tableLight: '明亮',
    tableDark: '暗色',
    tableTextColor: '文字',
    tableBackgroundColor: '背景',
    tableBorderColor: '边框',
    presetCenteredHint: '水平居中的块包装器。',
    presetCollapsibleHint: '折叠块 — 第一个子节点始终显示为摘要，其余内容可通过开关折叠。',
    presetImageHint: '图片 — 路径相对于 .SNL_Doc/assets。',
    numbering: '编号样式',
    numberingDecimal: '123',
    numberingLowerAlpha: 'abc',
    numberingUpperAlpha: 'ABC',
    numberingDots: '· · ·',
    numberingEllipsis: '...',
    imagePath: '图片路径',
    imageLayout: '图片布局',
    imageAlt: '图片替代文本',
    imagePathRequired: '必须填写图片路径。',
    imagePathInvalid: '请输入相对于 .SNL_Doc/assets 的安全路径。',
    imageInline: '行内',
    imageBlock: '块级',
    emptyStyle: '（空）',
    renameStyle: '双击重命名',
    searchEntry: '搜索条目 ID 或标题…',
    add: '+ 添加',
    removeEntrySource: '移除条目来源 {index}',
    removeUrlSource: '移除网址来源 {index}',
    nonHttp: '不是以 http 开头',
    synthesisMode: '合成模式',
    synthesisFormula: '公式',
    synthesisText: '文本',
    previewError: '预览错误：{error}',
    macroPreview: 'SNL 宏预览',
    createdStatus: '已创建“{name}”',
    updatedStatus: '已更新“{name}”',
    invalidStatus: '❌ 无效：{reason}',
    errorStatus: '❌ 错误：{message}'
  }
);
import {
  MACRO_PREVIEW_ARGUMENTS,
  MAX_MACRO_PREVIEW_ARGS,
  macroPreviewArgumentNode,
  maxMacroTemplateChildIndex
} from './render/macroPreviewPlaceholders';
// ---------------------------------------------------------------------------
// Preview constants
// ---------------------------------------------------------------------------

const DRAFT_KEY = '_snl_draft';
const PREVIEW_PLACEHOLDER_KEY = '_snl_preview_placeholder';

/**
 * Empty-state preview macro. Used when the current style's template is empty
 * so the preview shows something informative instead of the internal
 * `_snl_draft` name.
 */
function previewPlaceholderMacro(label: string): SnlMacro {
  return {
    name: PREVIEW_PLACEHOLDER_KEY,
    description: 'SNL preview placeholder',
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    tags: [],
    styles: [
      {
        style_name: 'default',
        tags: [],
        template: { mode: 'text', body: label }
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

type Mode = 'formula_inline' | 'formula_display' | 'text' | 'block';
type SynthesisMode = 'formula' | 'text';
type StructuralTemplateDraft = {
  template: string;
  template_left: string;
  separator: string;
  template_right: string;
};

function localizedTemplate<Value>(value: Localized<string, Value>, language: string): Value {
  return read_localized(value)({ language });
}

function toggleStructuralDraftArity(
  draft: StructuralTemplateDraft,
  dynamic: boolean
): StructuralTemplateDraft {
  if (dynamic) {
    const template = draft.template.includes('#*') ? draft.template : `${draft.template}#*`;
    const marker = template.indexOf('#*');
    return {
      ...draft,
      template,
      template_left: template.slice(0, marker),
      template_right: template.slice(marker + 2)
    };
  }
  const template = `${draft.template_left}#*${draft.template_right}`;
  return { ...draft, template: template === '#*' ? '' : template };
}

function toggleStructuralDraftMapArity(
  drafts: StyleDraft['structural_template_drafts'],
  dynamic: boolean
): StyleDraft['structural_template_drafts'] {
  if (!drafts) return undefined;
  return Object.fromEntries(Object.entries(drafts).map(([mode, draft]) => [
    mode,
    toggleStructuralDraftArity(draft, dynamic)
  ])) as StyleDraft['structural_template_drafts'];
}

const MODE_MESSAGE_KEYS: Record<Mode, 'modeFormulaInline' | 'modeFormulaDisplay' | 'modeText' | 'modeBlock'> = {
  formula_inline: 'modeFormulaInline',
  formula_display: 'modeFormulaDisplay',
  text: 'modeText',
  block: 'modeBlock'
};
const MODE_ORDER: Mode[] = ['formula_inline', 'formula_display', 'text', 'block'];

interface TemplateProjectionDraft {
  template_extensions: Record<string, unknown>;
  mode: Mode;
  /** Current projection's render body. */
  template: string;
  /** Reversible text-mode body retained while previewing another mode. */
  text_template_draft?: string;
  /** Reversible, editor-only draft for each non-text mode in this language. */
  structural_template_drafts?: Partial<Record<Exclude<Mode, 'text'>, StructuralTemplateDraft>>;
  template_left: string;
  separator: string;
  template_right: string;
  block_template_name: string;
  table_options: TableTemplateOptions;
  image_path_draft: string;
  image_path_invalid: boolean;
  typst_extensions: Record<string, unknown>;
  typst_synthesis_extensions: Record<string, unknown>;
  latex_extensions: Record<string, unknown>;
  latex_synthesis_extensions: Record<string, unknown>;
  typst_built_in: string;
  typst_synthesis: string;
  typst_synthesis_mode: SynthesisMode;
  latex_built_in: string;
  latex_synthesis: string;
  latex_synthesis_mode: SynthesisMode;
  markdown: string;
  text: string;
}

/** Editable style identity plus a full localized Template projection map. */
interface StyleDraft extends TemplateProjectionDraft {
  extensions: Record<string, unknown>;
  style_name: string;
  template_localized: Localized<string, TemplateProjectionDraft>;
  /** Webview-session-only language choice for this style's template editor. */
  template_edit_language: string;
  tags: string[];
}

interface MacroEditorDraft {
  name: string;
  description: string;
  sourceEntries: string[];
  sourceUrls: string[];
  dynamicArity: boolean;
  macroTags: string[];
  kind: string;
  styles: StyleDraft[];
  originalRevision?: string;
}

function defaultTableOptions(): TableTemplateOptions {
  const colors = (): TableCssColors => ({ color: '', background: '', border: '' });
  return {
    composition: 'rows',
    css: { light: colors(), dark: colors() }
  };
}

function newTemplateProjection(): TemplateProjectionDraft {
  return {
    template_extensions: {},
    typst_extensions: {},
    typst_synthesis_extensions: {},
    latex_extensions: {},
    latex_synthesis_extensions: {},
    mode: 'formula_inline',
    template: '',
    template_left: '',
    separator: '',
    template_right: '',
    block_template_name: '',
    table_options: defaultTableOptions(),
    image_path_draft: '',
    image_path_invalid: false,
    typst_built_in: '',
    typst_synthesis: '',
    typst_synthesis_mode: 'formula',
    latex_built_in: '',
    latex_synthesis: '',
    latex_synthesis_mode: 'formula',
    markdown: '',
    text: ''
  };
}

function newStyleDraft(styleName: string): StyleDraft {
  const projection = newTemplateProjection();
  return {
    extensions: {},
    style_name: styleName,
    ...projection,
    template_localized: projection,
    template_edit_language: LOCALIZED_GENERAL_LANGUAGE,
    tags: []
  };
}

function normalizeRestoredStyleDraft(input: unknown): StyleDraft {
  const raw = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const base = newStyleDraft(typeof raw.style_name === 'string' ? raw.style_name : 'default');
  const merged = { ...base, ...raw } as StyleDraft;
  if (raw.template_localized !== undefined) {
    const source = raw.template_localized as Localized<string, TemplateProjectionDraft>;
    const language = typeof raw.template_edit_language === 'string'
      ? raw.template_edit_language
      : (is_i18n(source) ? source.default_language : LOCALIZED_GENERAL_LANGUAGE);
    const projection = localizedTemplate(
      source,
      language === LOCALIZED_GENERAL_LANGUAGE
        ? (is_i18n(source) ? source.default_language : 'en')
        : language
    );
    return {
      ...applyProjection(merged, projection),
      template_localized: source,
      template_edit_language: language,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []
    };
  }

  const legacy = raw.template as Localized<string, string> | undefined;
  const projectionBase = { ...projectionFromStyle(merged), template: '' };
  const template_localized: Localized<string, TemplateProjectionDraft> = legacy === undefined
    ? projectionBase
    : is_i18n(legacy)
      ? {
          ...legacy,
          values: Object.fromEntries(Object.entries(legacy.values).map(([language, body]) => [
            language,
            body === undefined ? undefined : { ...projectionBase, template: body }
          ]))
        }
      : { ...projectionBase, template: legacy };
  const language = typeof raw.template_edit_language === 'string'
    ? raw.template_edit_language
    : (is_i18n(template_localized) ? template_localized.default_language : LOCALIZED_GENERAL_LANGUAGE);
  const projection = localizedTemplate(
    template_localized,
    language === LOCALIZED_GENERAL_LANGUAGE
      ? (is_i18n(template_localized) ? template_localized.default_language : 'en')
      : language
  );
  return {
    ...applyProjection(merged, projection),
    template_localized,
    template_edit_language: language,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []
  };
}

function projectionFromStyle(style: StyleDraft): TemplateProjectionDraft {
  const {
    template_extensions,
    mode, template, text_template_draft, structural_template_drafts,
    template_left, separator, template_right, block_template_name, table_options,
    image_path_draft, image_path_invalid,
    typst_extensions, typst_synthesis_extensions,
    latex_extensions, latex_synthesis_extensions,
    typst_built_in, typst_synthesis, typst_synthesis_mode,
    latex_built_in, latex_synthesis, latex_synthesis_mode,
    markdown, text
  } = style;
  return {
    template_extensions,
    mode, template, text_template_draft, structural_template_drafts,
    template_left, separator, template_right, block_template_name, table_options,
    image_path_draft, image_path_invalid,
    typst_extensions, typst_synthesis_extensions,
    latex_extensions, latex_synthesis_extensions,
    typst_built_in, typst_synthesis, typst_synthesis_mode,
    latex_built_in, latex_synthesis, latex_synthesis_mode,
    markdown, text
  };
}

function applyProjection(style: StyleDraft, projection: TemplateProjectionDraft): StyleDraft {
  return { ...style, ...projection };
}

function writeTemplateProjection(
  value: Localized<string, TemplateProjectionDraft>,
  language: string,
  projection: TemplateProjectionDraft
): Localized<string, TemplateProjectionDraft> {
  if (language === LOCALIZED_GENERAL_LANGUAGE) return projection;
  if (is_i18n(value)) {
    return { ...value, values: { ...value.values, [language]: projection } };
  }
  return { type: 'i18n', default_language: language, values: { [language]: projection } };
}

function mapTemplateProjections(
  value: Localized<string, TemplateProjectionDraft>,
  map: (projection: TemplateProjectionDraft) => TemplateProjectionDraft
): Localized<string, TemplateProjectionDraft> {
  if (!is_i18n(value)) return map(value);
  return {
    ...value,
    values: Object.fromEntries(Object.entries(value.values).map(([language, projection]) => [
      language,
      projection === undefined ? undefined : map(projection)
    ]))
  };
}

function effectiveVariadicIndex(body: string): number {
  for (let index = 0; index < body.length - 1; index += 1) {
    if (body[index] === '#' && body[index + 1] === '*' && body[index - 1] !== '\\') return index;
  }
  return -1;
}

function toggleTextTemplateArity(body: string, dynamic: boolean): string {
  const marker = effectiveVariadicIndex(body);
  if (dynamic) return marker >= 0 ? body : `${body}#*`;
  return marker >= 0 ? `${body.slice(0, marker)}${body.slice(marker + 2)}` : body;
}

function toggleTemplateProjectionArity(
  projection: TemplateProjectionDraft,
  dynamic: boolean
): TemplateProjectionDraft {
  const text_template_draft = projection.text_template_draft === undefined
    ? undefined
    : toggleTextTemplateArity(projection.text_template_draft, dynamic);
  const structural_template_drafts = toggleStructuralDraftMapArity(
    projection.structural_template_drafts,
    dynamic
  );
  if (projection.mode === 'text') {
    const template = toggleTextTemplateArity(projection.template, dynamic);
    const marker = effectiveVariadicIndex(template);
    return {
      ...projection,
      template,
      template_left: marker >= 0 ? template.slice(0, marker) : '',
      template_right: marker >= 0 ? template.slice(marker + 2) : '',
      text_template_draft,
      structural_template_drafts
    };
  }
  const active = toggleStructuralDraftArity({
    template: projection.template,
    template_left: projection.template_left,
    separator: projection.separator,
    template_right: projection.template_right
  }, dynamic);
  return {
    ...projection,
    ...active,
    text_template_draft,
    structural_template_drafts
  };
}

/** Serialize a draft to strict Macro v11 storage. */
function projectionToExtendedTemplate(
  projection: TemplateProjectionDraft,
  dynamicArity: boolean
): ExtendedTemplateSpec {
  const body = dynamicArity
    ? `${projection.template_left}#*${projection.template_right}`
    : projection.template;
  let blockTemplateName = projection.block_template_name;
  let tableRenderer = false;
  if (projection.mode === 'block' && blockTemplateName) {
    try {
      tableRenderer = parseBlockRendererSpec(blockTemplateName).name === 'table';
    } catch {
      tableRenderer = false;
    }
    if (tableRenderer) blockTemplateName = serializeTableRendererSpec(projection.table_options);
  }
  return {
    ...projection.template_extensions,
    mode: projection.mode,
    body,
    ...(dynamicArity ? { separator: projection.separator } : {}),
    ...(projection.mode === 'block' && blockTemplateName
      ? { block_template_name: blockTemplateName }
      : {}),
    ...(projection.mode === 'block' && tableRenderer
      ? { table: projection.table_options }
      : {}),
    typst: {
      ...projection.typst_extensions,
      built_in: projection.typst_built_in,
      synthesis: {
        ...projection.typst_synthesis_extensions,
        mode: projection.typst_synthesis_mode,
        macro: projection.typst_synthesis
      }
    },
    latex: {
      ...projection.latex_extensions,
      built_in: projection.latex_built_in,
      synthesis: {
        ...projection.latex_synthesis_extensions,
        mode: projection.latex_synthesis_mode,
        macro: projection.latex_synthesis
      }
    },
    markdown: projection.markdown,
    text: projection.text
  } as ExtendedTemplateSpec;
}

function styleDraftToExtended(s: StyleDraft, dynamicArity: boolean): ExtendedSnlMacroStyle {
  const materialized = materializeLocalizedValueForSave(
    s.template_localized,
    s.template_edit_language
  );
  const template = is_i18n(materialized)
    ? {
        ...materialized,
        values: Object.fromEntries(Object.entries(materialized.values).map(
          ([language, projection]) => [
            language,
            projection === undefined ? undefined : projectionToExtendedTemplate(projection, dynamicArity)
          ]
        ))
      }
    : projectionToExtendedTemplate(materialized ?? projectionFromStyle(s), dynamicArity);
  return {
    ...s.extensions,
    style_name: s.style_name,
    tags: s.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    template
  };
}

/** A user-defined macro kind, sent from the extension host with `context`. */
interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: ThemedKindColoring;
}

/**
 * One render style of the extended, on-disk macro shape (v6). A superset of
 * the library's `SnlMacroStyle`: additionally carries the consumer-owned
 * output backends (typst / latex / markdown / text) per style.
 */
interface ExtendedStyleBackends {
  typst?: {
    built_in: string;
    synthesis: { mode: SynthesisMode; macro: string };
  };
  latex?: {
    built_in: string;
    synthesis: { mode: SynthesisMode; macro: string };
  };
  markdown?: string;
  text?: string;
}
type ExtendedTemplateSpec = WireMacroTemplate & ExtendedStyleBackends;
type ExtendedSnlMacroStyle = {
  [key: string]: unknown;
  style_name: string;
  tags: string[];
  template: Localized<string, ExtendedTemplateSpec>;
};

/**
 * The extended, on-disk macro shape written to a package file (v6). Superset
 * of the library's render-only `SnlMacro`: the output backends live inside
 * each style. The preview DB uses the slim lib `SnlMacro`; only the
 * save-to-disk path uses this shape.
 */
interface ExtendedSnlMacro {
  [key: string]: unknown;
  name: string;
  description: string;
  source: { [key: string]: unknown; entries: string[]; urls: string[] };
  kind?: string;
  dynamic_arity: boolean;
  styles: ExtendedSnlMacroStyle[];
  tags: string[];
}

function extendedTemplateToDraft(template: ExtendedTemplateSpec): TemplateProjectionDraft {
  const raw = template as unknown as Record<string, unknown>;
  const {
    mode: _mode, body: _body, separator: _separator,
    block_template_name: _blockTemplateName, table: _table,
    typst: _typst, latex: _latex, markdown: _markdown, text: _text,
    ...template_extensions
  } = raw;
  const typstRaw = template.typst && typeof template.typst === 'object'
    ? template.typst as unknown as Record<string, unknown> : {};
  const { built_in: _typstBuiltIn, synthesis: _typstSynthesis, ...typst_extensions } = typstRaw;
  const typstSynthesisRaw = template.typst?.synthesis && typeof template.typst.synthesis === 'object'
    ? template.typst.synthesis as unknown as Record<string, unknown> : {};
  const { mode: _typstMode, macro: _typstMacro, ...typst_synthesis_extensions } = typstSynthesisRaw;
  const latexRaw = template.latex && typeof template.latex === 'object'
    ? template.latex as unknown as Record<string, unknown> : {};
  const { built_in: _latexBuiltIn, synthesis: _latexSynthesis, ...latex_extensions } = latexRaw;
  const latexSynthesisRaw = template.latex?.synthesis && typeof template.latex.synthesis === 'object'
    ? template.latex.synthesis as unknown as Record<string, unknown> : {};
  const { mode: _latexMode, macro: _latexMacro, ...latex_synthesis_extensions } = latexSynthesisRaw;
  const marker = template.body.indexOf('#*');
  let image_path_draft = '';
  let table_options = defaultTableOptions();
  try {
    const renderer = parseBlockRendererSpec(template.block_template_name ?? '');
    if (renderer.name === 'image') image_path_draft = renderer.params.src ?? '';
    if (renderer.name === 'table') {
      table_options = template.table === undefined
        ? tableOptionsFromRendererParams(renderer.params)
        : readTableTemplateOptions(template as unknown as Record<string, unknown>, 'template');
    }
  } catch {
    // Unknown/custom renderers own neither image nor table editor state.
  }
  return {
    template_extensions,
    mode: template.mode,
    template: template.body,
    template_left: marker >= 0 ? template.body.slice(0, marker) : '',
    separator: template.separator ?? '',
    template_right: marker >= 0 ? template.body.slice(marker + 2) : '',
    block_template_name: template.block_template_name ?? '',
    table_options,
    image_path_draft,
    image_path_invalid: false,
    typst_extensions,
    typst_synthesis_extensions,
    latex_extensions,
    latex_synthesis_extensions,
    typst_built_in: template.typst?.built_in ?? '',
    typst_synthesis: template.typst?.synthesis?.macro ?? '',
    typst_synthesis_mode: template.typst?.synthesis?.mode ?? 'formula',
    latex_built_in: template.latex?.built_in ?? '',
    latex_synthesis: template.latex?.synthesis?.macro ?? '',
    latex_synthesis_mode: template.latex?.synthesis?.mode ?? 'formula',
    markdown: template.markdown ?? '',
    text: template.text ?? ''
  };
}

function extendedLocalizedTemplateToDraft(
  template: Localized<string, ExtendedTemplateSpec>
): Localized<string, TemplateProjectionDraft> {
  if (!is_i18n(template)) return extendedTemplateToDraft(template);
  return {
    ...template,
    values: Object.fromEntries(Object.entries(template.values).map(([language, projection]) => [
      language,
      projection === undefined ? undefined : extendedTemplateToDraft(projection)
    ]))
  };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; name: string; at: number }
  | { kind: 'updated'; name: string; at: number }
  | { kind: 'duplicate'; name: string; message: string }
  | { kind: 'notFound'; name: string; message: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'noFile'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'error'; message: string };

/** Panel mode — separate from Mode (macro render mode) to avoid name clash. */
type PanelMode = 'create' | 'edit';

interface ContextMsg {
  type: 'context';
  mode: PanelMode;
  targetState?: 'found' | 'notFound';
  targetId?: string;
  file: string;
  packageName: string;
  existingNames: string[];
  macroCandidates?: SnooglSearchCandidate[];
  workspaceMacros?: Record<string, WireMacro>;
  macroKinds?: MacroKind[];
  existing?: ExtendedSnlMacro | null;
  macroRevision?: string;
  /**
   * Entry pool for the source.entries picker (EntityIdSearchBox). Pushed
   * on initial context so the picker has options as soon as the panel
   * opens. Optional so older host builds without the field still work
   * (webview treats missing pool as empty — picker falls back to
   * lookup-only "No matching entry"). Cat 2026-07-09.
   */
  entries?: EntryOption[];
  /**
   * Optional prefill (cat 2026-07-12) for CREATE mode. When set, seeds
   * the name / template / mode fields of the first style so the user
   * lands on a form that already reflects the row they clicked from in
   * the Entry GUI editor.
   */
  prefill?: {
    name?: string;
    template?: string;
    mode?: 'formula_inline' | 'formula_display' | 'text';
    /** Full source macro for Copy Macro; its identity is cleared on hydration. */
    macro?: ExtendedSnlMacro;
  } | null;
}

type Incoming =
  | ContextMsg
  | { type: 'kindsRefresh'; macroKinds: MacroKind[] }
  | { type: 'created'; name: string }
  | { type: 'updated'; name: string }
  | { type: 'duplicate'; name: string; message: string }
  | { type: 'notFound'; name: string; message: string }
  | { type: 'invalid'; reason: string }
  | { type: 'noFile'; message: string }
  | { type: 'noWorkspace'; message: string }
  | { type: 'noSnlDoc'; message: string }
  | { type: 'error'; message: string }
  | undefined;

const TABS = [
  { id: 'katex_template', messageKey: 'tabKatex' },
  { id: 'typst_built_in', messageKey: 'tabTypstBuiltin' },
  { id: 'typst_synthesis', messageKey: 'tabTypstSynthesis' },
  { id: 'latex_built_in', messageKey: 'tabLatexBuiltin' },
  { id: 'latex_synthesis', messageKey: 'tabLatexSynthesis' },
  { id: 'markdown', messageKey: 'tabMarkdown' },
  { id: 'text', messageKey: 'tabText' }
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Which {@link StyleDraft} field each content tab edits. */
const TAB_FIELD: Record<TabId, keyof StyleDraft> = {
  katex_template: 'template',
  typst_built_in: 'typst_built_in',
  typst_synthesis: 'typst_synthesis',
  latex_built_in: 'latex_built_in',
  latex_synthesis: 'latex_synthesis',
  markdown: 'markdown',
  text: 'text'
};

const inputStyle: React.CSSProperties = {
  boxSizing: 'border-box',
  padding: '0.35rem 0.5rem',
  color: 'var(--vscode-input-foreground, #ddd)',
  background: 'var(--vscode-input-background, #2a2a2a)',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  borderRadius: '2px',
  fontFamily: 'inherit',
  fontSize: '0.95rem'
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.3rem',
  fontWeight: 600
};

function canonicalMacroKindId(id: string): string {
  return id === 'partial' ? 'sub' : id;
}

function canonicalMacroKindCatalog(kinds: readonly MacroKind[]): MacroKind[] {
  const canonical = kinds
    .filter((kind) => kind.id !== 'partial')
    .map((kind) => ({ ...kind }));
  if (!canonical.some((kind) => kind.id === 'sub')) {
    const legacyPartial = kinds.find((kind) => kind.id === 'partial');
    if (legacyPartial) canonical.push({ ...legacyPartial, id: 'sub' });
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateMacroApp(): React.ReactElement {
  const preferencesRevision = use_preferences_revision();
  const contentLanguage = webview_language_runtime.query_environment().language;
  const supportedLanguages = use_supported_languages();
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const apiRef = useVsCodeApiRef();
  const formDirtyRef = useRef(false);
  const macroRevisionRef = useRef<string | undefined>(undefined);
  const editingNameRef = useRef('');
  const fileRef = useRef('');
  const draftKeyRef = useRef('');
  const [draftKey, setDraftKey] = useState('');
  // Preserve consumer/backend extension fields that this editor does not know
  // how to project into controls. Copy and edit submissions overlay the known
  // draft fields onto this source record instead of silently deleting extras.
  const hydratedMacroBaseRef = useRef<ExtendedSnlMacro | null>(null);

  const [panelMode, setPanelMode] = useState<PanelMode>('create');
  const [targetState, setTargetState] = useState<'found' | 'notFound'>('found');
  const [targetId, setTargetId] = useState('');
  const [file, setFile] = useState('');
  const [packageName, setPackageName] = useState('');
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [macroCandidates, setMacroCandidates] = useState<SnooglSearchCandidate[]>([]);
  const [workspaceMacros, setWorkspaceMacros] = useState<Record<string, WireMacro>>({});
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);
  const macroPreviewRuntime = useMemo(
    () => createMacroPreviewRuntime({
      macros: workspaceMacros,
      macroKinds,
      language: contentLanguage,
      renderRevision: preferencesRevision
    }),
    [contentLanguage, macroKinds, preferencesRevision, workspaceMacros]
  );
  // Shared entry pool for the source.entries picker (EntityIdSearchBox).
  // Populated by the host on ContextMsg / any subsequent 'entries' broadcast.
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceEntries, setSourceEntries] = useState<string[]>(['']);
  const [sourceUrls, setSourceUrls] = useState<string[]>(['']);

  const [dynamicArity, setDynamicArity] = useState(false);
  const [macroTags, setMacroTags] = useState<string[]>([]);
  const [kind, setKind] = useState<string>('');

  // Ordered styles array. At least one style always exists; `styles[0]` is the
  // implicit default (marked ★). `activeStyle` is the style currently being
  // edited in the Content tabs and used as the preview's style.
  const [styles, setStyles] = useState<StyleDraft[]>([newStyleDraft('default')]);
  const [activeStyle, setActiveStyle] = useState(0);

  const [activeTab, setActiveTab] = useState<TabId>('katex_template');

  const [previewArgs, setPreviewArgs] = useState<string[]>(['', '', '', '']);
  const [previewArgsOpen, setPreviewArgsOpen] = useState(false);
  const [variadicArgCount, setVariadicArgCount] = useState(3);

  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const current = styles[activeStyle] ?? styles[0];

  function markFormDirty(): void {
    formDirtyRef.current = true;
  }

  /** Patch fields on the active style and atomically persist its full template projection. */
  function patchStyle(patch: Partial<StyleDraft>): void {
    markFormDirty();
    setStyles((previous) => previous.map((style, index) => {
      if (index !== activeStyle) return style;
      const next = { ...style, ...patch };
      return {
        ...next,
        template_localized: writeTemplateProjection(
          next.template_localized,
          next.template_edit_language,
          projectionFromStyle(next)
        )
      };
    }));
  }

  const setActiveTemplateLanguage = useCallback((language: string): void => {
    setStyles((previous) => previous.map((style, index) => {
      if (index !== activeStyle) return style;
      const lookupLanguage = language === LOCALIZED_GENERAL_LANGUAGE
        ? (is_i18n(style.template_localized) ? style.template_localized.default_language : 'en')
        : language;
      const projection = localizedTemplate(style.template_localized, lookupLanguage);
      return {
        ...applyProjection(style, projection),
        template_edit_language: language
      };
    }));
  }, [activeStyle]);

  const replaceActiveLocalizedTemplate = useCallback((
    value: Localized<string, TemplateProjectionDraft>
  ): void => {
    markFormDirty();
    setStyles((previous) => previous.map((style, index) => {
      if (index !== activeStyle) return style;
      const language = style.template_edit_language;
      const lookupLanguage = language === LOCALIZED_GENERAL_LANGUAGE
        ? (is_i18n(value) ? value.default_language : 'en')
        : language;
      const projection = localizedTemplate(value, lookupLanguage);
      return {
        ...applyProjection(style, projection),
        template_localized: value
      };
    }));
  }, [activeStyle]);

  function changeStyleMode(mode: Mode): void {
    const selected = styles[activeStyle];
    if (!selected || selected.mode === mode) return;
    const currentStructural = {
      template: selected.template,
      template_left: selected.template_left,
      separator: selected.separator,
      template_right: selected.template_right
    };
    const structuralDrafts = selected.mode === 'text'
      ? { ...(selected.structural_template_drafts ?? {}) }
      : {
          ...(selected.structural_template_drafts ?? {}),
          [selected.mode]: currentStructural
        };
    if (mode === 'text') {
      const template = selected.text_template_draft ?? selected.template;
      const marker = template.indexOf('#*');
      patchStyle({
        mode,
        template,
        template_left: marker >= 0 ? template.slice(0, marker) : '',
        template_right: marker >= 0 ? template.slice(marker + 2) : '',
        structural_template_drafts: structuralDrafts
      });
      return;
    }
    if (selected.mode === 'text') {
      const template = selected.template;
      const restored = structuralDrafts[mode];
      if (restored) {
        patchStyle({
          mode,
          template: restored.template,
          text_template_draft: selected.template,
          structural_template_drafts: structuralDrafts,
          template_left: restored.template_left,
          separator: restored.separator,
          template_right: restored.template_right
        });
      } else if (dynamicArity) {
        const dynamicTemplate = template.includes('#*') ? template : `${template}#*`;
        const marker = dynamicTemplate.indexOf('#*');
        patchStyle({
          mode,
          template: dynamicTemplate,
          text_template_draft: selected.template,
          structural_template_drafts: structuralDrafts,
          template_left: dynamicTemplate.slice(0, marker),
          template_right: dynamicTemplate.slice(marker + 2)
        });
      } else {
        patchStyle({
          mode,
          template,
          text_template_draft: selected.template,
          structural_template_drafts: structuralDrafts
        });
      }
      return;
    }
    const restored = structuralDrafts[mode] ?? currentStructural;
    patchStyle({
      mode,
      template: restored.template,
      structural_template_drafts: structuralDrafts,
      template_left: restored.template_left,
      separator: restored.separator,
      template_right: restored.template_right
    });
  }

  /** Keep pass-through fields current even when a restored visible draft wins. */
  function absorbHydratedMacroBase(existing: ExtendedSnlMacro): void {
    const { default_style: _legacyDefaultStyle, ...current } = existing as ExtendedSnlMacro & {
      default_style?: Record<string, string>;
    };
    hydratedMacroBaseRef.current = {
      ...current,
      source: {
        ...(existing.source ?? {}),
        entries: [...(existing.source?.entries ?? [])],
        urls: [...(existing.source?.urls ?? [])]
      },
      styles: (existing.styles ?? []).map((style) => ({ ...style })),
      tags: [...(existing.tags ?? [])]
    };
  }

  function restoreMacroDraft(draft: MacroEditorDraft): void {
    setName(draft.name);
    setDescription(draft.description);
    setSourceEntries(draft.sourceEntries.slice());
    setSourceUrls(draft.sourceUrls.slice());
    setDynamicArity(draft.dynamicArity);
    setMacroTags(draft.macroTags.slice());
    setKind(canonicalMacroKindId(draft.kind));
    setStyles(draft.styles.map(normalizeRestoredStyleDraft));
    setActiveStyle(0);
    setActiveTab('katex_template');
    editingNameRef.current = draft.name;
    macroRevisionRef.current = draft.originalRevision;
    formDirtyRef.current = true;
  }

  /**
   * Load an existing extended macro (from the host, edit mode) into the form
   * state. Field maps to defaults; the on-disk record must already have been
   * migrated to v6 shape by the host reader (snlDoc.v5MacroToV6).
   */
  function hydrateFromExisting(
    existing: ExtendedSnlMacro,
    preserveTemplateEditLanguages = false
  ): void {
    absorbHydratedMacroBase(existing);
    setName(existing.name ?? '');
    setDescription(existing.description ?? '');
    const src = existing.source ?? { entries: [], urls: [] };
    setSourceEntries(
      Array.isArray(src.entries) && src.entries.length > 0
        ? src.entries.slice()
        : ['']
    );
    setSourceUrls(
      Array.isArray(src.urls) && src.urls.length > 0 ? src.urls.slice() : ['']
    );
    setDynamicArity(!!existing.dynamic_arity);
    setKind(canonicalMacroKindId(existing.kind ?? ''));
    setMacroTags(Array.isArray(existing.tags) ? existing.tags.slice() : []);
    const drafts: StyleDraft[] = Array.isArray(existing.styles)
      ? existing.styles.map((style) => {
          const raw = style as unknown as Record<string, unknown>;
          const {
            style_name: _styleName,
            template: _template,
            tags: _tags,
            ...extensions
          } = raw;
          const template_localized = extendedLocalizedTemplateToDraft(style.template);
          const template_edit_language = is_i18n(template_localized)
            ? template_localized.default_language
            : LOCALIZED_GENERAL_LANGUAGE;
          const projection = localizedTemplate(
            template_localized,
            is_i18n(template_localized) ? template_localized.default_language : 'en'
          );
          return {
            extensions,
            style_name: style.style_name || 'default',
            ...projection,
            template_localized,
            template_edit_language,
            tags: style.tags.slice()
          };
        })
      : [newStyleDraft('default')];
    const hydratedStyles = drafts.length > 0 ? drafts : [newStyleDraft('default')];
    setStyles((previous) => hydratedStyles.map((style, index) => {
      if (!preserveTemplateEditLanguages) return style;
      const prior = previous[index];
      return prior?.style_name === style.style_name
        ? { ...style, template_edit_language: prior.template_edit_language }
        : style;
    }));
    setActiveStyle(0);
    setActiveTab('katex_template');
    editingNameRef.current = existing.name ?? '';
    formDirtyRef.current = false;
  }

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setPanelMode(msg.mode);
          setTargetState(msg.mode === 'edit' && msg.targetState === 'notFound' ? 'notFound' : 'found');
          setTargetId(msg.targetId ?? msg.existing?.name ?? '');
          setFile(msg.file);
          fileRef.current = msg.file;
          setPackageName(msg.packageName);
          setExistingNames(Array.isArray(msg.existingNames) ? msg.existingNames : []);
          setMacroCandidates(
            Array.isArray(msg.macroCandidates)
              ? msg.macroCandidates
              : (msg.existingNames ?? []).map((id) => ({ id, labels: [] }))
          );
          setWorkspaceMacros(msg.workspaceMacros && typeof msg.workspaceMacros === 'object'
            ? msg.workspaceMacros
            : {});
          setMacroKinds(canonicalMacroKindCatalog(Array.isArray(msg.macroKinds) ? msg.macroKinds : []));
          setEntryPool(Array.isArray(msg.entries) ? msg.entries : []);

          const identity = msg.mode === 'edit' && msg.existing
            ? `${msg.file}\u0000${msg.existing.name}`
            : `${msg.file}\u0000${msg.packageName}`;
          const nextDraftKey = editorDraftKey('macro', msg.mode, identity);
          const identityChanged = draftKeyRef.current !== nextDraftKey;
          draftKeyRef.current = nextDraftKey;
          setDraftKey(nextDraftKey);

          // Pass-through fields still come from the newest host snapshot; only
          // author-controlled fields and CAS provenance are restored.
          if (msg.mode === 'edit' && msg.existing) {
            absorbHydratedMacroBase(msg.existing);
          }
          const restored = identityChanged
            ? loadDraft<MacroEditorDraft>(apiRef.current, nextDraftKey)
            : undefined;
          if (restored) {
            restoreMacroDraft(restored);
            break;
          }

          if (msg.mode === 'create' && !msg.prefill?.macro) {
            hydratedMacroBaseRef.current = null;
          }
          if (msg.mode === 'edit' && msg.existing) {
            const sameDirtyDraft =
              formDirtyRef.current && editingNameRef.current === msg.existing.name;
            if (!sameDirtyDraft || !macroRevisionRef.current) {
              macroRevisionRef.current = msg.macroRevision;
            }
            if (!sameDirtyDraft) hydrateFromExisting(msg.existing, !identityChanged);
          } else if (msg.mode === 'create' && msg.prefill && !formDirtyRef.current) {
            // Cat 2026-07-12: seed the form from a row's `%…%` / `$…$` /
            // `$$…$$` / plain-id content so the user doesn't retype.
            const p = msg.prefill;
            if (p.macro) {
              hydrateFromExisting({ ...p.macro, name: '' });
              break;
            }
            if (typeof p.name === 'string' && p.name) setName(p.name);
            setStyles((prev) => {
              const first = prev[0] ?? newStyleDraft('default');
              const patched: StyleDraft = { ...first };
              if (typeof p.template === 'string' && p.template) {
                patched.template = p.template;
              }
              if (
                p.mode === 'formula_inline' ||
                p.mode === 'formula_display' ||
                p.mode === 'text'
              ) {
                patched.mode = p.mode;
              }
              patched.template_localized = writeTemplateProjection(
                patched.template_localized,
                patched.template_edit_language,
                projectionFromStyle(patched)
              );
              return [patched, ...prev.slice(1)];
            });
          }
          break;
        case 'kindsRefresh':
          // Cat 2026-07-12: dropdown "+ New macro kind…" flow. Refresh
          // the list without touching any other form state.
          setMacroKinds(canonicalMacroKindCatalog(Array.isArray(msg.macroKinds) ? msg.macroKinds : []));
          break;
        case 'created':
          // The host flips this panel to edit mode for the macro we just
          // created and immediately re-pushes a context. Adopt the new name
          // as our editing identity now so the follow-up context is
          // recognised as "the thing I am already editing".
          saveDraft(apiRef.current, draftKeyRef.current, undefined);
          saveDraft(
            apiRef.current,
            editorDraftKey('macro', 'edit', `${fileRef.current}\u0000${msg.name}`),
            undefined
          );
          editingNameRef.current = msg.name;
          formDirtyRef.current = false;
          setStatus({ kind: 'created', name: msg.name, at: Date.now() });
          break;
        case 'updated':
          saveDraft(apiRef.current, draftKeyRef.current, undefined);
          formDirtyRef.current = false;
          setStatus({ kind: 'updated', name: msg.name, at: Date.now() });
          break;
        case 'duplicate':
          setStatus({ kind: 'duplicate', name: msg.name, message: msg.message });
          break;
        case 'notFound':
          setTargetState('notFound');
          setTargetId(msg.name);
          setStatus({ kind: 'notFound', name: msg.name, message: msg.message });
          break;
        case 'invalid':
          setStatus({ kind: 'invalid', reason: msg.reason });
          break;
        case 'noFile':
          setStatus({ kind: 'noFile', message: msg.message });
          break;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          break;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          break;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          break;
        default:
          break;
      }
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    // Cat 2026-07-12: when the user comes back after using "+ New macro
    // kind…" the child panel has (probably) added a new kind. Refresh
    // the dropdown on regained visibility.
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        apiRef.current?.postMessage({ type: 'refreshKinds' });
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  usePersistedDraft(
    apiRef.current,
    draftKey,
    {
      name,
      description,
      sourceEntries,
      sourceUrls,
      dynamicArity,
      macroTags,
      kind,
      styles,
      originalRevision: macroRevisionRef.current
    } satisfies MacroEditorDraft,
    draftKey.length > 0 && formDirtyRef.current
  );

  // Auto-dismiss the "saved" toast after 5s (猫猫 req: doesn't linger).
  useEffect(() => {
    if (status.kind !== 'created' && status.kind !== 'updated') {
      return;
    }
    const at = status.at;
    const t = setTimeout(() => {
      // Only clear if the same status is still showing — a newer save wins.
      setStatus((cur) =>
        (cur.kind === 'created' || cur.kind === 'updated') && cur.at === at
          ? { kind: 'idle' }
          : cur
      );
    }, 5000);
    return () => clearTimeout(t);
  }, [status]);

  // --- Draft macro + preview DB -------------------------------------------

  const draftMacro: SnlMacro = useMemo(() => {
    const styleList: SnlMacroStyle[] = styles.map((style) => {
      const extended = styleDraftToExtended(style, dynamicArity);
      return {
        style_name: extended.style_name,
        tags: extended.tags,
        template: extended.template
      } as SnlMacroStyle;
    });
    const previewStyles: SnlMacroStyle[] = styleList.length > 0
      ? styleList
      : [{
          style_name: 'default',
          tags: [],
          template: {
            mode: 'formula_inline',
            body: dynamicArity ? '#*' : ''
          }
        }];
    return {
      name: DRAFT_KEY,
      description: '',
      source: { entries: [], urls: [] },
      dynamic_arity: dynamicArity,
      kind: canonicalMacroKindId(kind) || undefined,
      tags: [],
      styles: previewStyles
    };
  }, [dynamicArity, kind, styles, preferencesRevision]);

  // Build a KindPalette from the user's macro kinds so the live preview frames
  // the draft macro's subtree with its declared kind's colours. Falls back to
  // DEFAULT_KIND_PALETTE (SnlSyntaxTreeView merges over the defaults) when the
  // user hasn't initialized any macro kinds.
  const kindPalette = useMemo(
    () => macroKindsToPalette(macroKinds),
    [macroKinds]
  );

  const renderableWorkspaceMacros = useMemo(
    () => wireMacroEntriesToRenderable(Object.entries(workspaceMacros), contentLanguage),
    [contentLanguage, preferencesRevision, workspaceMacros]
  );

  const previewMacroRecord: MacroRecord = useMemo(
    () => ({
      ...renderableWorkspaceMacros,
      ...MACRO_PREVIEW_ARGUMENTS,
      [PREVIEW_PLACEHOLDER_KEY]: previewPlaceholderMacro(t('macroPreview')),      [DRAFT_KEY]: draftMacro
    }),
    [draftMacro, renderableWorkspaceMacros, t]
  );

  const previewMacroDataDriver = useMemo(
    () => createMacroDataDriver(previewMacroRecord),
    [previewMacroRecord]
  );

  // `renderers` must be the full registry (the view replaces, not merges, it);
  // `extensionRenderers` spreads SNL-Basics's defaults. Needed here so that
  // picking the `collapsible` preset actually previews as collapsible.
  const hooks: SnlRenderHooks = useMemo(
    () => ({ ...defaultRenderHooks, renderers: extensionRenderers }),
    []
  );

  // --- Arg slots -----------------------------------------------------------

  const currentTemplate = current?.template ?? '';
  const previewTemplate = current?.mode === 'block' && currentTemplate.trim().length === 0
    ? '#*'
    : currentTemplate;
  const argCount = useMemo(() => {
    if (dynamicArity) {
      return Math.min(Math.max(variadicArgCount, 0), MAX_MACRO_PREVIEW_ARGS);
    }
    const derived = maxMacroTemplateChildIndex(previewTemplate) + 1;
    return Math.min(Math.max(derived, 0), MAX_MACRO_PREVIEW_ARGS);
  }, [dynamicArity, variadicArgCount, previewTemplate]);

  const parseErrors = useMemo(() => {
    const errs: (string | null)[] = [];
    for (let i = 0; i < argCount; i++) {
      const src = previewArgs[i]?.trim();
      if (!src) {
        errs.push(null);
        continue;
      }
      const parsed = tryParseSnlSyntaxTree(src);
      errs.push(parsed.ok ? null : parsed.error);
    }
    return errs;
  }, [argCount, previewArgs]);

  const draftTree: SnlSyntaxTree = useMemo(() => {
    // Empty template → show the "SNL Macro Preview" placeholder root so users
    // don't see the raw internal `_snl_draft` name (猫猫 req).
    if (previewTemplate.trim().length === 0) {
      return {
        macro_name: PREVIEW_PLACEHOLDER_KEY,
        kind: '',
        mdata: null,
        children: []
      };
    }
    const children: SnlSyntaxTree[] = [];
    for (let i = 0; i < argCount; i++) {
      const src = previewArgs[i]?.trim();
      if (src) {
        const parsed = tryParseSnlSyntaxTree(src);
        children.push(parsed.ok ? parsed.tree : macroPreviewArgumentNode(i));
      } else {
        children.push(macroPreviewArgumentNode(i));
      }
    }
    return {
      macro_name: DRAFT_KEY,
      style_name: current?.style_name,
      kind: '', mdata: null, children
    };
  }, [argCount, previewArgs, previewTemplate, current?.style_name]);

  // --- Validation ----------------------------------------------------------

  const exactName = name;
  // In edit mode, `exactName` is the identity of the macro being edited, so
  // its own presence in existingNames must NOT count as a duplicate. Only a
  // create-mode collision blocks submission.
  const isDuplicate =
    panelMode === 'edit' ? false : existingNames.includes(exactName);
  const templateEmpty = styles.some((style) => {
    const projections = is_i18n(style.template_localized)
      ? Object.values(style.template_localized.values).filter(
          (projection): projection is TemplateProjectionDraft => projection !== undefined
        )
      : [style.template_localized];
    return projections.length === 0 || projections.some(
      (projection) => projection.mode !== 'block' && projection.template.trim().length === 0
    );
  });
  const tagList = styles.map((s) => s.style_name);
  const hasEmptyTag = tagList.some((t) => t.length === 0);
  const hasInvalidTag = tagList.some((t) => !isSnlIdentifier(t));
  const hasDupTag = new Set(tagList).size !== tagList.length;
  const hasInvalidTags = [...macroTags, ...styles.flatMap((style) => style.tags)]
    .some((tag) => tag.includes('\\'));
  const hasIncompleteImagePreset = styles.some((style) => {
    const projections = is_i18n(style.template_localized)
      ? Object.values(style.template_localized.values).filter(
          (projection): projection is TemplateProjectionDraft => projection !== undefined
        )
      : [style.template_localized];
    return projections.some((projection) => {
      if (projection.mode !== 'block') return false;
      try {
        const renderer = parseBlockRendererSpec(projection.block_template_name);
        return renderer.name === 'image' && !renderer.params.src;
      } catch {
        return projection.block_template_name.startsWith('snl-ext-preset:v1:image');
      }
    });
  });
  let hasInvalidTemplateContract = false;
  for (const style of styles) {
    const styleTemplateContracts = new Set<string>();
    const projections = is_i18n(style.template_localized)
      ? Object.values(style.template_localized.values).filter(
          (projection): projection is TemplateProjectionDraft => projection !== undefined
        )
      : [style.template_localized];
    if (projections.length === 0) {
      hasInvalidTemplateContract = true;
      continue;
    }
    for (const projection of projections) {
      const body = projectionToExtendedTemplate(projection, dynamicArity).body;
      const analysis = analyzeLatexTemplatePlaceholders(body);
      if (analysis.invalid || analysis.variadic !== dynamicArity) {
        hasInvalidTemplateContract = true;
      }
      styleTemplateContracts.add(`${analysis.variadic ? 'dynamic' : 'fixed'}:${analysis.positional_arity}`);
    }
    if (styleTemplateContracts.size !== 1) hasInvalidTemplateContract = true;
  }
  const canCreate =
    targetState !== 'notFound' &&
    exactName.length > 0 &&
    isSnlIdentifier(exactName) &&
    !isDuplicate &&
    !templateEmpty &&
    !hasEmptyTag &&
    !hasInvalidTag &&
    !hasDupTag &&
    !hasInvalidTags &&
    !hasIncompleteImagePreset &&
    !hasInvalidTemplateContract &&
    areEntityReferencesResolved(sourceEntries, entryPool) &&
    status.kind !== 'creating';

  function setArg(i: number, value: string): void {
    setPreviewArgs((prev) => {
      const next = prev.slice();
      while (next.length <= i) {
        next.push('');
      }
      next[i] = value;
      return next;
    });
  }

  function resetArgs(): void {
    setPreviewArgs(['', '', '', '']);
  }

  // Ctrl/Cmd+S is the same action as the Create/Update button.
  useSaveShortcut(() => handleSubmit(), canCreate);

  function handleSubmit(): void {
    if (!canCreate) {
      return;
    }
    const styleList: ExtendedSnlMacroStyle[] = styles
      .filter((s) => s.style_name.trim().length > 0)
      .map((style) => styleDraftToExtended(style, dynamicArity));
    const trimmedMacroTags = macroTags
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const macro: ExtendedSnlMacro = {
      ...(hydratedMacroBaseRef.current ?? {}),
      name: exactName,
      description: description.trim(),
      source: {
        ...(hydratedMacroBaseRef.current?.source ?? {}),
        entries: sourceEntries.map((s) => s.trim()).filter((s) => s.length > 0),
        urls: sourceUrls.map((s) => s.trim()).filter((s) => s.length > 0)
      },
      kind: canonicalMacroKindId(kind) || 'const',
      dynamic_arity: dynamicArity,
      styles: styleList,
      tags: trimmedMacroTags
    };
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: panelMode === 'edit' ? 'update' : 'create',
      macro,
      expectedRevision: panelMode === 'edit' ? macroRevisionRef.current : undefined
    });
  }

  const showPreview = activeTab === 'katex_template';
  const titlePackage = packageName || file || '\u2026';

  if (panelMode === 'edit' && targetState === 'notFound') {
    return <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={t('editTitle', { package: titlePackage })}
        back={{ label: t('dashboard'), title: t('backToDashboard'), message: { type: 'nav.openDashboard' } }}
      />
      <MissingEditorTarget target="macro" id={targetId || name} />
    </main>;
  }

  const commitKindSelection = (event: React.FormEvent<HTMLSelectElement>): void => {
    const nextKind = event.currentTarget.value;
    if (nextKind === kind) return;
    if (nextKind === '__new__') {
      apiRef.current?.postMessage({ type: 'createMacroKind' });
      // This sentinel intentionally leaves controlled state unchanged. Restore
      // the DOM now so the following native change event cannot post twice.
      event.currentTarget.value = kind;
      return;
    }
    markFormDirty();
    setKind(nextKind);
  };

  return (
    <MacroPreviewRuntimeProvider runtime={macroPreviewRuntime}>
      <main
        style={PANEL_STYLE}
        onInput={markFormDirty}
      >
      <PanelHeader
        vsApi={apiRef.current}
        title={t(panelMode === 'edit' ? 'editTitle' : 'createTitle', { package: titlePackage })}
        back={{ label: t('dashboard'), title: t('backToDashboard'), message: { type: 'nav.openDashboard' } }}
      />

      {/* --- Row 1: Name (1/4) | Kind (1/4) | Description (1/2) ------------- */}
      <div
        className="snl-responsive-grid--macro-header"
        style={{
          gap: '0.75rem',
          marginBottom: '1rem'
        }}
      >
        <div>
          <label htmlFor="m-name" style={labelStyle}>
            {t('name')}{' '}
            <span style={{ opacity: 0.6 }}>
              {t(panelMode === 'edit' ? 'readonly' : 'unique')}
            </span>
          </label>
          <NameEditor
            value={name}
            macroCandidates={macroCandidates}
            onChange={(next) => {
              markFormDirty();
              setName(next);
            }}
            readOnly={panelMode === 'edit'}
            invalid={isDuplicate}
            readOnlyTitle={t('immutableName')}
          />
        </div>
        <div>
          <label htmlFor="m-kind" style={labelStyle}>
            {t('kind')}
          </label>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <select
              id="m-kind"
              value={kind}
              onInput={commitKindSelection}
              onChange={commitKindSelection}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="">{t('unset')}</option>
              {macroKinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.id})
                </option>
              ))}
              <option value="__new__">{t('newMacroKind')}</option>
            </select>
            {kind
              ? (() => {
                  const sel = macroKinds.find((k) => k.id === kind);
                  if (!sel) return null;
                  const colors = resolveWebviewKindColoring(sel.coloring);
                  return (
                    <span
                      title={t('colorPreview', { stroke: colors.stroke, background: colors.background })}
                      style={{
                        display: 'inline-block',
                        width: '1.4rem',
                        height: '1.1rem',
                        borderRadius: '3px',
                        background: colors.background,
                        border: `2px solid ${colors.stroke}`,
                        flex: '0 0 auto'
                      }}
                    />
                  );
                })()
              : null}
          </div>
        </div>
        <div>
          <label htmlFor="m-desc" style={labelStyle}>
            {t('description')} <span style={{ opacity: 0.6 }}>{t('optional')}</span>
          </label>
          <input
            id="m-desc"
            type="text"
            value={description}
            placeholder={t('descriptionPlaceholder')}
            onChange={(e) => {
              markFormDirty();
              setDescription(e.target.value);
            }}
            style={{ ...inputStyle, width: '100%' }}
          />
        </div>
      </div>

      {/* --- Styles bar + style editor ------------------------------------- */}
      <StylesEditor
        styles={styles}
        setStyles={(next) => {
          markFormDirty();
          setStyles(next);
        }}
        activeStyle={activeStyle}
        setActiveStyle={setActiveStyle}
        patchStyle={patchStyle}
        hasDupTag={hasDupTag}
      />

      {/* --- Content tabs --------------------------------------------------- */}
      <SectionHeader title={t('contentStyle', { style: current?.style_name || 'default' })} />
      {current ? (
        <LocalizedEditScope
          resetKey={`${draftKey}:${activeStyle}`}
          initialLanguage={current.template_edit_language}
          availableLanguages={[...new Set([
            LOCALIZED_GENERAL_LANGUAGE,
            ...supportedLanguages.map((language) => language.id),
            ...(is_i18n(current.template_localized)
              ? Object.keys(current.template_localized.values)
              : [])
          ])]}
          onLanguageChange={setActiveTemplateLanguage}
        >
          <TemplateLanguageToolbar
            value={current.template_localized}
            onChange={replaceActiveLocalizedTemplate}
          />
        </LocalizedEditScope>
      ) : null}
      <TabList
        aria-label={t('contentStyle', { style: current?.style_name || 'default' })}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.25rem',
          marginBottom: '0.5rem'
        }}
      >
        {TABS.map((tab) => (
          <TabButton
            key={tab.id}
            active={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {t(tab.messageKey)}
            {tab.id === 'katex_template' && current?.mode !== 'block' && currentTemplate.trim().length === 0
              ? ' *'
              : ''}
          </TabButton>
        ))}
      </TabList>

      {/* --- Mode + Preview + template textarea ----------------------------
           Layout: [ Mode switcher (left, vertical) | Preview + Template (right) ]
           Only under the KaTeX template tab; other backends show plain textarea. */}
      {showPreview ? (
        <div
          className="snl-responsive-row"
          style={{
            display: 'flex',
            gap: '0.75rem',
            marginBottom: '1rem',
            alignItems: 'stretch'
          }}
        >
          {/* Left column: Mode switcher (vertical, matches Styles buttons). */}
          <ModeSwitcher
            value={current?.mode ?? 'formula_inline'}
            onChange={changeStyleMode}
          />
          {/* Right column: Preview + template body (grows). */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="snl-preview-canvas" style={{ marginBottom: '0.6rem' }}>
              <CollapsibleScope resetKey={DRAFT_KEY} label={t('macroPreview')}>
              <PreviewBoundary
                key={
                  previewTemplate +
                  dynamicArity +
                  (current?.mode ?? '') +
                  (current?.style_name ?? '') +
                  preferencesRevision
                }
                errorLabel={(error) => t('previewError', { error })}
              >
                <SnlSyntaxTreeView
                  tree={draftTree}
                  macro_data_driver={previewMacroDataDriver}
                  reader_runtime={webview_language_runtime}
                  hooks={hooks}
                  kindPalette={kindPalette}
                />
              </PreviewBoundary>
              </CollapsibleScope>
            </div>
            <p style={{ margin: '0 0.5rem', opacity: 0.75, fontSize: '0.8rem' }}>
              {t(current?.mode === 'block'
                ? 'blockModeHelp'
                : dynamicArity ? 'dynamicArityHelp' : 'latexTemplateHelp')}
            </p>
            {current?.mode === 'block' ? (
              // Block mode: template + variadic delimiters are all dead
              // data (block renderers walk node.children directly and
              // ignore both `template` and `variadic_*`). Cat 2026-07-10:
              // "delimiter 和 separator 在 block mode 下应该是没有用的,
              // 那就给它删掉."
              null
            ) : dynamicArity ? (
              <DynamicArityTemplateRow
                left={current?.template_left ?? ''}
                sep={current?.separator ?? ''}
                right={current?.template_right ?? ''}
                onLeft={(v) => patchStyle({ template_left: v })}
                onSep={(v) => patchStyle({ separator: v })}
                onRight={(v) => patchStyle({ template_right: v })}
              />
            ) : (
              <textarea
                value={currentTemplate}
                onChange={(e) => patchStyle({ template: e.target.value })}
                placeholder={t('katexPlaceholder', { arg0: '#0', arg1: '#1' })}
                rows={4}
                style={{
                  ...inputStyle,
                  width: '100%',
                  fontFamily: 'var(--vscode-editor-font-family, monospace)',
                  resize: 'vertical'
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <>
          {activeTab === 'typst_synthesis' ? (
            <SynthesisModeRow
              name="typst-synthesis-mode"
              value={current?.typst_synthesis_mode ?? 'formula'}
              onChange={(v) => patchStyle({ typst_synthesis_mode: v })}
            />
          ) : null}
          {activeTab === 'latex_synthesis' ? (
            <SynthesisModeRow
              name="latex-synthesis-mode"
              value={current?.latex_synthesis_mode ?? 'formula'}
              onChange={(v) => patchStyle({ latex_synthesis_mode: v })}
            />
          ) : null}
          <textarea
            value={(current?.[TAB_FIELD[activeTab]] as string) ?? ''}
            onChange={(e) =>
              patchStyle({ [TAB_FIELD[activeTab]]: e.target.value })
            }
            rows={6}
            style={{
              ...inputStyle,
              width: '100%',
              marginBottom: '1.25rem',
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              resize: 'vertical'
            }}
          />
        </>
      )}

      {/* --- Style-level Tags (collapsible, follows active style) ---------- */}
      <TagsEditor
        legend={t('styleTags', { style: current?.style_name || 'default' })}
        values={current?.tags ?? []}
        onChange={(next) => patchStyle({ tags: next })}
      />

      {/* --- Dynamic arity + Argument overrides ---------------------------- */}
      <div
        style={{
          marginBottom: '0.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem'
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            cursor: 'pointer',
            fontWeight: 600
          }}
        >
          <input
            type="checkbox"
            checked={dynamicArity}
            onChange={(e) => {
              const next = e.target.checked;
              markFormDirty();
              setDynamicArity(next);
              // When toggling ON: compose a #* template and synchronize the
              // formula-mode left/right projection fields before the textarea is
              // replaced by the dynamic editor. Text-mode projections are
              // transformed independently. When toggling OFF, compose the latest
              // delimiter edits back into the invariant formula template.
              setStyles((previous) => previous.map((style) => {
                const template_localized = mapTemplateProjections(
                  style.template_localized,
                  (projection) => toggleTemplateProjectionArity(projection, next)
                );
                const lookupLanguage = style.template_edit_language === LOCALIZED_GENERAL_LANGUAGE
                  ? (is_i18n(template_localized) ? template_localized.default_language : 'en')
                  : style.template_edit_language;
                return {
                  ...applyProjection(style, localizedTemplate(template_localized, lookupLanguage)),
                  template_localized
                };
              }));
            }}
          />
          {t('dynamicArity')}
        </label>
        <span style={{ opacity: 0.65, fontSize: '0.85rem' }}>
          {t('rendersAs', { expression: 'left + children.join(sep) + right' })}
        </span>
      </div>

      {/* --- Argument overrides during preview ----------------------------- */}
      <div
        style={{
          border: '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
          borderRadius: '4px',
          padding: '0.75rem',
          marginBottom: '1.25rem'
        }}
      >
        <Disclosure
          expanded={previewArgsOpen}
          controls="macro-preview-argument-overrides"
          onToggle={() => setPreviewArgsOpen((value) => !value)}
          style={{ width: '100%', justifyContent: 'flex-start', padding: 0 }}
        >
          {t('argumentOverrides')}
        </Disclosure>
        {previewArgsOpen ? (
          <div id="macro-preview-argument-overrides" style={{ marginTop: '0.65rem' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.4rem', marginBottom: '0.5rem' }}>
              {dynamicArity ? (
                <>
                  <Button size="sm"
                    onClick={() => setVariadicArgCount((n) => Math.min(n + 1, MAX_MACRO_PREVIEW_ARGS))}
                  >
                    {t('addArg')}
                  </Button>
                  <Button size="sm"
                    onClick={() => setVariadicArgCount((n) => Math.max(n - 1, 0))}
                  >
                    {t('removeArg')}
                  </Button>
                </>
              ) : null}
              <Button size="sm" onClick={resetArgs}>{t('resetArgs')}</Button>
            </div>

            {argCount === 0 ? (
              <p style={{ margin: 0, opacity: 0.7, fontSize: '0.85rem' }}>
                {dynamicArity ? t('noDynamicArgs') : t('noFixedArgs')}
              </p>
            ) : (
              Array.from({ length: argCount }).map((_, i) => (
                <div key={i} style={{ marginBottom: '0.4rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span
                      style={{
                        width: '3.5rem',
                        fontSize: '0.85rem',
                        opacity: 0.8,
                        fontFamily: 'var(--vscode-editor-font-family, monospace)'
                      }}
                    >
                      {t('argLabel', { index: i })}
                    </span>
                    <textarea
                      value={previewArgs[i] ?? ''}
                      rows={1}
                      placeholder={t('argPlaceholder', { index: i })}
                      onChange={(event) => setArg(i, event.target.value)}
                      style={{
                        ...inputStyle,
                        flex: 1,
                        fontFamily: 'var(--vscode-editor-font-family, monospace)',
                        resize: 'vertical',
                        borderColor: parseErrors[i]
                          ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
                          : undefined
                      }}
                    />
                  </div>
                  {parseErrors[i] ? (
                    <p
                      style={{
                        margin: '0.15rem 0 0 4rem',
                        fontSize: '0.78rem',
                        color: 'var(--vscode-errorForeground, #f48771)'
                      }}
                    >
                      {t('parseError', { error: parseErrors[i] ?? '' })}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      {/* --- Sources (moved to the bottom, above Submit) ------------------- */}
      <SectionHeader title={t('sources')} />
      <div
        className="snl-responsive-grid--two"
        style={{
          gap: '1rem',
          marginBottom: '1rem'
        }}
      >
        <EntryListEditor
          label={t('entries')}
          entryPool={entryPool}
          values={sourceEntries}
          onChange={(next) => {
            markFormDirty();
            setSourceEntries(next);
          }}
        />
        <ListEditor
          label={t('urls')}
          placeholder={t('urlPlaceholder')}
          values={sourceUrls}
          onChange={(next) => {
            markFormDirty();
            setSourceUrls(next);
          }}
          warnNonHttp
        />
      </div>

      {/* --- Macro-level Tags (collapsible, always shown) ------------------ */}
      <TagsEditor
        legend={t('macroTags')}
        values={macroTags}
        onChange={(next) => {
          markFormDirty();
          setMacroTags(next);
        }}
      />

      {/* --- Submit --------------------------------------------------------- */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!canCreate}
        >
          {status.kind === 'creating'
            ? t(panelMode === 'edit' ? 'updating' : 'creating')
            : t(panelMode === 'edit' ? 'updateMacro' : 'createMacro')}
        </Button>
        {/* 猫猫: 保存成功提示应放在按钮右侧 + 时间戳 + 5s 自动消失 */}
        <SavedInline status={status} />
        <span style={{ opacity: 0.6, fontSize: '0.85rem', marginLeft: 'auto' }}>
          {templateEmpty ? t('templateRequired') : ''}
        </span>
      </div>

      {/* Persistent errors stay visible until dismissed (only successes auto-dismiss). */}
      <StatusLine status={status} />
      </main>
    </MacroPreviewRuntimeProvider>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }): React.ReactElement {
  return (
    <h2
      style={{
        margin: '0 0 0.5rem',
        fontSize: '1.05rem',
        borderBottom:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        paddingBottom: '0.25rem'
      }}
    >
      {title}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Name editor — see 猫猫 2026-07-04 spec.
// ---------------------------------------------------------------------------
//
// Purpose: for dotted names like `Set.union`, break the single input into a
// row of small "namespace" chips (`Set`) followed by the final `name` chip
// (`union`), joined visually by `.` separators. The underlying data model
// is UNCHANGED — the parent still holds `name = 'Set.union'` in a plain
// string and the on-disk record is a plain string. We just make editing
// the head-namespace part of a dotted name a one-click affair.
//
// Behavior (all commits on blur / Enter, NOT while typing):
//   * `.` splits the chip into more chips ({left}.{right} → two chips, etc.).
//     If the split would create an empty middle chip that violates the empty
//     rule, we reject and keep the pre-edit value.
//   * An empty non-last chip is deleted (namespace segments must be non-empty).
//     The last chip is never deleted (a macro without a name is meaningless).
//   * Characters outside the shared SNL identifier policy fail validation with a
//     red border + error text; the invalid value is kept in state so the user
//     can fix it, and the parent's `onChange` gets the invalid joined string
//     (upstream validators will trip).
//
// Rendered as a single input when the name has no `.` at all (spec: "如果
// name 里没有 `.`，那么效果等同于这个功能不存在").

/** True if a single name/namespace segment is legal. Empty is NOT legal here. */
export function isValidNameSegment(seg: string): boolean {
  return isSnlIdentifier(seg) && !seg.includes('.');
}

/** Split a dotted name string into segments. Empty string → `['']` (one empty chip). */
function splitDotted(s: string): string[] {
  return s.length === 0 ? [''] : s.split('.');
}

function joinDotted(segments: string[]): string {
  return segments.join('.');
}

interface NameEditorProps {
  value: string;
  macroCandidates: readonly SnooglSearchCandidate[];
  onChange: (next: string) => void;
  readOnly?: boolean;
  invalid?: boolean;
  readOnlyTitle?: string;
}

export function NameEditor({
  value,
  macroCandidates,
  onChange,
  readOnly,
  invalid,
  readOnlyTitle
}: NameEditorProps): React.ReactElement {
  // `flat` = user is currently editing the whole ID as a single string.
  // Auto-flat when the value has no `.` (spec: no `.` → editor is invisible).
  // Otherwise chip-view. But we also let the user FORCE flat via the
  // "Edit whole ID" button on the right of the last chip — that's the
  // 2026-07-04-late "重新编辑" fix (猫猫 spec 1).
  //
  // We stay in flat mode across a value-round-trip that adds a `.` in the
  // middle of editing, so the user's caret survives typing `Set.union`
  // without React remounting the input into a two-chip row.
  const [forceFlat, setForceFlat] = useState(!value.includes('.'));

  // When the parent value goes empty (e.g. hydrateFromExisting on a new
  // macro), reset the "user typed a dot recently" latch so the next dot
  // typed will still land in a single input.
  //
  // When the parent value goes DOTTED via a source other than this editor
  // (e.g. loading an existing macro), snap to chip view — the user hasn't
  // been mid-typing, so no caret to protect.
  useEffect(() => {
    if (value.length === 0) {
      setForceFlat(true);
    } else if (value.includes('.') && !forceFlat) {
      // stay in chip view
    }
    // Intentionally NOT: else if (!value.includes('.')) setForceFlat(true)
    // — that would flip back to flat every render, which is fine but
    // redundant since the flat branch is entered on the next render anyway
    // via the `!value.includes('.')` guard below.
  }, [value]);

  const isFlat = forceFlat || !value.includes('.');

  if (isFlat) {
    return (
      <SingleNameInput
        value={value}
        macroCandidates={macroCandidates}
        onDraftChange={onChange}
        onCommit={(next) => {
          onChange(next);
          // Once the user commits (blur / Enter) with a `.`, drop out of
          // forced-flat so the chip view takes over on next edit. But not
          // if they explicitly hit the "Edit whole ID" button — that just
          // sets forceFlat=true and stays there until commit.
          if (next.includes('.')) {
            setForceFlat(false);
          }
        }}
        readOnly={readOnly}
        invalid={invalid}
        title={readOnly ? readOnlyTitle : undefined}
      />
    );
  }

  const segments = splitDotted(value);
  return (
    <MultiNameEditor
      segments={segments}
      macroCandidates={macroCandidates}
      onCommitSegments={(next) => onChange(joinDotted(next))}
      onEditWholeId={
        readOnly
          ? undefined
          : () => setForceFlat(true)
      }
      readOnly={readOnly}
      invalid={invalid}
      readOnlyTitle={readOnlyTitle}
    />
  );
}

/**
 * Plain input, used while the user is editing an ID as a single string.
 * Commits ONLY on blur or Enter — never on every keystroke — so typing a
 * mid-name `.` doesn't flip the parent's value halfway through and force
 * a re-mount into chip view (which would eat the caret). This matches
 * 猫猫's spec: "应当在编辑完成（比如 Enter 或者鼠标点击脱离编辑）以后
 * 再判定拆框."
 */
function SingleNameInput({
  value,
  macroCandidates,
  onDraftChange,
  onCommit,
  readOnly,
  invalid,
  title
}: {
  value: string;
  macroCandidates: readonly SnooglSearchCandidate[];
  onDraftChange: (v: string) => void;
  onCommit: (v: string) => void;
  readOnly?: boolean;
  invalid?: boolean;
  title?: string;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const [local, setLocal] = useState(value);
  // Parent state follows the draft for validation and submit enablement, while
  // this local value keeps the one-piece input mounted until blur/Enter.
  useEffect(() => setLocal(value), [value]);
  const commit = () => onCommit(local);
  return (
    <MacroIdInput
      id="m-name"
      value={local}
      macroCandidates={macroCandidates}
      placeholder={t('namePlaceholder')}
      onChange={(next) => {
        setLocal(next);
        onDraftChange(next);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      readOnly={readOnly}
      title={title}
      style={{
        ...inputStyle,
        width: '100%',
        borderColor: invalid
          ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
          : undefined,
        color: readOnly
          ? 'var(--vscode-descriptionForeground, #999)'
          : (inputStyle as React.CSSProperties).color,
        opacity: readOnly ? 0.7 : 1,
        cursor: readOnly ? 'not-allowed' : 'text'
      }}
    />
  );
}

function MultiNameEditor({
  segments,
  macroCandidates,
  onCommitSegments,
  onEditWholeId,
  readOnly,
  invalid,
  readOnlyTitle
}: {
  segments: string[];
  macroCandidates: readonly SnooglSearchCandidate[];
  onCommitSegments: (next: string[]) => void;
  /** If set, renders an "Edit whole ID" button beside the last chip. */
  onEditWholeId?: () => void;
  readOnly?: boolean;
  invalid?: boolean;
  readOnlyTitle?: string;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const [errIdx, setErrIdx] = useState<number | null>(null);
  const commitAt = (i: number, raw: string): void => {
    const parts = raw.split('.');
    // Validation gate: every non-empty part must be a valid segment.
    for (const p of parts) {
      if (p.length > 0 && !isValidNameSegment(p)) {
        setErrIdx(i);
        return;
      }
    }
    const next = segments.slice();
    next.splice(i, 1, ...parts);
    // Empty rule: a middle/head segment cannot be empty (except the sole
    // last chip — but we drop even that when it appears as an artifact of a
    // ".foo" input). Iterate right-to-left dropping empties past the last
    // slot; keep the last chip even if empty so the user can retype.
    const collapsed = next.filter((s, idx) => idx === next.length - 1 || s.length > 0);
    // If everything collapsed to just the last-empty chip AND that chip is
    // empty, still keep it — the parent's own name-empty validation applies.
    setErrIdx(null);
    onCommitSegments(collapsed.length > 0 ? collapsed : ['']);
  };
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          flexWrap: 'wrap',
          gap: '0.15rem'
        }}
      >
        {segments.map((seg, i) => {
          const isLast = i === segments.length - 1;
          return (
            <React.Fragment key={i}>
              <NameSegmentInput
                value={seg}
                macroCandidates={macroCandidates}
                isLast={isLast}
                errored={errIdx === i}
                invalidBorder={invalid && isLast}
                readOnly={readOnly}
                title={readOnly ? readOnlyTitle : undefined}
                onCommit={(v) => commitAt(i, v)}
                onFocus={() => setErrIdx(null)}
              />
              {!isLast ? (
                <span
                  aria-hidden
                  style={{
                    alignSelf: 'center',
                    opacity: 0.55,
                    padding: '0 0.15rem',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    userSelect: 'none'
                  }}
                >
                  .
                </span>
              ) : null}
            </React.Fragment>
          );
        })}
        {/* "Edit whole ID" — collapses the chip row back into a single
            input holding the joined string. For big-namespace-restructure
            edits where clicking chip-by-chip is awkward. 猫猫 spec 1
            (2026-07-04). */}
        {onEditWholeId ? (
          <Button
            type="button"
            onClick={onEditWholeId}
            title={t('editWholeTitle')}
            aria-label={t('editWholeAria')}
            style={{
              alignSelf: 'stretch',
              marginLeft: '0.25rem',
              padding: '0 0.5rem',
              border:
                '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              borderRadius: '3px',
              fontSize: '0.75rem',
              fontFamily: 'inherit',
              opacity: 0.75
            }}
          >
            {t('editWhole')}
          </Button>
        ) : null}
      </div>
      {errIdx !== null ? (
        <p
          style={{
            margin: '0.25rem 0 0',
            fontSize: '0.75rem',
            color: 'var(--vscode-errorForeground, #f48771)'
          }}
        >
          {t('invalidSegment', { braces: '{ }' })}
        </p>
      ) : null}
    </div>
  );
}

function NameSegmentInput({
  value,
  macroCandidates,
  isLast,
  errored,
  invalidBorder,
  readOnly,
  title,
  onCommit,
  onFocus
}: {
  value: string;
  macroCandidates: readonly SnooglSearchCandidate[];
  isLast: boolean;
  errored: boolean;
  invalidBorder?: boolean;
  readOnly?: boolean;
  title?: string;
  onCommit: (v: string) => void;
  onFocus?: () => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const commit = () => {
    if (local !== value) onCommit(local);
  };
  // Auto-size to content, but respect a floor so an empty chip is still
  // clickable. Approximates `<input size>` in CSS ch units so styling
  // matches the outer input frame.
  const chWidth = Math.max((local.length || 4) + 2, isLast ? 12 : 4);

  return (
    <MacroIdInput
      value={local}
      macroCandidates={macroCandidates}
      placeholder={t(isLast ? 'nameSegment' : 'namespaceSegment')}
      onChange={setLocal}
      onBlur={commit}
      onFocus={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      readOnly={readOnly}
      title={title}
      style={{
        ...inputStyle,
        width: `${chWidth}ch`,
        minWidth: '4ch',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        borderColor: errored || invalidBorder
          ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
          : isLast
            ? undefined
            : 'var(--vscode-panel-border, var(--vscode-contrastBorder, #666))',
        background: isLast
          ? 'var(--vscode-input-background, #2a2a2a)'
          : 'var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04))',
        color: readOnly
          ? 'var(--vscode-descriptionForeground, #999)'
          : (inputStyle as React.CSSProperties).color,
        opacity: readOnly ? 0.7 : 1,
        cursor: readOnly ? 'not-allowed' : 'text'
      }}
    />
  );
}

/**
 * Vertical Mode switcher — a stack of 4 buttons matching the horizontal
 * Styles bar's TabButton visual language (but with the active indicator on
 * the RIGHT edge instead of the bottom, and text horizontally centered — see
 * 猫猫 2026-07-04 UI note). Placed to the LEFT of the Preview + template
 * block. Uses `flex: 1` on each button so all four evenly split the outer
 * row's height and the group ends aligned with the bottom of the textarea.
 */
function ModeSwitcher({
  value,
  onChange
}: {
  value: Mode;
  onChange: (v: Mode) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        minWidth: '10rem'
      }}
      aria-label={t('renderMode')}
    >
      <div
        style={{
          fontSize: '0.8rem',
          fontWeight: 600,
          marginBottom: '0.15rem',
          opacity: 0.85
        }}
      >
        {t('mode')}
      </div>
      {MODE_ORDER.map((m) => (
        <div key={m} style={{ flex: 1, display: 'flex' }}>
          <ModeButton
            active={value === m}
            onClick={() => onChange(m)}
            label={t(MODE_MESSAGE_KEYS[m])}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * A single Mode row — a self-contained vertical-tab button with the active
 * indicator on the RIGHT edge and label horizontally centered. Uses
 * `width: 100%; height: 100%` so its flex parent (per-row cell in
 * {@link ModeSwitcher}) drives its size, keeping the 4 buttons evenly
 * distributed across the outer row height.
 *
 * Not folded into {@link TabButton} because that button is used inline in
 * horizontal styles bars and content tabs where the flex-grow / height-100
 * / vertical-indicator wart would be inappropriate.
 */
function ModeButton({
  active,
  onClick,
  label
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const inactiveBg = hover
    ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))'
    : 'var(--vscode-tab-inactiveBackground, transparent)';
  const activeBg = hover
    ? 'var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.09))'
    : 'var(--vscode-tab-activeBackground, #1e1e1e)';
  const defaultBorder =
    '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))';
  const accentBorder = '2px solid var(--vscode-focusBorder, #0e639c)';
  return (
    <Button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        height: '100%',
        padding: '0.3rem 0.7rem',
        border: defaultBorder,
        borderRight: active ? accentBorder : defaultBorder,
        background: active ? activeBg : inactiveBg,
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '3px 0 0 3px',
        fontFamily: 'inherit',
        fontSize: '0.85rem',
        fontWeight: active ? 600 : 400,
        transition: 'background 80ms ease',
        textAlign: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {label}
    </Button>
  );
}

/**
 * Dynamic-arity template row. The template itself is fixed to `#*` — see
 * the 2026-07-04 猫猫 spec: "Dynamic Arity 里用户必须输个 #* 完全没意义。
 * 直接把大文本框删了，只放三个 left/separator/right 就够了。真需要
 * 复杂结构的用户去拆多层宏（Matrix 那样）。"
 *
 * So we render only the three delimiter inputs side-by-side, and the caller
 * is responsible for making sure `style.template = '#*'` on save. Combined
 * with the library's dynamic-arity render path
 * (`template_left + join(children) + template_right`), this produces the
 * expected output for common shapes:
 *
 *   list :  template_left='['   sep=', '   template_right=']'
 *   pmatrix: template_left='\\begin{pmatrix}' sep=' \\\\ ' right='\\end{pmatrix}'
 */
function DynamicArityTemplateRow({
  left,
  sep,
  right,
  onLeft,
  onSep,
  onRight
}: {
  left: string;
  sep: string;
  right: string;
  onLeft: (v: string) => void;
  onSep: (v: string) => void;
  onRight: (v: string) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const monoField: React.CSSProperties = {
    ...inputStyle,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    flex: 1,
    minWidth: 0,
    width: '100%',
    resize: 'vertical'
  };
  return (
    <div
      className="snl-responsive-row"
      style={{
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'stretch'
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <label htmlFor="dynamic-arity-left" style={{ ...labelStyle, fontSize: '0.75rem', opacity: 0.75 }}>
          {t('leftDelimiter')}
        </label>
        <textarea
          id="dynamic-arity-left"
          value={left}
          placeholder={t('leftDelimiterPlaceholder', { environment: '{pmatrix}' })}
          onChange={(e) => onLeft(e.target.value)}
          rows={3}
          style={monoField}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <label htmlFor="dynamic-arity-separator" style={{ ...labelStyle, fontSize: '0.75rem', opacity: 0.75 }}>
          {t('separator')}
        </label>
        <textarea
          id="dynamic-arity-separator"
          value={sep}
          placeholder={t('separatorPlaceholder')}
          onChange={(e) => onSep(e.target.value)}
          rows={3}
          style={monoField}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <label htmlFor="dynamic-arity-right" style={{ ...labelStyle, fontSize: '0.75rem', opacity: 0.75 }}>
          {t('rightDelimiter')}
        </label>
        <textarea
          id="dynamic-arity-right"
          value={right}
          placeholder={t('rightDelimiterPlaceholder', { environment: '{pmatrix}' })}
          onChange={(e) => onRight(e.target.value)}
          rows={3}
          style={monoField}
        />
      </div>
    </div>
  );
}

/**
 * Reusable collapsible tags editor. Backslash-forbidden strings only —
 * validation is done on-input; a red border appears on offending rows.
 * Used at both style and macro level.
 */
function TagsEditor({
  legend,
  values,
  onChange
}: {
  legend: string;
  values: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const [expanded, setExpanded] = useState(false);
  const set = (i: number, v: string): void => {
    const next = values.slice();
    next[i] = v;
    onChange(next);
  };
  const add = (): void => onChange([...values, '']);
  const remove = (i: number): void => {
    const next = values.filter((_, idx) => idx !== i);
    onChange(next);
  };
  const summary = values.length === 0 ? t('none') : t('tagCount', { count: values.length });
  return (
    <div
      style={{
        marginBottom: '1rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        borderRadius: '4px',
        padding: '0.5rem 0.75rem'
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((e) => !e)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          userSelect: 'none'
        }}
      >
        <strong style={{ fontSize: '0.9rem' }}>
          <span style={{ opacity: 0.7, marginRight: '0.35rem' }}>
            {expanded ? '▾' : '▸'}
          </span>
          {legend}{' '}
          <span style={{ opacity: 0.65, fontWeight: 400 }}>— {summary}</span>
        </strong>
      </div>
      {expanded ? (
        <div style={{ marginTop: '0.5rem' }}>
          {values.length === 0 ? (
            <p style={{ margin: '0 0 0.4rem', opacity: 0.7, fontSize: '0.85rem' }}>
              {t('noTags')}
            </p>
          ) : (
            values.map((v, i) => {
              const bad = v.includes('\\');
              return (
                <div
                  key={i}
                  style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.3rem' }}
                >
                  <input
                    type="text"
                    value={v}
                    placeholder={t('tagPlaceholder')}
                    onChange={(e) => set(i, e.target.value)}
                    style={{
                      ...inputStyle,
                      flex: 1,
                      borderColor: bad
                        ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
                        : undefined
                    }}
                  />
                  <IconButton
                    icon="delete"
                    label={t('removeTag', { index: i + 1 })}
                    variant="destructive"
                    size="sm"
                    onClick={() => remove(i)}
                  />
                </div>
              );
            })
          )}
          <Button size="sm" onClick={add}>{t('addTag')}</Button>
        </div>
      ) : null}
    </div>
  );
}

function languageDisplayName(
  language: string,
  catalog: readonly { id: string; display_name: string }[] = BUILT_IN_LANGUAGE_CATALOG,
  generalLabel = 'General'
): string {
  if (language === LOCALIZED_GENERAL_LANGUAGE) return generalLabel;
  return catalog.find((item) => item.id === language)?.display_name ?? language;
}

function MacroLanguageSelector({
  languages, value, label, onChange, catalog = BUILT_IN_LANGUAGE_CATALOG
}: {
  languages: string[];
  value: string;
  label: string;
  onChange: (language: string) => void;
  catalog?: readonly { id: string; display_name: string }[];
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  return (
    <LocalizedLanguageSelector
      languages={languages}
      value={value}
      label={label}
      generalLanguage={LOCALIZED_GENERAL_LANGUAGE}
      generalLabel={t('generalLanguage')}
      onChange={onChange}
      catalog={catalog}
    />
  );
}

function TemplateLanguageToolbar({
  value,
  onChange
}: {
  value: Localized<string, TemplateProjectionDraft>;
  onChange(value: Localized<string, TemplateProjectionDraft>): void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const supportedLanguages = use_supported_languages();
  const local = useLocalizedEditLanguage();
  const binding = useLocalizedBinding({ value, onChange, defaultLanguage: 'en' });
  const status = binding.state === 'explicit'
    ? t('localizedExplicit')
    : binding.state === 'fallback'
      ? t('localizedFallback', {
          language: languageDisplayName(binding.sourceLanguage ?? '', supportedLanguages)
        })
      : binding.state === 'invariant'
        ? t('localizedInvariant')
        : t('localizedMissing');
  return <div style={{ marginBottom: '0.55rem' }}>
    <h4 style={{ margin: '0 0 0.35rem' }}>{t('templateI18nHeading')}</h4>
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center',
      justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <MacroLanguageSelector
        languages={[...local.availableLanguages]}
        value={local.language}
        label={t('language')}
        onChange={local.setLanguage}
        catalog={supportedLanguages}
      />
      <span style={{ fontSize: '0.75rem', opacity: 0.7 }}>{status}</span>
      {binding.canClear ? <Button size="sm" onClick={binding.clearValue}>
        {t('clearTranslation')}
      </Button> : null}
    </div>
  </div>;
}

function StylesEditor({
  styles,
  setStyles,
  activeStyle,
  setActiveStyle,
  patchStyle,
  hasDupTag
}: {
  styles: StyleDraft[];
  setStyles: React.Dispatch<React.SetStateAction<StyleDraft[]>>;
  activeStyle: number;
  setActiveStyle: (i: number) => void;
  patchStyle: (patch: Partial<StyleDraft>) => void;
  hasDupTag: boolean;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const current = styles[activeStyle] ?? styles[0];

  const addStyle = (): void => {
    const existing = new Set(styles.map((style) => style.style_name));
    let index = styles.length;
    let name = `style${index}`;
    while (existing.has(name)) name = `style${++index}`;
    setStyles([...styles, newStyleDraft(name)]);
    setActiveStyle(styles.length);
  };

  const removeStyle = (index: number): void => {
    if (styles.length <= 1) return;
    const next = styles.filter((_, candidate) => candidate !== index);
    setStyles(next);
    setActiveStyle(Math.max(0, Math.min(activeStyle, next.length - 1)));
  };

  const moveUp = (index: number): void => {
    if (index <= 0) return;
    const next = styles.slice();
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setStyles(next);
    if (activeStyle === index) setActiveStyle(index - 1);
    else if (activeStyle === index - 1) setActiveStyle(index);
  };

  return <>
    <SectionHeader title={t('styles')} />
    <div role="group" aria-label={t('styles')}
      style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
      {styles.map((style, index) => <div key={index}
        style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
        <StyleSwitch
          tag={style.style_name}
          active={index === activeStyle}
          isDefault={index === 0}
          onSelect={() => setActiveStyle(index)}
          onRename={(name) => setStyles((previous) => previous.map((candidate, candidateIndex) =>
            candidateIndex === index ? { ...candidate, style_name: name } : candidate))}
        />
        {index > 0 ? <IconButton icon="move-up" label={t('moveEarlier')} size="sm"
          onClick={() => moveUp(index)} /> : null}
        {styles.length > 1 ? <IconButton icon="delete"
          label={t('removeStyle', { style: style.style_name || t('emptyStyle') })}
          variant="destructive" size="sm" onClick={() => removeStyle(index)} /> : null}
      </div>)}
      <Button size="sm" onClick={addStyle}>{t('addStyle')}</Button>
    </div>
    {hasDupTag ? <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem',
      color: 'var(--vscode-errorForeground, #f48771)' }}>{t('duplicateStyleTags')}</p> : null}
    <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', opacity: 0.6 }}>
      {t('fallbackHelp')}
    </p>
    {current?.mode === 'block' ? <BlockRendererPresetControl
      value={current.block_template_name ?? ''}
      onChange={(value) => patchStyle({ block_template_name: value })}
      imagePathDraft={current.image_path_draft}
      imagePathInvalid={current.image_path_invalid}
      onImagePathDraftChange={(draft, invalid) => patchStyle({
        image_path_draft: draft,
        image_path_invalid: invalid
      })}
      tableOptions={current.table_options}
      onTableOptionsChange={(table_options) => patchStyle({ table_options })}
    /> : null}
  </>;
}

/**
 * Block renderer presets available in this Extension.
 *
 * The first four come from SNL-Basics's built-in `defaultRenderers`. The rest
 * are registered by THIS Extension in `webview/src/render/blockRenderers.tsx`
 * (`extensionRenderers`), so they only work on surfaces that pass that
 * registry as `hooks.renderers`.
 */
const BLOCK_RENDERER_PRESETS: ReadonlyArray<{
  key: string;
  hintKey: 'presetListHint' | 'presetEnumerateHint' | 'presetTableHint' | 'presetCenteredHint' | 'presetCollapsibleHint' | 'presetImageHint';
}> = [
  // Render preset keys are protocol tokens and remain language-invariant.
  { key: 'list', hintKey: 'presetListHint' },
  { key: 'enumerate', hintKey: 'presetEnumerateHint' },
  { key: 'table', hintKey: 'presetTableHint' },
  { key: 'centered', hintKey: 'presetCenteredHint' },
  { key: 'collapsible', hintKey: 'presetCollapsibleHint' },
  { key: 'image', hintKey: 'presetImageHint' }
];
const PRESET_KEYS = new Set(BLOCK_RENDERER_PRESETS.map((p) => p.key));

/**
 * Compact select-with-escape-hatch for the block-mode `block_template_name`.
 * Value states:
 *   - '' (unset)       → nothing shipped in the JSON; renderer falls
 *                        back to plain block layout.
 *   - preset key       → dropdown showing that preset selected.
 *   - unknown string   → "Custom" mode, freeform input pre-filled.
 */
export function BlockRendererPresetControl({
  value,
  onChange,
  imagePathDraft: controlledImagePathDraft,
  imagePathInvalid: controlledImagePathInvalid = false,
  onImagePathDraftChange,
  tableOptions: controlledTableOptions,
  onTableOptionsChange
}: {
  value: string;
  onChange: (v: string) => void;
  imagePathDraft?: string;
  imagePathInvalid?: boolean;
  onImagePathDraftChange?: (draft: string, invalid: boolean) => void;
  tableOptions?: TableTemplateOptions;
  onTableOptionsChange?: (options: TableTemplateOptions) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  let spec: { name: string; params: Record<string, string> };
  try {
    spec = value ? parseBlockRendererSpec(value) : { name: '', params: {} };
  } catch {
    spec = { name: value, params: {} };
  }
  const [mode, setMode] = useState<'preset' | 'custom' | 'unset'>(() => {
    if (!value) return 'unset';
    return PRESET_KEYS.has(spec.name) ? 'preset' : 'custom';
  });
  const [localImagePathDraft, setLocalImagePathDraft] = useState(spec.params.src ?? '');
  const [localImagePathError, setLocalImagePathError] = useState(false);
  const imagePathControlled = controlledImagePathDraft !== undefined;
  const imagePathDraft = imagePathControlled ? controlledImagePathDraft : localImagePathDraft;
  const imagePathError = imagePathControlled
    ? controlledImagePathInvalid
    : localImagePathError;
  const setImageDraft = (draft: string, invalid: boolean): void => {
    if (!imagePathControlled) {
      setLocalImagePathDraft(draft);
      setLocalImagePathError(invalid);
    }
    onImagePathDraftChange?.(draft, invalid);
  };

  // If the parent's value changes out from under us (e.g. loading a
  // different style), resync the mode.
  useEffect(() => {
    if (!value) setMode('unset');
    else if (PRESET_KEYS.has(spec.name)) setMode('preset');
    else setMode('custom');
  }, [spec.name, value]);
  useEffect(() => {
    if (imagePathControlled) return;
    if (value === 'image' && imagePathError) return;
    setLocalImagePathDraft(spec.params.src ?? '');
    setLocalImagePathError(false);
  }, [imagePathControlled, value]);

  const selectedPreset = mode === 'preset' ? spec.name : '';
  const selectedControl = mode === 'unset' ? '' : mode === 'custom' ? '__custom__' : selectedPreset;
  const commitPreset = (event: React.FormEvent<HTMLSelectElement>): void => {
    const next = event.currentTarget.value;
    if (next === selectedControl) return;
    if (next === '') {
      setMode('unset');
      onChange('');
    } else if (next === '__custom__') {
      setMode('custom');
      if (PRESET_KEYS.has(spec.name) || !value) onChange('');
    } else {
      setMode('preset');
      onChange(next);
    }
  };
  const commitNumbering = (event: React.FormEvent<HTMLSelectElement>): void => {
    const marker = event.currentTarget.value;
    if (marker === (spec.params.marker ?? 'decimal')) return;
    onChange(serializeBlockRendererSpec('enumerate', { marker }));
  };
  const commitImageLayout = (event: React.FormEvent<HTMLSelectElement>): void => {
    const layout = event.currentTarget.value;
    if (!spec.params.src || layout === (spec.params.layout ?? 'block')) return;
    onChange(serializeBlockRendererSpec('image', {
      src: spec.params.src,
      layout,
      alt: spec.params.alt ?? ''
    }));
  };
  const emptyTableColors = (): TableCssColors => ({
    color: '', background: '', border: ''
  });
  const tableOptions: TableTemplateOptions = controlledTableOptions ?? {
    composition: 'rows',
    css: { light: emptyTableColors(), dark: emptyTableColors() }
  };
  const tableCss = tableOptions.css ?? {
    light: emptyTableColors(), dark: emptyTableColors()
  };
  const patchTableColor = (
    scheme: 'light' | 'dark',
    key: keyof TableCssColors,
    color: string
  ): void => {
    onTableOptionsChange?.({
      ...tableOptions,
      css: {
        ...tableCss,
        [scheme]: { ...tableCss[scheme], [key]: color }
      }
    });
  };

  const hint =
    mode === 'preset'
      ? (() => {
          const hintKey = BLOCK_RENDERER_PRESETS.find((p) => p.key === spec.name)?.hintKey;
          if (!hintKey) return '';
          if (hintKey === 'presetListHint') {
            return t(hintKey, { environment: '{itemize}' });
          }
          if (hintKey === 'presetEnumerateHint') {
            return t(hintKey, { environment: '{enumerate}' });
          }
          return t(hintKey);
        })()
      : t(mode === 'custom' ? 'customRenderHint' : 'noRenderHint');

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor="m-rkey-preset" style={labelStyle}>
        {t('renderPreset')}
      </label>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          id="m-rkey-preset"
          value={selectedControl}
          onInput={commitPreset}
          onChange={commitPreset}
          style={{ ...inputStyle, width: 'auto', minWidth: '10rem' }}
        >
          <option value="">{t('presetNone')}</option>
          {BLOCK_RENDERER_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key}
            </option>
          ))}
          <option value="__custom__">{t('customKey')}</option>
        </select>
        {mode === 'custom' ? (
          <input
            type="text"
            value={value}
            placeholder="my-renderer-key"
            onChange={(e) => onChange(e.target.value)}
            style={{ ...inputStyle, width: '16rem' }}
          />
        ) : null}
      </div>
      {mode === 'preset' && spec.name === 'enumerate' ? (
        <label style={{ ...labelStyle, marginTop: '0.5rem' }}>
          {t('numbering')}
          <select aria-label={t('numbering')}
            value={spec.params.marker ?? 'decimal'}
            onInput={commitNumbering}
            onChange={commitNumbering}
            style={{ ...inputStyle, display: 'block', marginTop: '0.25rem' }}>
            <option value="decimal">{t('numberingDecimal')}</option>
            <option value="lower-alpha">{t('numberingLowerAlpha')}</option>
            <option value="upper-alpha">{t('numberingUpperAlpha')}</option>
            <option value="disc">{t('numberingDots')}</option>
            <option value="ellipsis">{t('numberingEllipsis')}</option>
          </select>
        </label>
      ) : null}
      {mode === 'preset' && spec.name === 'table' ? (
        <div style={{ marginTop: '0.5rem' }}>
          <label style={labelStyle}>
            {t('tableComposition')}
            <select
              aria-label={t('tableComposition')}
              value={tableOptions.composition}
              onInput={(event) => onTableOptionsChange?.({
                ...tableOptions,
                composition: event.currentTarget.value === 'cells' ? 'cells' : 'rows'
              })}
              onChange={(event) => onTableOptionsChange?.({
                ...tableOptions,
                composition: event.currentTarget.value === 'cells' ? 'cells' : 'rows'
              })}
              style={{ ...inputStyle, display: 'block', marginTop: '0.25rem' }}
            >
              <option value="rows">{t('tableRows')}</option>
              <option value="cells">{t('tableCells')}</option>
            </select>
          </label>
          {(['light', 'dark'] as const).map((scheme) => (
            <fieldset key={scheme} style={{
              margin: '0.65rem 0 0', padding: '0.6rem',
              border: '1px solid var(--vscode-panel-border, #555)'
            }}>
              <legend>{t(scheme === 'light' ? 'tableLight' : 'tableDark')}</legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.5rem' }}>
                <ColorField
                  label={`${t(scheme === 'light' ? 'tableLight' : 'tableDark')} ${t('tableTextColor')}`}
                  value={tableCss[scheme].color}
                  onChange={(value) => patchTableColor(scheme, 'color', value)}
                />
                <ColorField
                  label={`${t(scheme === 'light' ? 'tableLight' : 'tableDark')} ${t('tableBackgroundColor')}`}
                  value={tableCss[scheme].background}
                  onChange={(value) => patchTableColor(scheme, 'background', value)}
                />
                <ColorField
                  label={`${t(scheme === 'light' ? 'tableLight' : 'tableDark')} ${t('tableBorderColor')}`}
                  value={tableCss[scheme].border}
                  onChange={(value) => patchTableColor(scheme, 'border', value)}
                />
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}
      {mode === 'preset' && spec.name === 'image' ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          <label style={{ ...labelStyle, flex: '1 1 16rem' }}>
            {t('imagePath')}
            <input aria-label={t('imagePath')} value={imagePathDraft}
              placeholder="figures/diagram.png"
              onChange={(event) => {
                const path = event.target.value;
                if (!path) {
                  setImageDraft(path, false);
                  onChange('image');
                  return;
                }
                try {
                  onChange(serializeBlockRendererSpec('image', {
                    src: path,
                    layout: spec.params.layout ?? 'block',
                    alt: spec.params.alt ?? ''
                  }));
                  setImageDraft(path, false);
                } catch {
                  setImageDraft(path, true);
                  onChange('image');
                }
              }}
              style={{ ...inputStyle, display: 'block', width: '100%', marginTop: '0.25rem' }} />
            {!spec.params.src || imagePathError ? (
              <span className="snl-field-error" role="alert">
                {t(imagePathError ? 'imagePathInvalid' : 'imagePathRequired')}
              </span>
            ) : null}
          </label>
          <label style={labelStyle}>
            {t('imageLayout')}
            <select aria-label={t('imageLayout')} value={spec.params.layout ?? 'block'}
              onInput={commitImageLayout}
              onChange={commitImageLayout}
              style={{ ...inputStyle, display: 'block', marginTop: '0.25rem' }}>
              <option value="inline">{t('imageInline')}</option>
              <option value="block">{t('imageBlock')}</option>
            </select>
          </label>
          <label style={{ ...labelStyle, flex: '1 1 16rem' }}>
            {t('imageAlt')}
            <input aria-label={t('imageAlt')} value={spec.params.alt ?? ''}
              placeholder="diagram"
              onChange={(event) => {
                if (!spec.params.src) return;
                onChange(serializeBlockRendererSpec('image', {
                  src: spec.params.src,
                  layout: spec.params.layout ?? 'block',
                  alt: event.target.value
                }));
              }}
              style={{ ...inputStyle, display: 'block', width: '100%', marginTop: '0.25rem' }} />
          </label>
        </div>
      ) : null}
      <p style={{ margin: '0.3rem 0 0', fontSize: '0.75rem', opacity: 0.65 }}>
        {hint}
      </p>
    </div>
  );
}

/**
 * A single style-bar button. Single click → select. Double click → inline
 * rename (backed by a plain text input; Enter/blur commits, Esc cancels).
 */
function StyleSwitch({
  tag,
  active,
  isDefault,
  onSelect,
  onRename
}: {
  tag: string;
  active: boolean;
  isDefault: boolean;
  onSelect: () => void;
  onRename: (next: string) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(tag);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, tag]);

  const commit = (): void => {
    const next = draft.trim();
    if (next.length > 0 && next !== tag) {
      onRename(next);
    }
    setEditing(false);
  };
  const cancel = (): void => {
    setDraft(tag);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        style={{
          padding: '0.3rem 0.7rem',
          border: '1px solid var(--vscode-focusBorder, #0e639c)',
          borderRadius: '3px 3px 0 0',
          background: 'var(--vscode-input-background, #2a2a2a)',
          color: 'var(--vscode-input-foreground, #ddd)',
          fontFamily: 'inherit',
          fontSize: '0.85rem',
          fontWeight: 600,
          minWidth: '6rem'
        }}
      />
    );
  }

  return (
    <Button
      size="md"
      variant={active ? 'primary' : 'secondary'}
      aria-pressed={active}
      aria-label={tag.trim() || t('emptyStyle')}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      title={t('renameStyle')}
    >
      {tag.trim() || t('emptyStyle')}
      {isDefault ? ' ★' : ''}
    </Button>
  );
}

/**
 * Same "list of strings with +Add / − Remove" affordance as {@link ListEditor},
 * but each row's input is an {@link EntityIdSearchBox} bound to the shared
 * entry pool. Used by the macro editor's `source.entries` section — cat
 * 2026-07-09: agent workers were pasting raw entry ids and typoing them, so
 * the picker enforces "resolve to a real entry" (lookup-only, `allowNew`
 * off; commit action only fires on match).
 *
 * Persistence semantics identical to ListEditor: `values` is a string[]
 * (each element an entry id or empty string), the parent trims + filters
 * empty before submit. We keep at least one empty row so users can add the
 * first entry without hunting for a button.
 */
function EntryListEditor({
  label,
  entryPool,
  values,
  onChange
}: {
  label: string;
  entryPool: EntryOption[];
  values: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const set = (i: number, v: string): void => {
    const next = values.slice();
    next[i] = v;
    onChange(next);
  };
  const add = (): void => onChange([...values, '']);
  const remove = (i: number): void => {
    const next = values.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : ['']);
  };
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {values.map((v, i) => (
        <div key={i} style={{ marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <EntityIdSearchBox
                entries={entryPool}
                value={v}
                onChange={(next) => set(i, next)}
                placeholder={t('searchEntry')}
              />
            </div>
            <IconButton
              icon="delete"
              label={t('removeEntrySource', { index: i + 1 })}
              variant="destructive"
              size="sm"
              onClick={() => remove(i)}
            />
          </div>
        </div>
      ))}
      <Button size="sm" onClick={add}>{t('add')}</Button>
    </div>
  );
}

function ListEditor({
  label,
  placeholder,
  values,
  onChange,
  warnNonHttp
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
  warnNonHttp?: boolean;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const set = (i: number, v: string): void => {
    const next = values.slice();
    next[i] = v;
    onChange(next);
  };
  const add = (): void => onChange([...values, '']);
  const remove = (i: number): void => {
    const next = values.filter((_, idx) => idx !== i);
    onChange(next.length > 0 ? next : ['']);
  };
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {values.map((v, i) => {
        const warn =
          warnNonHttp && v.trim().length > 0 && !v.trim().startsWith('http');
        return (
          <div key={i} style={{ marginBottom: '0.35rem' }}>
            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <input
                type="text"
                value={v}
                placeholder={placeholder}
                onChange={(e) => set(i, e.target.value)}
                style={{ ...inputStyle, flex: 1 }}
              />
              <IconButton
                icon="delete"
                label={t('removeUrlSource', { index: i + 1 })}
                variant="destructive"
                size="sm"
                onClick={() => remove(i)}
              />
            </div>
            {warn ? (
              <p
                style={{
                  margin: '0.1rem 0 0',
                  fontSize: '0.75rem',
                  color: 'var(--vscode-editorWarning-foreground, #cca700)'
                }}
              >
                {t('nonHttp')}
              </p>
            ) : null}
          </div>
        );
      })}
      <Button size="sm" onClick={add}>{t('add')}</Button>
    </div>
  );
}

function RadioGroup({
  legend,
  name,
  value,
  options,
  onChange
}: {
  legend: string;
  name: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <fieldset
      style={{
        border: 'none',
        margin: 0,
        padding: 0
      }}
    >
      <legend style={{ ...labelStyle, padding: 0 }}>{legend}</legend>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        {options.map((opt) => (
          <label
            key={opt.value}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              cursor: 'pointer'
            }}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SynthesisModeRow({
  name,
  value,
  onChange
}: {
  name: string;
  value: SynthesisMode;
  onChange: (v: SynthesisMode) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <RadioGroup
        legend={t('synthesisMode')}
        name={name}
        value={value}
        options={[
          { value: 'formula', label: t('synthesisFormula') },
          { value: 'text', label: t('synthesisText') }
        ]}
        onChange={(v) => onChange(v as SynthesisMode)}
      />
    </div>
  );
}

/** Catches render-time throws from the preview (e.g. a KaTeX failure). */
class PreviewBoundary extends React.Component<
  { children: React.ReactNode; errorLabel: (error: string) => string },
  { error: string | null }
> {
  constructor(props: { children: React.ReactNode; errorLabel: (error: string) => string }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            color: '#8a1f11',
            fontSize: '0.85rem',
            fontFamily: 'var(--vscode-editor-font-family, monospace)'
          }}
        >
          {this.props.errorLabel(this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

function twoDigit(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatSavedAt(ts: number): string {
  const d = new Date(ts);
  return `${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}:${twoDigit(d.getSeconds())}`;
}

/**
 * Inline "saved" banner shown to the right of the submit button (猫猫 req).
 * Shows a green check + macro name + parenthesized wall-clock time. Auto-
 * dismissed by the parent's useEffect after 5s.
 */
function SavedInline({ status }: { status: Status }): React.ReactElement | null {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  if (status.kind !== 'created' && status.kind !== 'updated') {
    return null;
  }
  const savedText = t(status.kind === 'created' ? 'createdStatus' : 'updatedStatus', { name: status.name });
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        fontSize: '0.85rem',
        fontWeight: 600,
        color: 'var(--vscode-testing-iconPassed, #89d185)'
      }}
    >
      <span>✓</span>
      <span>{savedText}</span>
      <span style={{ opacity: 0.75, fontWeight: 400 }}>
        ({formatSavedAt(status.at)})
      </span>
    </span>
  );
}

/**
 * Persistent status banner — only rendered for ERROR-shaped statuses
 * (duplicate / notFound / invalid / noFile / noWorkspace / noSnlDoc / error).
 * Success statuses are handled by {@link SavedInline} + auto-dismiss.
 */
function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  if (
    status.kind === 'idle' ||
    status.kind === 'creating' ||
    status.kind === 'created' ||
    status.kind === 'updated'
  ) {
    return null;
  }
  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'duplicate') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'notFound') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'invalid') {
    text = t('invalidStatus', { reason: status.reason });
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noFile' ||
    status.kind === 'noWorkspace' ||
    status.kind === 'noSnlDoc'
  ) {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = t('errorStatus', { message: status.message });
    color = 'var(--vscode-errorForeground, #f48771)';
  }
  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
