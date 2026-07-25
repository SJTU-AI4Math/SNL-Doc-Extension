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
import { useSaveShortcut } from './components/draftState';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
import './create-macro.css';
import {
  tryParseSnlSyntaxTree,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  read_localized,
  type I18n,
  type Localized,
  type SnlMacro,
  type SnlMacroStyle,
  type SnlSyntaxTree,
  type SnlRenderHooks,
  type KindPalette
} from '@sjtu-ai4math/snl-basics';
import {
  bundledMacros,
  createMacroDataDriver,
  type MacroRecord
} from './render/macroData';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { MacroIdInput } from './components/MacroIdInput';
import { EntityIdSearchBox } from './components/EntityIdSearchBox';
import type { EntryOption } from './render/EntryRender';
import { areEntityReferencesResolved } from './components/formValidation';
import { merge_localized_projection } from './runtime/localizedDraft';
import {
  use_preferences_revision,
  webview_language_runtime
} from './runtime/preferencesRuntime';
import type { SnooglSearchCandidate } from '../../src/snooglSearch';

// ---------------------------------------------------------------------------
// Preview constants
// ---------------------------------------------------------------------------

const DRAFT_KEY = '_snl_draft';
const PREVIEW_PLACEHOLDER_KEY = '_snl_preview_placeholder';
const MAX_ARGS = 8;

/** One placeholder macro per index — a rounded translucent numbered box.
 *
 * The `\mathord{...}` wrap is REQUIRED: without it, KaTeX writes the trailing
 * atom-spacing (`\mspace`) as a child of the `\htmlClass` span, so the
 * placeholder's CSS frame visibly extends past the digit into empty right
 * padding whenever a `+` / operator follows (bug 猫猫 flagged 2026-07-04).
 * `\mathord` promotes the wrapper to its own atom so the spacing lands
 * OUTSIDE the frame, adjacent to the following `\mbin`.
 */
const ARG_PLACEHOLDER_MACROS: Record<string, SnlMacro> = {};
for (let i = 0; i < MAX_ARGS; i++) {
  ARG_PLACEHOLDER_MACROS[`_snl_arg_${i}`] = {
    name: `_snl_arg_${i}`,
    description: `Argument placeholder ${i}`,
    source: { entries: [], urls: [] },
    dynamic_arity: false,
    tags: [],
    styles: [
      {
        style_name: 'default',
        mode: 'formula_inline',
        template: `\\mathord{\\htmlClass{snlArgPlaceholder}{${i}}}`,
        tags: []
      }
    ]
  };
}

/**
 * Empty-state preview macro. Used when the current style's template is empty
 * so the preview shows something informative instead of the internal
 * `_snl_draft` name.
 */
const PREVIEW_PLACEHOLDER_MACRO: SnlMacro = {
  name: PREVIEW_PLACEHOLDER_KEY,
  description: 'SNL preview placeholder',
  source: { entries: [], urls: [] },
  dynamic_arity: false,
  tags: [],
  styles: [
    {
      style_name: 'default',
      mode: 'text',
      template: 'SNL Macro Preview',
      tags: []
    }
  ]
};

function placeholderNode(i: number): SnlSyntaxTree {
  return { macro_name: `_snl_arg_${i}`, kind: 'argPlaceholder', mdata: null, children: [] };
}

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

type Mode = 'formula_inline' | 'formula_display' | 'text' | 'block';
type SynthesisMode = 'formula' | 'text';

const MODE_LABELS: Record<Mode, string> = {
  formula_inline: 'Formula (inline)',
  formula_display: 'Formula (display)',
  text: 'Text',
  block: 'Block'
};
const MODE_ORDER: Mode[] = ['formula_inline', 'formula_display', 'text', 'block'];

/** Editable current-schema style plus split controls for authoring `#*`. */
interface StyleDraft {
  style_name: string;
  mode: Mode;
  template: string;
  /** Original multilingual map; `template` edits the current language projection. */
  template_i18n?: I18n<string, string>;
  /** Whether the current language projection was edited. */
  template_dirty?: boolean;
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

function newStyleDraft(styleName: string): StyleDraft {
  return {
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

/** Serialize a draft to strict Macro v7 storage. */
function styleDraftToExtended(s: StyleDraft, dynamicArity: boolean): ExtendedSnlMacroStyle {
  const templateString = dynamicArity
    ? `${s.template_left}#*${s.template_right}`
    : (s.template || (s.mode === 'block' ? '#*' : ''));
  const common = {
    style_name: s.style_name.trim(),
    ...(dynamicArity ? { separator: s.separator } : {}),
    tags: s.tags.map((t) => t.trim()).filter((t) => t.length > 0),
    typst: {
      built_in: s.typst_built_in,
      synthesis: { mode: s.typst_synthesis_mode, macro: s.typst_synthesis }
    },
    latex: {
      built_in: s.latex_built_in,
      synthesis: { mode: s.latex_synthesis_mode, macro: s.latex_synthesis }
    },
    markdown: s.markdown,
    text: s.text
  };
  if (s.mode === 'text') {
    const template: Localized<string, string> = s.template_i18n
      ? merge_localized_projection(
          s.template_i18n,
          templateString,
          webview_language_runtime.query_environment().language,
          !!s.template_dirty
        )
      : templateString;
    return { ...common, mode: 'text', template };
  }
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
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind?: string;
  dynamic_arity: boolean;
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
  file: string;
  packageName: string;
  existingNames: string[];
  macroCandidates?: SnooglSearchCandidate[];
  macroKinds?: MacroKind[];
  existing?: ExtendedSnlMacro | null;
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
  { id: 'katex_template', label: 'KaTeX template' },
  { id: 'typst_built_in', label: 'Typst built_in' },
  { id: 'typst_synthesis', label: 'Typst synthesis' },
  { id: 'latex_built_in', label: 'LaTeX built_in' },
  { id: 'latex_synthesis', label: 'LaTeX synthesis' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: 'Text' }
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

/** Max `#N` child index in a template, or -1 when none. Ignores escaped `\#`. */
function maxChildIndex(template: string): number {
  let max = -1;
  const re = /(?<!\\)#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const idx = Number(m[1]);
    if (Number.isFinite(idx) && idx > max) {
      max = idx;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateMacroApp(): React.ReactElement {
  const preferencesRevision = use_preferences_revision();
  const languageRef = useRef(webview_language_runtime.query_environment().language);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const formDirtyRef = useRef(false);
  const editingNameRef = useRef('');

  const [panelMode, setPanelMode] = useState<PanelMode>('create');
  const [file, setFile] = useState('');
  const [packageName, setPackageName] = useState('');
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [macroCandidates, setMacroCandidates] = useState<SnooglSearchCandidate[]>([]);
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
  const [activeStyle, setActiveStyle] = useState(0);

  const [activeTab, setActiveTab] = useState<TabId>('katex_template');

  const [previewArgs, setPreviewArgs] = useState<string[]>(['', '', '', '']);
  const [variadicArgCount, setVariadicArgCount] = useState(3);

  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const current = styles[activeStyle] ?? styles[0];

  /** Patch a field on the currently-active style. */
  function patchStyle(patch: Partial<StyleDraft>): void {
    formDirtyRef.current = true;
    const editsTemplate =
      patch.template !== undefined ||
      patch.template_left !== undefined ||
      patch.template_right !== undefined;
    setStyles((prev) =>
      prev.map((s, i) =>
        i === activeStyle
          ? { ...s, ...patch, ...(editsTemplate ? { template_dirty: true } : {}) }
          : s
      )
    );
  }

  function changeStyleMode(mode: Mode): void {
    if (current?.mode === 'text' && current.template_i18n && mode !== 'text') {
      const confirmed = window.confirm(
        webview_language_runtime.run_reader(read_localized<string, string>({
          type: 'i18n',
          default_language: 'en',
          values: {
            en: 'Changing this localized Text style to Formula/Block will discard its other language templates. Continue?',
            'zh-CN': '将这个多语言文本样式改为公式/块样式会丢弃其他语言模板。是否继续？'
          }
        }))
      );
      if (!confirmed) return;
      patchStyle({ mode, template_i18n: undefined, template_dirty: true });
      return;
    }
    patchStyle({ mode });
  }

  useEffect(() => {
    const nextLanguage = webview_language_runtime.query_environment().language;
    const previousLanguage = languageRef.current;
    if (nextLanguage === previousLanguage) return;
    setStyles((previous) => previous.map((style) => {
      if (!style.template_i18n) return style;
      const currentTemplate = dynamicArity
        ? `${style.template_left}#*${style.template_right}`
        : style.template;
      const template_i18n = merge_localized_projection(
        style.template_i18n,
        currentTemplate,
        previousLanguage,
        !!style.template_dirty
      );
      const template = webview_language_runtime.run_reader(
        read_localized<string, string>(template_i18n)
      );
      const marker = template.indexOf('#*');
      return {
        ...style,
        template_i18n,
        template_dirty: false,
        template,
        template_left: marker >= 0 ? template.slice(0, marker) : '',
        template_right: marker >= 0 ? template.slice(marker + 2) : ''
      };
    }));
    languageRef.current = nextLanguage;
  }, [preferencesRevision, dynamicArity]);

  /**
   * Load an existing extended macro (from the host, edit mode) into the form
   * state. Field maps to defaults; the on-disk record must already have been
   * migrated to v6 shape by the host reader (snlDoc.v5MacroToV6).
   */
  function hydrateFromExisting(existing: ExtendedSnlMacro): void {
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
    const drafts: StyleDraft[] = Array.isArray(existing.styles)
      ? existing.styles.map((s) => {
          const persistedTemplate = s.template;
          const template = typeof persistedTemplate === 'string'
            ? persistedTemplate
            : webview_language_runtime.run_reader(
                read_localized<string, string>(persistedTemplate)
              );
          const marker = template.indexOf('#*');
          return {
        style_name: s.style_name || 'default',
        mode: s.mode,
        template,
        template_dirty: false,
        ...(typeof persistedTemplate === 'string'
          ? {}
          : { template_i18n: persistedTemplate }),
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
    apiRef.current = getVsCodeApi();
    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setPanelMode(msg.mode);
          setFile(msg.file);
          setPackageName(msg.packageName);
          setExistingNames(Array.isArray(msg.existingNames) ? msg.existingNames : []);
          setMacroCandidates(
            Array.isArray(msg.macroCandidates)
              ? msg.macroCandidates
              : (msg.existingNames ?? []).map((id) => ({ id, labels: [] }))
          );
          setMacroKinds(Array.isArray(msg.macroKinds) ? msg.macroKinds : []);
          setEntryPool(Array.isArray(msg.entries) ? msg.entries : []);
          if (msg.mode === 'edit' && msg.existing) {
            const sameDirtyDraft =
              formDirtyRef.current && editingNameRef.current === msg.existing.name;
            if (!sameDirtyDraft) hydrateFromExisting(msg.existing);
          } else if (msg.mode === 'create' && msg.prefill && !formDirtyRef.current) {
            // Cat 2026-07-12: seed the form from a row's `%…%` / `$…$` /
            // `$$…$$` / plain-id content so the user doesn't retype.
            const p = msg.prefill;
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
          formDirtyRef.current = false;
          setStyles((currentStyles) => currentStyles.map((style) => ({
            ...style,
            template_dirty: false
          })));
          setStatus({ kind: 'created', name: msg.name, at: Date.now() });
          break;
        case 'updated':
          formDirtyRef.current = false;
          setStyles((currentStyles) => currentStyles.map((style) => ({
            ...style,
            template_dirty: false
          })));
          setStatus({ kind: 'updated', name: msg.name, at: Date.now() });
          break;
        case 'duplicate':
          setStatus({ kind: 'duplicate', name: msg.name, message: msg.message });
          break;
        case 'notFound':
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
    // Move the active style to index 0 so the preview always uses it as the
    // implicit default (no `[style]` in the injected draft tree).
    if (activeStyle > 0 && activeStyle < styleList.length) {
      const [pick] = styleList.splice(activeStyle, 1);
      styleList.unshift(pick);
    }
    return {
      name: DRAFT_KEY,
      description: '',
      source: { entries: [], urls: [] },
      dynamic_arity: dynamicArity,
      kind: kind || undefined,
      tags: [],
      styles:
        styleList.length > 0
          ? styleList
          : [{ style_name: 'default', mode: 'formula_inline', template: '', tags: [] }]
    };
  }, [dynamicArity, kind, styles, activeStyle]);

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
      ...bundledMacros,
      ...ARG_PLACEHOLDER_MACROS,
      [PREVIEW_PLACEHOLDER_KEY]: PREVIEW_PLACEHOLDER_MACRO,
      [DRAFT_KEY]: draftMacro
    }),
    [draftMacro]
  );

  const previewMacroDataDriver = useMemo(
    () => createMacroDataDriver(previewMacroRecord),
    [previewMacroRecord]
  );

  const hooks: SnlRenderHooks = useMemo(() => ({ ...defaultRenderHooks }), []);

  // --- Arg slots -----------------------------------------------------------

  const argCount = useMemo(() => {
    if (dynamicArity) {
      return Math.min(Math.max(variadicArgCount, 0), MAX_ARGS);
    }
    const derived = maxChildIndex(current?.template ?? '') + 1;
    return Math.min(Math.max(derived, 0), MAX_ARGS);
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
        children.push(parsed.ok ? parsed.tree : placeholderNode(i));
      } else {
        children.push(placeholderNode(i));
      }
    }
    return { macro_name: DRAFT_KEY, kind: '', mdata: null, children };
  }, [argCount, previewArgs, current?.template]);

  // --- Validation ----------------------------------------------------------

  const trimmedName = name.trim();
  // In edit mode, `trimmedName` is the identity of the macro being edited, so
  // its own presence in existingNames must NOT count as a duplicate. Only a
  // create-mode collision blocks submission.
  const isDuplicate =
    panelMode === 'edit' ? false : existingNames.includes(trimmedName);
  const defaultStyleDraft = styles[0];
  const templateEmpty = (defaultStyleDraft?.template ?? '').trim().length === 0;
  const tagList = styles.map((s) => s.style_name.trim());
  const hasEmptyTag = tagList.some((t) => t.length === 0);
  const hasDupTag = new Set(tagList).size !== tagList.length;
  const canCreate =
    trimmedName.length > 0 &&
    !isDuplicate &&
    !templateEmpty &&
    !hasEmptyTag &&
    !hasDupTag &&
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
    setStyles((previous) => previous.map((style, index) => {
      const persisted = styleList[index];
      return persisted?.mode === 'text' && typeof persisted.template === 'object'
        ? { ...style, template_i18n: persisted.template }
        : style;
    }));
    const macro: ExtendedSnlMacro = {
      name: trimmedName,
      description: description.trim(),
      source: {
        entries: sourceEntries.map((s) => s.trim()).filter((s) => s.length > 0),
        urls: sourceUrls.map((s) => s.trim()).filter((s) => s.length > 0)
      },
      kind: kind || undefined,
      dynamic_arity: dynamicArity,
      styles: styleList,
      tags: trimmedMacroTags
    };
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: panelMode === 'edit' ? 'update' : 'create',
      macro
    });
  }

  const showPreview = activeTab === 'katex_template';
  const titlePackage = packageName || file || '\u2026';

  return (
    <main
      style={PANEL_STYLE}
      onInputCapture={() => { formDirtyRef.current = true; }}
      onClickCapture={() => { formDirtyRef.current = true; }}
    >
      <PanelNav
        vsApi={apiRef.current}
        back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }}
      />
      <h1 style={{ margin: '0 0 1rem', fontSize: '1.35rem' }}>
        {panelMode === 'edit' ? 'Edit Macro' : 'Create Macro'} in{' '}
        <code>{titlePackage}</code>
      </h1>

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
            Name{' '}
            <span style={{ opacity: 0.6 }}>
              {panelMode === 'edit' ? '(readonly)' : '(unique)'}
            </span>
          </label>
          <NameEditor
            value={name}
            macroCandidates={macroCandidates}
            onChange={setName}
            readOnly={panelMode === 'edit'}
            invalid={isDuplicate}
            readOnlyTitle="Macro names are immutable; delete + recreate to rename"
          />
        </div>
        <div>
          <label htmlFor="m-kind" style={labelStyle}>
            Kind
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
                setKind(v);
              }}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="">(unset)</option>
              {macroKinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.id})
                </option>
              ))}
              <option value="__new__">+ New macro kind…</option>
            </select>
            {kind
              ? (() => {
                  const sel = macroKinds.find((k) => k.id === kind);
                  return sel ? (
                    <span
                      title={`stroke ${sel.coloring.stroke} / background ${sel.coloring.background}`}
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
            Description <span style={{ opacity: 0.6 }}>(optional)</span>
          </label>
          <input
            id="m-desc"
            type="text"
            value={description}
            placeholder="Short human-readable description"
            onChange={(e) => setDescription(e.target.value)}
            style={{ ...inputStyle, width: '100%' }}
          />
        </div>
      </div>

      {/* --- Styles bar + style editor ------------------------------------- */}
      <StylesEditor
        styles={styles}
        setStyles={setStyles}
        activeStyle={activeStyle}
        setActiveStyle={setActiveStyle}
        patchStyle={patchStyle}
        hasDupTag={hasDupTag}
      />

      {/* --- Content tabs --------------------------------------------------- */}
      <SectionHeader title={`Content — style "${current?.style_name || 'default'}"`} />
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
            {tab.label}
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
              {current?.mode === 'block' ? (
                <>
                  Block mode — this macro renders through a React
                  component picked by the <strong>Render preset</strong>
                  below. Children are passed to the renderer as a flat
                  variadic list; the LaTeX template and variadic
                  delimiters are ignored, so they're hidden here.
                </>
              ) : dynamicArity ? (
                <>
                  Dynamic arity — configure the left / separator / right
                  delimiters below. The macro renders as{' '}
                  <code>left + children.join(sep) + right</code>. For more
                  complex shapes (matrix rows, per-cell styling) split into
                  multiple macros.
                </>
              ) : (
                <>
                  LaTeX template — use <code>#0</code>, <code>#1</code>, … for
                  children. <code>\#</code> = literal <code>#</code>. Do NOT
                  write <code>\htmlData</code> — the wrapper is added
                  automatically.
                </>
              )}
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
                placeholder="e.g. \frac{#0}{#1}"
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
        legend={`Style tags — "${current?.style_name || 'default'}"`}
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
          Dynamic Arity
        </label>
        <span style={{ opacity: 0.65, fontSize: '0.85rem' }}>
          renders as{' '}
          <code>left + children.join(sep) + right</code>
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
            Argument overrides during preview
          </strong>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {dynamicArity ? (
              <>
                <SmallButton
                  onClick={() =>
                    setVariadicArgCount((n) => Math.min(n + 1, MAX_ARGS))
                  }
                >
                  + Add Arg
                </SmallButton>
                <SmallButton
                  onClick={() =>
                    setVariadicArgCount((n) => Math.max(n - 1, 0))
                  }
                >
                  − Remove Arg
                </SmallButton>
              </>
            ) : null}
            <SmallButton onClick={resetArgs}>Reset all args</SmallButton>
          </div>
        </div>

        {argCount === 0 ? (
          <p style={{ margin: 0, opacity: 0.7, fontSize: '0.85rem' }}>
            {dynamicArity
              ? 'No argument slots. Use "+ Add Arg".'
              : 'No #N placeholders in the template — nothing to fill.'}
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
                  arg {i}
                </span>
                <textarea
                  value={previewArgs[i] ?? ''}
                  rows={1}
                  placeholder={`SNL source to substitute (empty = box[${i}])`}
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
                  parse error: {parseErrors[i]}
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* --- Sources (moved to the bottom, above Submit) ------------------- */}
      <SectionHeader title="Sources" />
      <div
        className="snl-responsive-grid--two"
        style={{
          gap: '1rem',
          marginBottom: '1rem'
        }}
      >
        <EntryListEditor
          label="Entries"
          entryPool={entryPool}
          values={sourceEntries}
          onChange={setSourceEntries}
        />
        <ListEditor
          label="URLs"
          placeholder="https://…"
          values={sourceUrls}
          onChange={setSourceUrls}
          warnNonHttp
        />
      </div>

      {/* --- Macro-level Tags (collapsible, always shown) ------------------ */}
      <TagsEditor
        legend="Macro tags"
        values={macroTags}
        onChange={setMacroTags}
      />

      {/* --- Submit --------------------------------------------------------- */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={!canCreate}
        >
          {status.kind === 'creating'
            ? panelMode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
            : panelMode === 'edit' ? 'Update Macro' : 'Create Macro'}
        </Button>
        {/* 猫猫: 保存成功提示应放在按钮右侧 + 时间戳 + 5s 自动消失 */}
        <SavedInline status={status} />
        <span style={{ opacity: 0.6, fontSize: '0.85rem', marginLeft: 'auto' }}>
          {templateEmpty ? 'KaTeX template is required.' : ''}
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
//   * Illegal characters (`@#$%` in ASCII, or spaces) fail validation with a
//     red border + error text; the invalid value is kept in state so the user
//     can fix it, and the parent's `onChange` gets the invalid joined string
//     (upstream validators will trip).
//
// Rendered as a single input when the name has no `.` at all (spec: "如果
// name 里没有 `.`，那么效果等同于这个功能不存在").

/**
 * Character rules for a name/namespace segment. Backslash / space / and the
 * four reserved punctuation `@#$%` are forbidden. Kept LAX to allow Unicode
 * (CJK, Greek, etc.) so users can write formal-math syntax trees in their
 * native language — cf. 猫猫's stance "定的比较松是因为我希望它能广泛支持
 * Unicode 命名".
 */
/**
 * ASCII characters forbidden in a macro name / namespace segment. Reserved
 * by the SNL parser:
 *   @ # $ %                — env_mode / binder delimiters
 *   whitespace             — token separator
 *   ( ) [ ]                — application / style bracket
 *   { }                    — reserved for future SNL syntax; also breaks the
 *                            \htmlData{name=…} attribute the view emits.
 *
 * Everything else (including backslash, dots, Unicode letters, digits,
 * emoji) is fair game. Rule intentionally permissive so authors can name
 * macros in their native language — cf. 猫猫's stance "定的比较松是因为我
 * 希望它能广泛支持 Unicode 命名". Kept in sync with snlDoc.ts's
 * validateMacro().
 */
const NAME_FORBIDDEN_CHARS = /[@#$%\s(){}\[\]]/;

/** True if a single name/namespace segment is legal. Empty is NOT legal here. */
function isValidNameSegment(seg: string): boolean {
  if (seg.length === 0) return false;
  return !NAME_FORBIDDEN_CHARS.test(seg);
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
      placeholder="e.g. Add.add"
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
            title="Collapse back to a single ID input (Edit whole ID)"
            aria-label="Edit whole ID"
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
            ✎ whole
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
          Invalid segment — cannot contain <code>@ # $ %</code>, whitespace,
          or bracket chars <code>( ) [ ] {'{'} {'}'}</code>.
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
      placeholder={isLast ? 'name' : 'namespace'}
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
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        minWidth: '10rem'
      }}
      aria-label="Render mode"
    >
      <div
        style={{
          fontSize: '0.8rem',
          fontWeight: 600,
          marginBottom: '0.15rem',
          opacity: 0.85
        }}
      >
        Mode
      </div>
      {MODE_ORDER.map((m) => (
        <div key={m} style={{ flex: 1, display: 'flex' }}>
          <ModeButton
            active={value === m}
            onClick={() => onChange(m)}
            label={MODE_LABELS[m]}
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
  const monoInput: React.CSSProperties = {
    ...inputStyle,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    flex: 1,
    minWidth: 0
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
        <label style={{ ...labelStyle, fontSize: '0.75rem', opacity: 0.75 }}>
          Left delimiter
        </label>
        <input
          type="text"
          value={left}
          placeholder="e.g. \begin{pmatrix} or ["
          onChange={(e) => onLeft(e.target.value)}
          style={monoInput}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <label style={{ ...labelStyle, fontSize: '0.75rem', opacity: 0.75 }}>
          Separator
        </label>
        <input
          type="text"
          value={sep}
          placeholder="e.g. \\\\ or , "
          onChange={(e) => onSep(e.target.value)}
          style={monoInput}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <label style={{ ...labelStyle, fontSize: '0.75rem', opacity: 0.75 }}>
          Right delimiter
        </label>
        <input
          type="text"
          value={right}
          placeholder="e.g. \end{pmatrix} or ]"
          onChange={(e) => onRight(e.target.value)}
          style={monoInput}
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
  const summary =
    values.length === 0 ? '(none)' : `${values.length} tag(s)`;
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
              No tags. Tags are free-text labels used by downstream search
              indices. Backslashes are not allowed.
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
                    placeholder="tag"
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
          <SmallButton onClick={add}>+ Add tag</SmallButton>
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
  hasDupTag
}: {
  styles: StyleDraft[];
  setStyles: React.Dispatch<React.SetStateAction<StyleDraft[]>>;
  activeStyle: number;
  setActiveStyle: (i: number) => void;
  patchStyle: (patch: Partial<StyleDraft>) => void;
  hasDupTag: boolean;
}): React.ReactElement {
  const current = styles[activeStyle] ?? styles[0];

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
    setStyles(next);
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
    setStyles((prev) => prev.map((s, idx) => (idx === i ? { ...s, style_name: next } : s)));
  };

  return (
    <>
      <SectionHeader title="Styles" />
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
              <SmallButton onClick={() => moveUp(i)} title="Move earlier (toward default)">
                ↑
              </SmallButton>
            ) : null}
            {styles.length > 1 ? (
              <SmallButton onClick={() => removeStyle(i)}>−</SmallButton>
            ) : null}
          </div>
        ))}
        <SmallButton onClick={addStyle}>+ Add style</SmallButton>
      </div>

      {hasDupTag ? (
        <p
          style={{
            margin: '0 0 0.5rem',
            fontSize: '0.8rem',
            color: 'var(--vscode-errorForeground, #f48771)'
          }}
        >
          Duplicate style tags — each style tag must be unique.
        </p>
      ) : null}

      <p style={{ margin: '0 0 0.5rem', fontSize: '0.78rem', opacity: 0.6 }}>
        ★ = default style (used when SNL source omits <code>[style]</code>). Use{' '}
        <strong>↑</strong> to make another style the default. Double-click a
        style button to rename it.
      </p>

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

/** Known built-in block renderers registered in SNL-Basics `defaultRenderers`. */
const BLOCK_RENDERER_PRESETS: ReadonlyArray<{
  key: string;
  label: string;
  hint: string;
}> = [
  { key: 'list', label: 'list', hint: 'Unordered list — LaTeX \\begin{itemize} → <ul><li>…' },
  { key: 'enumerate', label: 'enumerate', hint: 'Ordered list — LaTeX \\begin{enumerate} → <ol><li>…' },
  { key: 'table', label: 'table', hint: 'Table — variadic children are rows; first child with kind="table-header" becomes <thead>.' },
  { key: 'centered', label: 'centered', hint: 'Horizontally-centered block wrapper.' }
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
function BlockRendererPresetControl({
  value,
  onChange
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
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
      ? BLOCK_RENDERER_PRESETS.find((p) => p.key === value)?.hint ?? ''
      : mode === 'custom'
        ? 'Custom render key — consumer must register a matching renderer. Empty key = no dispatch.'
        : 'No render preset. The block will render with plain default layout.';

  return (
    <div style={{ marginBottom: '1rem' }}>
      <label htmlFor="m-rkey-preset" style={labelStyle}>
        Render preset
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
          <option value="">— none —</option>
          {BLOCK_RENDERER_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          <option value="__custom__">Custom key…</option>
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
      title="Double-click to rename"
    >
      {tag.trim() || '(empty)'}
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
                placeholder="Search entry id or title…"
              />
            </div>
            <SmallButton onClick={() => remove(i)}>−</SmallButton>
          </div>
        </div>
      ))}
      <SmallButton onClick={add}>+ Add</SmallButton>
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
                doesn't start with http
              </p>
            ) : null}
          </div>
        );
      })}
      <SmallButton onClick={add}>+ Add</SmallButton>
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
  options: string[];
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
            key={opt}
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
              value={opt}
              checked={value === opt}
              onChange={() => onChange(opt)}
            />
            {opt}
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
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <RadioGroup
        legend="Synthesis mode"
        name={name}
        value={value}
        options={['formula', 'text']}
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
  { children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { children: React.ReactNode }) {
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
          Preview error: {this.state.error}
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
  if (status.kind !== 'created' && status.kind !== 'updated') {
    return null;
  }
  const verb = status.kind === 'created' ? 'Created' : 'Updated';
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
      <span>{verb} "{status.name}"</span>
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
    text = `\u274c Invalid: ${status.reason}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noFile' ||
    status.kind === 'noWorkspace' ||
    status.kind === 'noSnlDoc'
  ) {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = `\u274c Error: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }
  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
