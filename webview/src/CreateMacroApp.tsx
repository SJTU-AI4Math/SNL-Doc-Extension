// SNL Create/Edit Macro editor (v6 schema, 2026-07-04 UI overhaul).
//
// The preview renders the being-edited macro (registered under `_snl_draft`)
// applied to a set of argument slots. Empty slots render as translucent
// numbered placeholder boxes (via injected `_snl_arg_N` macros); non-empty
// slots are parsed as SNL source and substituted as real subtrees.
//
// v6 schema (see snlDoc.ts / @snl-basics/react):
//   - `mode` is 4 flat parallel values:
//     formula_inline / formula_display / text / block
//     (old `display` axis is folded into mode itself).
//   - `dynamic_arity: boolean` replaces `arity: 'fixed' | 'variadic'`.
//     UI: single checkbox "☐ Dynamic Arity". When ticked, the KaTeX
//     template textarea shrinks to leave room for three delimiter fields
//     (Left / Separator / Right) that populate `variadic_left` /
//     `variadic_join` / `variadic_right` on the style.
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
import 'katex/dist/katex.min.css';
import '@snl-basics/react/style.css';
import './create-macro.css';
import {
  tryParseSnlSyntaxTree,
  createMacroTemplateQueryFromDb,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  bundledMacroDb,
  type SnlMacro,
  type SnlMacroDb,
  type SnlMacroStyle,
  type SnlSyntaxTree,
  type SnlRenderHooks,
  type KindPalette
} from '@snl-basics/react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

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
    styles: [
      {
        tag: 'default',
        mode: 'formula_inline',
        template: `\\mathord{\\htmlClass{snlArgPlaceholder}{${i}}}`
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
  styles: [
    {
      tag: 'default',
      mode: 'text',
      template: 'SNL Macro Preview'
    }
  ]
};

function placeholderNode(i: number): SnlSyntaxTree {
  return { name: `_snl_arg_${i}`, kind: 'argPlaceholder', mdata: null, children: [] };
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

/** Editable per-style draft — flat mirror of {@link ExtendedSnlMacroStyle}. */
interface StyleDraft {
  tag: string;
  mode: Mode;
  template: string;
  variadic_left: string;
  variadic_join: string;
  variadic_right: string;
  react_renderer_key: string;
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

function newStyleDraft(tag: string): StyleDraft {
  return {
    tag,
    mode: 'formula_inline',
    template: '',
    variadic_left: '',
    variadic_join: '',
    variadic_right: '',
    react_renderer_key: '',
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

/** Serialize a {@link StyleDraft} into the on-disk per-style shape. */
function styleDraftToExtended(s: StyleDraft): ExtendedSnlMacroStyle {
  const out: ExtendedSnlMacroStyle = {
    tag: s.tag.trim(),
    mode: s.mode,
    template: s.template
  };
  if (s.variadic_left) {
    out.variadic_left = s.variadic_left;
  }
  if (s.variadic_join) {
    out.variadic_join = s.variadic_join;
  }
  if (s.variadic_right) {
    out.variadic_right = s.variadic_right;
  }
  if ((s.mode === 'text' || s.mode === 'block') && s.react_renderer_key) {
    out.react_renderer_key = s.react_renderer_key;
  }
  const trimmedTags = s.tags.map((t) => t.trim()).filter((t) => t.length > 0);
  if (trimmedTags.length > 0) {
    out.tags = trimmedTags;
  }
  out.typst = {
    built_in: s.typst_built_in,
    synthesis: { mode: s.typst_synthesis_mode, macro: s.typst_synthesis }
  };
  out.latex = {
    built_in: s.latex_built_in,
    synthesis: { mode: s.latex_synthesis_mode, macro: s.latex_synthesis }
  };
  out.markdown = s.markdown;
  out.text = s.text;
  return out;
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
interface ExtendedSnlMacroStyle {
  tag: string;
  mode: Mode;
  template: string;
  variadic_left?: string;
  variadic_join?: string;
  variadic_right?: string;
  react_renderer_key?: string;
  tags?: string[];
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
  tags?: string[];
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
  macroKinds?: MacroKind[];
  existing?: ExtendedSnlMacro | null;
}

type Incoming =
  | ContextMsg
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
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  const [panelMode, setPanelMode] = useState<PanelMode>('create');
  const [file, setFile] = useState('');
  const [packageName, setPackageName] = useState('');
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);

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
    setStyles((prev) =>
      prev.map((s, i) => (i === activeStyle ? { ...s, ...patch } : s))
    );
  }

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
      ? existing.styles.map((s) => ({
          tag: s.tag ?? 'default',
          mode: (s.mode as Mode) ?? 'formula_inline',
          template: s.template ?? '',
          variadic_left: s.variadic_left ?? '',
          variadic_join: s.variadic_join ?? '',
          variadic_right: s.variadic_right ?? '',
          react_renderer_key: s.react_renderer_key ?? '',
          tags: Array.isArray(s.tags) ? s.tags.slice() : [],
          typst_built_in: s.typst?.built_in ?? '',
          typst_synthesis: s.typst?.synthesis?.macro ?? '',
          typst_synthesis_mode: (s.typst?.synthesis?.mode as SynthesisMode) ?? 'formula',
          latex_built_in: s.latex?.built_in ?? '',
          latex_synthesis: s.latex?.synthesis?.macro ?? '',
          latex_synthesis_mode: (s.latex?.synthesis?.mode as SynthesisMode) ?? 'formula',
          markdown: s.markdown ?? '',
          text: s.text ?? ''
        }))
      : [newStyleDraft('default')];
    setStyles(drafts.length > 0 ? drafts : [newStyleDraft('default')]);
    setActiveStyle(0);
    setActiveTab('katex_template');
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
          setMacroKinds(Array.isArray(msg.macroKinds) ? msg.macroKinds : []);
          if (msg.mode === 'edit' && msg.existing) {
            hydrateFromExisting(msg.existing);
          }
          break;
        case 'created':
          setStatus({ kind: 'created', name: msg.name, at: Date.now() });
          break;
        case 'updated':
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
    return () => window.removeEventListener('message', onMessage);
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
      const style: SnlMacroStyle = {
        tag: s.tag.trim() || 'default',
        mode: s.mode,
        template: s.template
      };
      if (s.variadic_left) {
        style.variadic_left = s.variadic_left;
      }
      if (s.variadic_join) {
        style.variadic_join = s.variadic_join;
      }
      if (s.variadic_right) {
        style.variadic_right = s.variadic_right;
      }
      if ((s.mode === 'text' || s.mode === 'block') && s.react_renderer_key) {
        style.react_renderer_key = s.react_renderer_key;
      }
      return style;
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
      styles:
        styleList.length > 0
          ? styleList
          : [{ tag: 'default', mode: 'formula_inline', template: '' }]
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

  const previewMacroDb: SnlMacroDb = useMemo(
    () => ({
      ...bundledMacroDb,
      ...ARG_PLACEHOLDER_MACROS,
      [PREVIEW_PLACEHOLDER_KEY]: PREVIEW_PLACEHOLDER_MACRO,
      [DRAFT_KEY]: draftMacro
    }),
    [draftMacro]
  );

  const previewQuery = useMemo(
    () => createMacroTemplateQueryFromDb(previewMacroDb),
    [previewMacroDb]
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
        name: PREVIEW_PLACEHOLDER_KEY,
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
    return { name: DRAFT_KEY, kind: '', mdata: null, children };
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
  const tagList = styles.map((s) => s.tag.trim());
  const hasEmptyTag = tagList.some((t) => t.length === 0);
  const hasDupTag = new Set(tagList).size !== tagList.length;
  const canCreate =
    trimmedName.length > 0 &&
    !isDuplicate &&
    !templateEmpty &&
    !hasEmptyTag &&
    !hasDupTag &&
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

  function handleSubmit(): void {
    if (!canCreate) {
      return;
    }
    const styleList: ExtendedSnlMacroStyle[] = styles
      .filter((s) => s.tag.trim().length > 0)
      .map(styleDraftToExtended);
    const trimmedMacroTags = macroTags
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const macro: ExtendedSnlMacro = {
      name: trimmedName,
      description: description.trim(),
      source: {
        entries: sourceEntries.map((s) => s.trim()).filter((s) => s.length > 0),
        urls: sourceUrls.map((s) => s.trim()).filter((s) => s.length > 0)
      },
      kind: kind || undefined,
      dynamic_arity: dynamicArity,
      styles: styleList
    };
    if (trimmedMacroTags.length > 0) {
      macro.tags = trimmedMacroTags;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: panelMode === 'edit' ? 'update' : 'create',
      macro
    });
  }

  const showPreview = activeTab === 'katex_template';
  const titlePackage = packageName || file || '\u2026';

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '64rem' }}>
      <h1 style={{ margin: '0 0 1rem', fontSize: '1.35rem' }}>
        {panelMode === 'edit' ? 'Edit Macro' : 'Create Macro'} in{' '}
        <code>{titlePackage}</code>
      </h1>

      {/* --- Row 1: Name (1/4) | Kind (1/4) | Description (1/2) ------------- */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 2fr',
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
          <input
            id="m-name"
            type="text"
            value={name}
            placeholder="e.g. Add.add"
            onChange={(e) => setName(e.target.value)}
            readOnly={panelMode === 'edit'}
            title={
              panelMode === 'edit'
                ? 'Macro names are immutable; delete + recreate to rename'
                : undefined
            }
            style={{
              ...inputStyle,
              width: '100%',
              borderColor: isDuplicate
                ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
                : undefined,
              color:
                panelMode === 'edit'
                  ? 'var(--vscode-descriptionForeground, #999)'
                  : (inputStyle as React.CSSProperties).color,
              opacity: panelMode === 'edit' ? 0.7 : 1,
              cursor: panelMode === 'edit' ? 'not-allowed' : 'text'
            }}
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
              onChange={(e) => setKind(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="">(unset)</option>
              {macroKinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.id})
                </option>
              ))}
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
      <SectionHeader title={`Content — style "${current?.tag || 'default'}"`} />
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
            onChange={(v) => patchStyle({ mode: v })}
          />
          {/* Right column: Preview + template body (grows). */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="snl-preview-canvas" style={{ marginBottom: '0.6rem' }}>
              <PreviewBoundary
                key={
                  (current?.template ?? '') +
                  dynamicArity +
                  (current?.mode ?? '') +
                  (current?.tag ?? '')
                }
              >
                <SnlSyntaxTreeView
                  tree={draftTree}
                  macroDb={previewMacroDb}
                  query={previewQuery}
                  hooks={hooks}
                  kindPalette={kindPalette}
                />
              </PreviewBoundary>
            </div>
            <p style={{ margin: '0 0 0.5rem', opacity: 0.75, fontSize: '0.8rem' }}>
              LaTeX template — use <code>#0</code>, <code>#1</code>, … for
              children, <code>#*</code> for dynamic-arity variadic.{' '}
              <code>\#</code> = literal <code>#</code>. Do NOT write{' '}
              <code>\htmlData</code> — the wrapper is added automatically.
            </p>
            {dynamicArity ? (
              <DynamicArityTemplateRow
                template={current?.template ?? ''}
                left={current?.variadic_left ?? ''}
                sep={current?.variadic_join ?? ''}
                right={current?.variadic_right ?? ''}
                onTemplate={(v) => patchStyle({ template: v })}
                onLeft={(v) => patchStyle({ variadic_left: v })}
                onSep={(v) => patchStyle({ variadic_join: v })}
                onRight={(v) => patchStyle({ variadic_right: v })}
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
        legend={`Style tags — "${current?.tag || 'default'}"`}
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
            onChange={(e) => setDynamicArity(e.target.checked)}
          />
          Dynamic Arity
        </label>
        <span style={{ opacity: 0.65, fontSize: '0.85rem' }}>
          when ticked, the template can use <code>#*</code> for a variable
          number of children with delimiters + separator
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
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '1rem',
          marginBottom: '1rem'
        }}
      >
        <ListEditor
          label="Entries"
          placeholder="entry id"
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
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canCreate}
          style={primaryButton(canCreate)}
        >
          {status.kind === 'creating'
            ? panelMode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
            : panelMode === 'edit' ? 'Update Macro' : 'Create Macro'}
        </button>
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
    <button
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
    </button>
  );
}

/**
 * Dynamic-arity template row. Renders as:
 *   [ Left delim ]  [ main template (wide) with #* ]  [ Separator ]  [ Right delim ]
 * so the author can see the assembled shape at a glance. Actually
 * horizontally stacked: main template is a full textarea; delimiters are
 * single-line inputs.
 */
function DynamicArityTemplateRow({
  template,
  left,
  sep,
  right,
  onTemplate,
  onLeft,
  onSep,
  onRight
}: {
  template: string;
  left: string;
  sep: string;
  right: string;
  onTemplate: (v: string) => void;
  onLeft: (v: string) => void;
  onSep: (v: string) => void;
  onRight: (v: string) => void;
}): React.ReactElement {
  const monoInput: React.CSSProperties = {
    ...inputStyle,
    fontFamily: 'var(--vscode-editor-font-family, monospace)'
  };
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
      <textarea
        value={template}
        onChange={(e) => onTemplate(e.target.value)}
        placeholder="e.g. \begin{pmatrix}#*\end{pmatrix}"
        rows={4}
        style={{
          ...inputStyle,
          flex: 1,
          fontFamily: 'var(--vscode-editor-font-family, monospace)',
          resize: 'vertical'
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.35rem',
          width: '12rem'
        }}
      >
        <input
          type="text"
          value={left}
          placeholder="Left delimiter"
          onChange={(e) => onLeft(e.target.value)}
          style={monoInput}
        />
        <input
          type="text"
          value={sep}
          placeholder="Separator"
          onChange={(e) => onSep(e.target.value)}
          style={monoInput}
        />
        <input
          type="text"
          value={right}
          placeholder="Right delimiter"
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
    const existing = new Set(styles.map((s) => s.tag));
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
    setStyles((prev) => prev.map((s, idx) => (idx === i ? { ...s, tag: next } : s)));
  };

  return (
    <>
      <SectionHeader title="Styles" />
      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {styles.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
            <StyleSwitch
              tag={s.tag}
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

      {/* React renderer key row (only for text/block modes). No standalone
          `Style tag` field or `Variadic join` field any more — rename lives on
          the button itself, and dynamic-arity delimiters live next to the
          template textarea. */}
      {(current?.mode === 'text' || current?.mode === 'block') ? (
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="m-rkey" style={labelStyle}>
            React renderer key
          </label>
          <input
            id="m-rkey"
            type="text"
            value={current?.react_renderer_key ?? ''}
            placeholder="list | table | centered | (custom key)"
            onChange={(e) => patchStyle({ react_renderer_key: e.target.value })}
            style={{ ...inputStyle, width: '18rem' }}
          />
        </div>
      ) : null}
    </>
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
    <button
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
    </button>
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
    <button
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
    </button>
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
