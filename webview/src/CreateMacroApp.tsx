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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  editorDraftKey,
  loadDraft,
  saveDraft,
  usePersistedDraft,
  useSaveShortcut
} from './components/draftState';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
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
  type KindPalette
} from '@sjtu-ai4math/snl-basics';
import {
  createMacroDataDriver,
  type MacroRecord
} from './render/macroData';
import { extensionRenderers } from './render/blockRenderers';
import {
  useVsCodeApiRef,
  PANEL_STYLE
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { MissingEditorTarget } from './components/MissingEditorTarget';
import { Button } from './components/Button';
import { MacroIdInput } from './components/MacroIdInput';
import { EntityIdSearchBox } from './components/EntityIdSearchBox';
import type { EntryOption } from './render/EntryRender';
import { areEntityReferencesResolved } from './components/formValidation';
import {
  use_preferences_revision,
  webview_language_runtime
} from './runtime/preferencesRuntime';
import type { SnooglSearchCandidate } from '../../src/snooglSearch';
import { defineUiMessages, useUiMessages } from './i18n/uiMessages';

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
    modeText: 'Text',
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
    styles: 'Styles',
    moveEarlier: 'Move earlier (toward default)',
    addStyle: '+ Add style',
    duplicateStyleTags: 'Duplicate style tags — each style tag must be unique.',
    fallbackHelp: '★ = final fallback (styles[0]). Implicit rendering first uses the current language mapping, then English, then this fallback. Explicit [style] always wins.',
    defaultStyleByLanguage: 'Default style by language',
    useStylesZero: 'Use styles[0]',
    useEnglishStylesZero: 'Use English / styles[0]',
    languagePlaceholder: 'Language tag, e.g. fr',
    addLanguage: '+ Add language',
    renderPreset: 'Render preset',
    presetNone: '— none —',
    customKey: 'Custom key…',
    customRenderHint: 'Custom render key — consumer must register a matching renderer. Empty key = no dispatch.',
    noRenderHint: 'No render preset. The block will render with plain default layout.',
    presetListHint: 'Unordered list — LaTeX \\begin{environment} → <ul><li>…',
    presetEnumerateHint: 'Ordered list — LaTeX \\begin{environment} → <ol><li>…',
    presetTableHint: 'Table — variadic children are rows; the first child with kind="table-header" becomes <thead>.',
    presetCenteredHint: 'Horizontally-centered block wrapper.',
    presetCollapsibleHint: 'Collapsible block — the first child is the always-visible summary; the rest fold behind a toggle.',
    emptyStyle: '(empty)',
    renameStyle: 'Double-click to rename',
    searchEntry: 'Search entry id or title…',
    add: '+ Add',
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
    modeText: '文本',
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
    styles: '样式',
    moveEarlier: '向前移动（靠近默认样式）',
    addStyle: '+ 添加样式',
    duplicateStyleTags: '样式标签重复；每个样式标签必须唯一。',
    fallbackHelp: '★ = 最终回退样式（styles[0]）。隐式渲染会依次使用当前语言映射、英语映射和此回退样式；显式 [style] 始终优先。',
    defaultStyleByLanguage: '按语言设置默认样式',
    useStylesZero: '使用 styles[0]',
    useEnglishStylesZero: '使用英语映射 / styles[0]',
    languagePlaceholder: '语言标签，例如 fr',
    addLanguage: '+ 添加语言',
    renderPreset: '渲染预设',
    presetNone: '— 无 —',
    customKey: '自定义键…',
    customRenderHint: '自定义渲染键 — 使用方必须注册匹配的渲染器。空键表示不分派。',
    noRenderHint: '未设置渲染预设；该块将使用普通默认布局。',
    presetListHint: '无序列表 — LaTeX \\begin{environment} → <ul><li>…',
    presetEnumerateHint: '有序列表 — LaTeX \\begin{environment} → <ol><li>…',
    presetTableHint: '表格 — 可变参数子节点作为行；kind="table-header" 的第一个子节点会成为 <thead>。',
    presetCenteredHint: '水平居中的块包装器。',
    presetCollapsibleHint: '可折叠块 — 第一个子节点始终显示为摘要，其余内容收起在切换按钮后。',
    emptyStyle: '（空）',
    renameStyle: '双击重命名',
    searchEntry: '搜索条目 ID 或标题…',
    add: '+ 添加',
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
    default_style: { en: 'default' },
    tags: [],
    styles: [
      {
        style_name: 'default',
        mode: 'text',
        template: label,
        tags: []
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

type Mode = 'formula_inline' | 'formula_display' | 'text' | 'block';
type SynthesisMode = 'formula' | 'text';

const MODE_MESSAGE_KEYS: Record<Mode, 'modeFormulaInline' | 'modeFormulaDisplay' | 'modeText' | 'modeBlock'> = {
  formula_inline: 'modeFormulaInline',
  formula_display: 'modeFormulaDisplay',
  text: 'modeText',
  block: 'modeBlock'
};
const MODE_ORDER: Mode[] = ['formula_inline', 'formula_display', 'text', 'block'];

/** Editable current-schema style plus split controls for authoring `#*`. */
interface StyleDraft {
  extensions: Record<string, unknown>;
  typst_extensions: Record<string, unknown>;
  typst_synthesis_extensions: Record<string, unknown>;
  latex_extensions: Record<string, unknown>;
  latex_synthesis_extensions: Record<string, unknown>;
  style_name: string;
  mode: Mode;
  template: string;
  template_left: string;
  separator: string;
  template_right: string;
  block_template_name: string;
  tags: string[];
  typst_built_in: string;
  typst_synthesis: string;
  typst_synthesis_mode: SynthesisMode;
  latex_built_in: string;
  latex_synthesis: string;
  latex_synthesis_mode: SynthesisMode;
  markdown: string;
  text: string;
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
  defaultStyle: Record<string, string>;
  originalRevision?: string;
}

function newStyleDraft(styleName: string): StyleDraft {
  return {
    extensions: {},
    typst_extensions: {},
    typst_synthesis_extensions: {},
    latex_extensions: {},
    latex_synthesis_extensions: {},
    style_name: styleName,
    mode: 'formula_inline',
    template: '',
    template_left: '',
    separator: '',
    template_right: '',
    block_template_name: '',
    tags: [],
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

/** Serialize a draft to strict Macro v8 storage. */
function styleDraftToExtended(s: StyleDraft, dynamicArity: boolean): ExtendedSnlMacroStyle {
  const templateString = dynamicArity
    ? `${s.template_left}#*${s.template_right}`
    : (s.template || (s.mode === 'block' ? '#*' : ''));
  const common = {
    ...s.extensions,
    style_name: s.style_name,
    ...(dynamicArity ? { separator: s.separator } : {}),
    tags: s.tags.map((t) => t.trim()).filter((t) => t.length > 0),
    typst: {
      ...s.typst_extensions,
      built_in: s.typst_built_in,
      synthesis: {
        ...s.typst_synthesis_extensions,
        mode: s.typst_synthesis_mode,
        macro: s.typst_synthesis
      }
    },
    latex: {
      ...s.latex_extensions,
      built_in: s.latex_built_in,
      synthesis: {
        ...s.latex_synthesis_extensions,
        mode: s.latex_synthesis_mode,
        macro: s.latex_synthesis
      }
    },
    markdown: s.markdown,
    text: s.text
  };
  if (s.mode === 'text') return { ...common, mode: 'text', template: templateString };
  return {
    ...common,
    mode: s.mode,
    template: templateString,
    ...(s.mode === 'block' && s.block_template_name
      ? { block_template_name: s.block_template_name }
      : {})
  };
}

/** A user-defined macro kind, sent from the extension host with `context`. */
interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
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
type ExtendedSnlMacroStyle =
  | (Extract<SnlMacroStyle, { mode: 'text' }> & ExtendedStyleBackends)
  | (Exclude<SnlMacroStyle, { mode: 'text' }> & ExtendedStyleBackends);

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
  default_style: Record<string, string>;
  styles: ExtendedSnlMacroStyle[];
  tags: string[];
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
  workspaceMacros?: MacroRecord;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateMacroApp(): React.ReactElement {
  const preferencesRevision = use_preferences_revision();
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const apiRef = useVsCodeApiRef();
  const formDirtyRef = useRef(false);
  const macroRevisionRef = useRef<string | undefined>(undefined);
  const editingNameRef = useRef('');
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
  const [workspaceMacros, setWorkspaceMacros] = useState<MacroRecord>({});
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);
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
  const [defaultStyle, setDefaultStyle] = useState<Record<string, string>>({ en: 'default' });
  const [activeStyle, setActiveStyle] = useState(0);

  const [activeTab, setActiveTab] = useState<TabId>('katex_template');

  const [previewArgs, setPreviewArgs] = useState<string[]>(['', '', '', '']);
  const [variadicArgCount, setVariadicArgCount] = useState(3);

  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const current = styles[activeStyle] ?? styles[0];

  function markFormDirty(): void {
    formDirtyRef.current = true;
  }

  /** Patch a field on the currently-active style. */
  function patchStyle(patch: Partial<StyleDraft>): void {
    markFormDirty();
    setStyles((prev) =>
      prev.map((s, i) => i === activeStyle ? { ...s, ...patch } : s)
    );
  }

  function changeStyleMode(mode: Mode): void {
    patchStyle({ mode });
  }

  /** Keep pass-through fields current even when a restored visible draft wins. */
  function absorbHydratedMacroBase(existing: ExtendedSnlMacro): void {
    hydratedMacroBaseRef.current = {
      ...existing,
      source: {
        ...(existing.source ?? {}),
        entries: [...(existing.source?.entries ?? [])],
        urls: [...(existing.source?.urls ?? [])]
      },
      default_style: { ...(existing.default_style ?? {}) },
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
    setKind(draft.kind);
    setStyles(draft.styles.map((style) => ({ ...style, tags: style.tags.slice() })));
    setDefaultStyle({ ...draft.defaultStyle });
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
  function hydrateFromExisting(existing: ExtendedSnlMacro): void {
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
    setKind(existing.kind ?? '');
    setMacroTags(Array.isArray(existing.tags) ? existing.tags.slice() : []);
    setDefaultStyle(
      existing.default_style && typeof existing.default_style === 'object'
        ? { ...existing.default_style }
        : { en: existing.styles?.[0]?.style_name ?? 'default' }
    );
    const drafts: StyleDraft[] = Array.isArray(existing.styles)
      ? existing.styles.map((s) => {
          const raw = s as unknown as Record<string, unknown>;
          const {
            style_name: _styleName,
            mode: _mode,
            template: _template,
            separator: _separator,
            block_template_name: _blockTemplateName,
            tags: _tags,
            typst: _typst,
            latex: _latex,
            markdown: _markdown,
            text: _text,
            ...extensions
          } = raw;
          const typstRaw = s.typst && typeof s.typst === 'object'
            ? s.typst as unknown as Record<string, unknown> : {};
          const { built_in: _typstBuiltIn, synthesis: _typstSynthesis, ...typstExtensions } = typstRaw;
          const typstSynthesisRaw = s.typst?.synthesis && typeof s.typst.synthesis === 'object'
            ? s.typst.synthesis as unknown as Record<string, unknown> : {};
          const { mode: _typstMode, macro: _typstMacro, ...typstSynthesisExtensions } = typstSynthesisRaw;
          const latexRaw = s.latex && typeof s.latex === 'object'
            ? s.latex as unknown as Record<string, unknown> : {};
          const { built_in: _latexBuiltIn, synthesis: _latexSynthesis, ...latexExtensions } = latexRaw;
          const latexSynthesisRaw = s.latex?.synthesis && typeof s.latex.synthesis === 'object'
            ? s.latex.synthesis as unknown as Record<string, unknown> : {};
          const { mode: _latexMode, macro: _latexMacro, ...latexSynthesisExtensions } = latexSynthesisRaw;
          const template = s.template;
          const marker = template.indexOf('#*');
          return {
        extensions,
        typst_extensions: typstExtensions,
        typst_synthesis_extensions: typstSynthesisExtensions,
        latex_extensions: latexExtensions,
        latex_synthesis_extensions: latexSynthesisExtensions,
        style_name: s.style_name || 'default',
        mode: s.mode,
        template,
        template_left: marker >= 0 ? template.slice(0, marker) : '',
        separator: s.separator ?? '',
        template_right: marker >= 0 ? template.slice(marker + 2) : '',
        block_template_name: s.block_template_name ?? '',
        tags: s.tags.slice(),
        typst_built_in: s.typst?.built_in ?? '',
        typst_synthesis: s.typst?.synthesis?.macro ?? '',
        typst_synthesis_mode: (s.typst?.synthesis?.mode as SynthesisMode) ?? 'formula',
        latex_built_in: s.latex?.built_in ?? '',
        latex_synthesis: s.latex?.synthesis?.macro ?? '',
        latex_synthesis_mode: (s.latex?.synthesis?.mode as SynthesisMode) ?? 'formula',
        markdown: s.markdown ?? '',
        text: s.text ?? ''
      };
      })
      : [newStyleDraft('default')];
    setStyles(drafts.length > 0 ? drafts : [newStyleDraft('default')]);
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
          setMacroKinds(Array.isArray(msg.macroKinds) ? msg.macroKinds : []);
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
            if (!sameDirtyDraft) hydrateFromExisting(msg.existing);
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
              return [patched, ...prev.slice(1)];
            });
          }
          break;
        case 'kindsRefresh':
          // Cat 2026-07-12: dropdown "+ New macro kind…" flow. Refresh
          // the list without touching any other form state.
          setMacroKinds(Array.isArray(msg.macroKinds) ? msg.macroKinds : []);
          break;
        case 'created':
          // The host flips this panel to edit mode for the macro we just
          // created and immediately re-pushes a context. Adopt the new name
          // as our editing identity now so the follow-up context is
          // recognised as "the thing I am already editing".
          saveDraft(apiRef.current, draftKeyRef.current, undefined);
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
      defaultStyle,
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
    const styleList: SnlMacroStyle[] = styles.map((s) => {
      const extended = styleDraftToExtended(s, dynamicArity);
      const base = {
        style_name: extended.style_name,
        ...(extended.separator !== undefined ? { separator: extended.separator } : {}),
        tags: extended.tags
      };
      if (extended.mode === 'text') {
        return { ...base, mode: 'text', template: extended.template };
      }
      return {
        ...base,
        mode: extended.mode,
        template: extended.template,
        ...(extended.mode === 'block' && extended.block_template_name
          ? { block_template_name: extended.block_template_name }
          : {})
      };
    });
    const previewStyles = styleList.length > 0
      ? styleList
      : [{ style_name: 'default', mode: 'formula_inline' as const, template: '', tags: [] }];
    const activeName = previewStyles[Math.min(activeStyle, previewStyles.length - 1)]?.style_name
      ?? previewStyles[0].style_name;
    const language = webview_language_runtime.query_environment().language;
    return {
      name: DRAFT_KEY,
      description: '',
      source: { entries: [], urls: [] },
      dynamic_arity: dynamicArity,
      kind: kind || undefined,
      tags: [],
      default_style: { ...defaultStyle, en: defaultStyle.en ?? previewStyles[0].style_name, [language]: activeName },
      styles: previewStyles
    };
  }, [dynamicArity, kind, styles, activeStyle, defaultStyle, preferencesRevision]);

  // Build a KindPalette from the user's macro kinds so the live preview frames
  // the draft macro's subtree with its declared kind's colours. Falls back to
  // DEFAULT_KIND_PALETTE (SnlSyntaxTreeView merges over the defaults) when the
  // user hasn't initialized any macro kinds.
  const kindPalette: KindPalette | undefined = useMemo(() => {
    if (macroKinds.length === 0) {
      return undefined;
    }
    const palette: KindPalette = {};
    for (const k of macroKinds) {
      if (/^[A-Za-z0-9_-]+$/.test(k.id)) {
        palette[k.id] = {
          stroke: k.coloring.stroke,
          background: k.coloring.background
        };
      }
    }
    return palette;
  }, [macroKinds]);

  const previewMacroRecord: MacroRecord = useMemo(
    () => ({
      ...workspaceMacros,
      ...MACRO_PREVIEW_ARGUMENTS,
      [PREVIEW_PLACEHOLDER_KEY]: previewPlaceholderMacro(t('macroPreview')),      [DRAFT_KEY]: draftMacro
    }),
    [draftMacro, workspaceMacros, t]
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

  const argCount = useMemo(() => {
    if (dynamicArity) {
      return Math.min(Math.max(variadicArgCount, 0), MAX_MACRO_PREVIEW_ARGS);
    }
    const derived = maxMacroTemplateChildIndex(current?.template ?? '') + 1;
    return Math.min(Math.max(derived, 0), MAX_MACRO_PREVIEW_ARGS);
  }, [dynamicArity, variadicArgCount, current]);

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
    if ((current?.template ?? '').trim().length === 0) {
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
    return { macro_name: DRAFT_KEY, kind: '', mdata: null, children };
  }, [argCount, previewArgs, current?.template]);

  // --- Validation ----------------------------------------------------------

  const exactName = name;
  // In edit mode, `exactName` is the identity of the macro being edited, so
  // its own presence in existingNames must NOT count as a duplicate. Only a
  // create-mode collision blocks submission.
  const isDuplicate =
    panelMode === 'edit' ? false : existingNames.includes(exactName);
  const defaultStyleDraft = styles[0];
  const templateEmpty = (defaultStyleDraft?.template ?? '').trim().length === 0;
  const tagList = styles.map((s) => s.style_name);
  const hasEmptyTag = tagList.some((t) => t.length === 0);
  const hasInvalidTag = tagList.some((t) => !isSnlIdentifier(t));
  const hasDupTag = new Set(tagList).size !== tagList.length;
  const styleNames = new Set(tagList);
  const hasInvalidDefaultStyle = Object.values(defaultStyle).some(
    (styleName) => !styleNames.has(styleName)
  );
  const canCreate =
    targetState !== 'notFound' &&
    exactName.length > 0 &&
    isSnlIdentifier(exactName) &&
    !isDuplicate &&
    !templateEmpty &&
    !hasEmptyTag &&
    !hasInvalidTag &&
    !hasDupTag &&
    !hasInvalidDefaultStyle &&
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
      kind: kind || undefined,
      dynamic_arity: dynamicArity,
      default_style: { ...defaultStyle },
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

  return (
    <main
      style={PANEL_STYLE}
      onInputCapture={markFormDirty}
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
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__new__') {
                  // Cat 2026-07-12: "+ New macro kind…" sentinel opens
                  // the CreateMacroKindPanel via a host round-trip; kind
                  // stays whatever it was so the user's current form
                  // state isn't affected. The dropdown will re-render
                  // with the new entry on the next visibilitychange
                  // (refreshKinds handler above).
                  apiRef.current?.postMessage({ type: 'createMacroKind' });
                  return;
                }
                markFormDirty();
                setKind(v);
              }}
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
                  return sel ? (
                    <span
                      title={t('colorPreview', { stroke: sel.coloring.stroke, background: sel.coloring.background })}
                      style={{
                        display: 'inline-block',
                        width: '1.4rem',
                        height: '1.1rem',
                        borderRadius: '3px',
                        background: sel.coloring.background,
                        border: `2px solid ${sel.coloring.stroke}`,
                        flex: '0 0 auto'
                      }}
                    />
                  ) : null;
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
        defaultStyle={defaultStyle}
        setDefaultStyle={(next) => {
          markFormDirty();
          setDefaultStyle(next);
        }}
      />

      {/* --- Content tabs --------------------------------------------------- */}
      <SectionHeader title={t('contentStyle', { style: current?.style_name || 'default' })} />
      <div
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
            {tab.id === 'katex_template' &&
            (current?.template ?? '').trim().length === 0
              ? ' *'
              : ''}
          </TabButton>
        ))}
      </div>

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
              <PreviewBoundary
                key={
                  (current?.template ?? '') +
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
                value={current?.template ?? ''}
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
              // When toggling ON: the UI hides the template textarea and only
              // exposes left/sep/right, so we pin every style's template to
              // '#*' so the render pipeline emits a dynamic-arity node.
              // When toggling OFF: clear '#*' back to '' so the empty-template
              // validation trips and the user is prompted to author a fixed
              // template. Preserves user text when it's already something
              // non-#* (unusual but possible if imported).
              setStyles((prev) =>
                prev.map((s) => {
                  if (next) {
                    return s.template.trim() === '' ||
                      s.template.trim() === '#*'
                      ? { ...s, template: '#*' }
                      : s;
                  }
                  return s.template.trim() === '#*'
                    ? { ...s, template: '' }
                    : s;
                }),
              );
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
          border:
            '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
          borderRadius: '4px',
          padding: '0.75rem',
          marginBottom: '1.25rem'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.5rem'
          }}
        >
          <strong style={{ fontSize: '0.9rem' }}>
            {t('argumentOverrides')}
          </strong>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {dynamicArity ? (
              <>
                <SmallButton
                  onClick={() =>
                    setVariadicArgCount((n) => Math.min(n + 1, MAX_MACRO_PREVIEW_ARGS))
                  }
                >
                  {t('addArg')}
                </SmallButton>
                <SmallButton
                  onClick={() =>
                    setVariadicArgCount((n) => Math.max(n - 1, 0))
                  }
                >
                  {t('removeArg')}
                </SmallButton>
              </>
            ) : null}
            <SmallButton onClick={resetArgs}>{t('resetArgs')}</SmallButton>
          </div>
        </div>

        {argCount === 0 ? (
          <p style={{ margin: 0, opacity: 0.7, fontSize: '0.85rem' }}>
            {dynamicArity
              ? t('noDynamicArgs')
              : t('noFixedArgs')}
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
                  onChange={(e) => setArg(i, e.target.value)}
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
                  <SmallButton onClick={() => remove(i)}>−</SmallButton>
                </div>
              );
            })
          )}
          <SmallButton onClick={add}>{t('addTag')}</SmallButton>
        </div>
      ) : null}
    </div>
  );
}

function StylesEditor({
  styles,
  setStyles,
  activeStyle,
  setActiveStyle,
  patchStyle,
  hasDupTag,
  defaultStyle,
  setDefaultStyle
}: {
  styles: StyleDraft[];
  setStyles: React.Dispatch<React.SetStateAction<StyleDraft[]>>;
  activeStyle: number;
  setActiveStyle: (i: number) => void;
  patchStyle: (patch: Partial<StyleDraft>) => void;
  hasDupTag: boolean;
  defaultStyle: Record<string, string>;
  setDefaultStyle: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const current = styles[activeStyle] ?? styles[0];
  const [newLanguage, setNewLanguage] = useState('');

  const addStyle = (): void => {
    const existing = new Set(styles.map((s) => s.style_name));
    let n = styles.length;
    let tag = `style${n}`;
    while (existing.has(tag)) {
      n += 1;
      tag = `style${n}`;
    }
    setStyles([...styles, newStyleDraft(tag)]);
    setActiveStyle(styles.length);
  };

  const removeStyle = (i: number): void => {
    if (styles.length <= 1) {
      return;
    }
    const next = styles.filter((_, idx) => idx !== i);
    const removedName = styles[i].style_name;
    setStyles(next);
    setDefaultStyle((currentDefaults) => Object.fromEntries(
      Object.entries(currentDefaults).map(([language, styleName]) => [
        language,
        styleName === removedName ? next[0].style_name : styleName
      ])
    ));
    const newActive = Math.min(activeStyle, next.length - 1);
    setActiveStyle(Math.max(newActive, 0));
  };

  /** Move style at index i one slot toward index 0 (the default position). */
  const moveUp = (i: number): void => {
    if (i <= 0) return;
    const next = styles.slice();
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    setStyles(next);
    // Keep the active-tab pointing at the SAME style after the swap.
    if (activeStyle === i) setActiveStyle(i - 1);
    else if (activeStyle === i - 1) setActiveStyle(i);
  };

  /** Commit a rename issued from a StyleSwitch's inline editor. */
  const renameStyleAt = (i: number, next: string): void => {
    const previousName = styles[i].style_name;
    setStyles((prev) => prev.map((s, idx) => (idx === i ? { ...s, style_name: next } : s)));
    setDefaultStyle((currentDefaults) => Object.fromEntries(
      Object.entries(currentDefaults).map(([language, styleName]) => [
        language,
        styleName === previousName ? next : styleName
      ])
    ));
  };

  return (
    <>
      <SectionHeader title={t('styles')} />
      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {styles.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
            <StyleSwitch
              tag={s.style_name}
              active={i === activeStyle}
              isDefault={i === 0}
              onSelect={() => setActiveStyle(i)}
              onRename={(next) => renameStyleAt(i, next)}
            />
            {i > 0 ? (
              <SmallButton onClick={() => moveUp(i)} title={t('moveEarlier')}>
                ↑
              </SmallButton>
            ) : null}
            {styles.length > 1 ? (
              <SmallButton onClick={() => removeStyle(i)}>−</SmallButton>
            ) : null}
          </div>
        ))}
        <SmallButton onClick={addStyle}>{t('addStyle')}</SmallButton>
      </div>

      {hasDupTag ? (
        <p
          style={{
            margin: '0 0 0.5rem',
            fontSize: '0.8rem',
            color: 'var(--vscode-errorForeground, #f48771)'
          }}
        >
          {t('duplicateStyleTags')}
        </p>
      ) : null}

      <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', opacity: 0.6 }}>
        {t('fallbackHelp')}
      </p>

      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.35rem' }}>
          {t('defaultStyleByLanguage')}
        </div>
        {[...new Set(['en', 'zh-CN', ...Object.keys(defaultStyle)])].map((language) => (
          <div key={language} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.3rem' }}>
            <code style={{ minWidth: '5rem' }}>{language}</code>
            <select
              value={defaultStyle[language] ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                setDefaultStyle((currentDefaults) => {
                  const next = { ...currentDefaults };
                  if (value) next[language] = value;
                  else delete next[language];
                  return next;
                });
              }}
              style={{ ...inputStyle, minWidth: '10rem' }}
            >
              <option value="">{t(language === 'en' ? 'useStylesZero' : 'useEnglishStylesZero')}</option>
              {styles.map((style) => (
                <option key={style.style_name} value={style.style_name}>{style.style_name}</option>
              ))}
            </select>
          </div>
        ))}
        <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          <input
            value={newLanguage}
            placeholder={t('languagePlaceholder')}
            onChange={(event) => setNewLanguage(event.target.value)}
            style={{ ...inputStyle, width: '12rem' }}
          />
          <SmallButton onClick={() => {
            const language = newLanguage.trim();
            if (!language || Object.prototype.hasOwnProperty.call(defaultStyle, language)) return;
            setDefaultStyle((currentDefaults) => ({ ...currentDefaults, [language]: styles[0].style_name }));
            setNewLanguage('');
          }}>{t('addLanguage')}</SmallButton>
        </div>
      </div>

      {/* React renderer preset — only for `block` mode. Text mode goes
          through the LaTeX pipeline (\text{...} + nested $...$) and has
          no React renderer dispatch, so the key would be dead data.

          Cat 2026-07-10: turned the raw text input into a preset
          dropdown listing the four SNL-Basics built-in block renderers
          (list / enumerate / table / centered). "Custom" reveals the
          freeform input for consumer-registered keys. The point is to
          make it trivial to build semantically-distinct macros —
          `axioms`, `steps`, `proof-cases` — that all pick the same
          `enumerate` render preset: same visual, different data. */}
      {current?.mode === 'block' ? (
        <BlockRendererPresetControl
          value={current?.block_template_name ?? ''}
          onChange={(v) => patchStyle({ block_template_name: v })}
        />
      ) : null}
    </>
  );
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
  hintKey: 'presetListHint' | 'presetEnumerateHint' | 'presetTableHint' | 'presetCenteredHint' | 'presetCollapsibleHint';
}> = [
  // Render preset keys are protocol tokens and remain language-invariant.
  { key: 'list', hintKey: 'presetListHint' },
  { key: 'enumerate', hintKey: 'presetEnumerateHint' },
  { key: 'table', hintKey: 'presetTableHint' },
  { key: 'centered', hintKey: 'presetCenteredHint' },
  { key: 'collapsible', hintKey: 'presetCollapsibleHint' }
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
  onChange
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const t = useUiMessages(CREATE_MACRO_MESSAGES);
  const [mode, setMode] = useState<'preset' | 'custom' | 'unset'>(() => {
    if (!value) return 'unset';
    return PRESET_KEYS.has(value) ? 'preset' : 'custom';
  });

  // If the parent's value changes out from under us (e.g. loading a
  // different style), resync the mode.
  useEffect(() => {
    if (!value) setMode('unset');
    else if (PRESET_KEYS.has(value)) setMode('preset');
    else setMode('custom');
  }, [value]);

  const selectedPreset = mode === 'preset' ? value : '';
  const hint =
    mode === 'preset'
      ? (() => {
          const hintKey = BLOCK_RENDERER_PRESETS.find((p) => p.key === value)?.hintKey;
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
          value={mode === 'unset' ? '' : mode === 'custom' ? '__custom__' : selectedPreset}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') {
              setMode('unset');
              onChange('');
            } else if (v === '__custom__') {
              setMode('custom');
              // If the current value is a preset key, wipe it so the
              // custom input starts empty; if it was already custom
              // preserve it.
              if (PRESET_KEYS.has(value) || !value) onChange('');
            } else {
              setMode('preset');
              onChange(v);
            }
          }}
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
    <TabButton
      active={active}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
      title={t('renameStyle')}
    >
      {tag.trim() || t('emptyStyle')}
      {isDefault ? ' ★' : ''}
    </TabButton>
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
            <SmallButton onClick={() => remove(i)}>−</SmallButton>
          </div>
        </div>
      ))}
      <SmallButton onClick={add}>{t('add')}</SmallButton>
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
              <SmallButton onClick={() => remove(i)}>−</SmallButton>
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
      <SmallButton onClick={add}>{t('add')}</SmallButton>
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

/**
 * Themed button used both as content-tab and as styles-bar tab. Hovering flips
 * the background to a subtle grey ({@link BUTTON_HOVER_BG}) for interaction
 * feedback (Fulcrum, 2026-07-03 UI overhaul).
 */
function TabButton({
  active,
  onClick,
  onDoubleClick,
  children,
  title
}: {
  active: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
  title?: string;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const inactiveBg = hover
    ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))'
    : 'var(--vscode-tab-inactiveBackground, transparent)';
  const activeBg = hover
    ? 'var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.09))'
    : 'var(--vscode-tab-activeBackground, #1e1e1e)';
  return (
    <Button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        padding: '0.3rem 0.7rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        borderBottom: active
          ? '2px solid var(--vscode-focusBorder, #0e639c)'
          : '1px solid var(--vscode-panel-border, #444)',
        background: active ? activeBg : inactiveBg,
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '3px 3px 0 0',
        fontFamily: 'inherit',
        fontSize: '0.85rem',
        fontWeight: active ? 600 : 400,
        transition: 'background 80ms ease',
        textAlign: 'left'
      }}
    >
      {children}
    </Button>
  );
}

function SmallButton({
  onClick,
  children,
  title
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <Button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        padding: '0.2rem 0.55rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.06))'
          : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '3px',
        fontFamily: 'inherit',
        fontSize: '0.8rem',
        transition: 'background 80ms ease'
      }}
    >
      {children}
    </Button>
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
