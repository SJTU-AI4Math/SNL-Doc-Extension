// SNL Create Macro editor: the full macro form + a customizable Live Preview.
//
// The preview renders the being-edited macro (registered under `_snl_draft`)
// applied to a set of argument slots. Empty slots render as translucent
// numbered placeholder boxes (via injected `_snl_arg_N` macros); non-empty
// slots are parsed as SNL source and substituted as real subtrees.
//
// v5 layout (Macro Editor UI overhaul, 2026-07-03):
//   1. Basic fields:  Name + Description        (top)
//   2. Kind:          single-line control       (also top-cluster)
//   3. Styles bar:    ★ marks styles[0] (the implicit default). Hovering a
//                     style / control tab flips its background for feedback.
//                     Up-arrow moves a style toward index 0 (default).
//   4. Style editor:  tag + Mode + Display + Variadic join + Renderer key
//   5. Content tabs:  KaTeX template + Typst/LaTeX/Markdown/Text
//                     • Preview canvas lives INSIDE the KaTeX template tab,
//                       ABOVE the textarea (other backends have no preview).
//   6. Arity:         one-line control ABOVE Argument overrides
//   7. Argument overrides
//   8. Sources:       moved to the BOTTOM, above the Create button
//   9. Create button
//
// The on-disk macro shape is v5: `styles` is an ordered array, mode/display
// live on each style, `defaultStyle` is gone (styles[0] is the implicit
// default).

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
const MAX_ARGS = 8;

/** One placeholder macro per index — a rounded translucent numbered box. */
const ARG_PLACEHOLDER_MACROS: Record<string, SnlMacro> = {};
for (let i = 0; i < MAX_ARGS; i++) {
  ARG_PLACEHOLDER_MACROS[`_snl_arg_${i}`] = {
    name: `_snl_arg_${i}`,
    description: `Argument placeholder ${i}`,
    source: { entries: [], urls: [] },
    arity: 'fixed',
    styles: [
      {
        // The view layer auto-wraps this in \htmlData; kind=argPlaceholder comes
        // from placeholderNode's node.kind. The frame is drawn purely in CSS via
        // \htmlClass{snlArgPlaceholder}; KaTeX just renders the digit (no \boxed).
        tag: 'default',
        mode: 'formula',
        template: `\\htmlClass{snlArgPlaceholder}{${i}}`
      }
    ]
  };
}

function placeholderNode(i: number): SnlSyntaxTree {
  return { name: `_snl_arg_${i}`, kind: 'argPlaceholder', mdata: null, children: [] };
}

// ---------------------------------------------------------------------------
// Types / helpers
// ---------------------------------------------------------------------------

type Arity = 'fixed' | 'variadic';
type Mode = 'formula' | 'text' | 'block';
type Display = 'inline' | 'block';
type SynthesisMode = 'formula' | 'text';

/** Editable per-style draft — flat mirror of {@link ExtendedSnlMacroStyle}. */
interface StyleDraft {
  tag: string;
  mode: Mode;
  display: Display; // 'inline' when mode !== 'formula' (harmless — ignored on save)
  template: string;
  variadic_join: string;
  react_renderer_key: string;
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
    mode: 'formula',
    display: 'inline',
    template: '',
    variadic_join: '',
    react_renderer_key: '',
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
  if (s.mode === 'formula' && s.display === 'block') {
    out.display = 'block';
  }
  if (s.variadic_join) {
    out.variadic_join = s.variadic_join;
  }
  if (s.mode !== 'formula' && s.react_renderer_key) {
    out.react_renderer_key = s.react_renderer_key;
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
 * One render style of the extended, on-disk macro shape (v5). A superset of
 * the library's `SnlMacroStyle`: additionally carries the consumer-owned
 * output backends (typst / latex / markdown / text) per style.
 */
interface ExtendedSnlMacroStyle {
  tag: string;
  mode: Mode;
  display?: Display;
  template: string;
  variadic_join?: string;
  react_renderer_key?: string;
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
 * The extended, on-disk macro shape written to a package file (v5). Superset
 * of the library's render-only `SnlMacro`: the output backends live inside
 * each style. The preview DB uses the slim lib `SnlMacro`; only the
 * save-to-disk path uses this shape.
 */
interface ExtendedSnlMacro {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind?: string;
  arity: Arity;
  styles: ExtendedSnlMacroStyle[];
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; name: string }
  | { kind: 'updated'; name: string }
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

  const [arity, setArity] = useState<Arity>('fixed');
  const [kind, setKind] = useState<string>('');

  // Ordered styles array (v5). At least one style always exists; `styles[0]` is
  // the implicit default (marked ★). `activeStyle` is the style currently
  // being edited in the Content tabs and used as the preview's style.
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
   * state. Fields not present in the on-disk record fall back to sensible
   * defaults. `name` is set from the record but the UI renders it readonly in
   * edit mode.
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
    setArity(existing.arity === 'variadic' ? 'variadic' : 'fixed');
    setKind(existing.kind ?? '');
    const drafts: StyleDraft[] = Array.isArray(existing.styles)
      ? existing.styles.map((s) => ({
          tag: s.tag ?? 'default',
          mode: (s.mode as Mode) ?? 'formula',
          display: (s.display as Display) ?? 'inline',
          template: s.template ?? '',
          variadic_join: s.variadic_join ?? '',
          react_renderer_key: s.react_renderer_key ?? '',
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
          setStatus({ kind: 'created', name: msg.name });
          break;
        case 'updated':
          setStatus({ kind: 'updated', name: msg.name });
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

  // --- Draft macro + preview DB -------------------------------------------

  const draftMacro: SnlMacro = useMemo(() => {
    const styleList: SnlMacroStyle[] = styles.map((s) => {
      const style: SnlMacroStyle = {
        tag: s.tag.trim() || 'default',
        mode: s.mode,
        template: s.template
      };
      if (s.mode === 'formula' && s.display === 'block') {
        style.display = 'block';
      }
      if (s.variadic_join) {
        style.variadic_join = s.variadic_join;
      }
      if (s.mode !== 'formula' && s.react_renderer_key) {
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
      arity,
      kind: kind || undefined,
      styles: styleList.length > 0 ? styleList : [{ tag: 'default', mode: 'formula', template: '' }]
    };
  }, [arity, kind, styles, activeStyle]);

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
    if (arity === 'variadic') {
      return Math.min(Math.max(variadicArgCount, 0), MAX_ARGS);
    }
    const derived = maxChildIndex(current?.template ?? '') + 1;
    return Math.min(Math.max(derived, 0), MAX_ARGS);
  }, [arity, variadicArgCount, current]);

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
  }, [argCount, previewArgs]);

  // --- Validation ----------------------------------------------------------

  const trimmedName = name.trim();
  // In edit mode, `trimmedName` is the identity of the macro being edited, so
  // its own presence in existingNames must NOT count as a duplicate. Only a
  // create-mode collision blocks submission.
  const isDuplicate =
    panelMode === 'edit' ? false : existingNames.includes(trimmedName);
  const defaultStyleDraft = styles[0];
  const templateEmpty = (defaultStyleDraft?.template ?? '').trim().length === 0;
  const tags = styles.map((s) => s.tag.trim());
  const hasEmptyTag = tags.some((t) => t.length === 0);
  const hasDupTag = new Set(tags).size !== tags.length;
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
    const macro: ExtendedSnlMacro = {
      name: trimmedName,
      description: description.trim(),
      source: {
        entries: sourceEntries.map((s) => s.trim()).filter((s) => s.length > 0),
        urls: sourceUrls.map((s) => s.trim()).filter((s) => s.length > 0)
      },
      kind: kind || undefined,
      arity,
      styles: styleList
    };
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: panelMode === 'edit' ? 'update' : 'create',
      macro
    });
  }

  const showPreview = activeTab === 'katex_template';

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '60rem' }}>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.35rem' }}>
        {panelMode === 'edit' ? 'Edit Macro' : 'Create Macro'} in{' '}
        <code>{file || '\u2026'}</code>
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.75 }}>
        Package: <strong>{packageName || '\u2014'}</strong>
      </p>

      {/* --- Basic fields (Name + Description) ------------------------------ */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
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
          {isDuplicate ? (
            <p
              style={{
                margin: '0.25rem 0 0',
                fontSize: '0.8rem',
                color: 'var(--vscode-errorForeground, #f48771)'
              }}
            >
              A macro named "{trimmedName}" already exists in this package.
            </p>
          ) : null}
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

      {existingNames.length > 0 ? (
        <p style={{ margin: '-0.5rem 0 1rem', fontSize: '0.8rem', opacity: 0.65 }}>
          Already taken: {existingNames.join(', ')}
        </p>
      ) : null}

      {/* --- Kind (single line, no section header) ------------------------- */}
      <div style={{ marginBottom: '1rem' }}>
        <label htmlFor="m-kind" style={labelStyle}>
          Kind
        </label>
        <select
          id="m-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          style={{ ...inputStyle, width: '14rem' }}
        >
          <option value="">(unset)</option>
          {macroKinds.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name} ({k.id})
            </option>
          ))}
        </select>
        {kind ? (
          (() => {
            const sel = macroKinds.find((k) => k.id === kind);
            return sel ? (
              <span
                title={`stroke ${sel.coloring.stroke} / background ${sel.coloring.background}`}
                style={{
                  display: 'inline-block',
                  width: '1.4rem',
                  height: '1.1rem',
                  marginLeft: '0.5rem',
                  verticalAlign: 'middle',
                  borderRadius: '3px',
                  background: sel.coloring.background,
                  border: `2px solid ${sel.coloring.stroke}`
                }}
              />
            ) : null;
          })()
        ) : null}
        {macroKinds.length === 0 ? (
          <p
            style={{
              margin: '0.3rem 0 0',
              fontSize: '0.8rem',
              opacity: 0.7
            }}
          >
            No macro kinds defined — initialize them from the Dashboard.
          </p>
        ) : null}
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

      {/* --- Preview canvas (only under the KaTeX template tab, above the
             template textarea — no other backend can render a live preview) */}
      {showPreview ? (
        <div className="snl-preview-canvas" style={{ marginBottom: '0.6rem' }}>
          <PreviewBoundary
            key={
              (current?.template ?? '') +
              arity +
              (current?.mode ?? '') +
              (current?.display ?? '') +
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
      ) : null}

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

      {activeTab === 'katex_template' ? (
        <p style={{ margin: '0 0 0.5rem', opacity: 0.75, fontSize: '0.8rem' }}>
          LaTeX template — use <code>#0</code>, <code>#1</code>, … for children,{' '}
          <code>#*</code> for variadic. <code>\#</code> = literal <code>#</code>. Do
          NOT write <code>\htmlData</code> — the wrapper is added automatically.
        </p>
      ) : null}

      <textarea
        value={(current?.[TAB_FIELD[activeTab]] as string) ?? ''}
        onChange={(e) => patchStyle({ [TAB_FIELD[activeTab]]: e.target.value })}
        placeholder={
          activeTab === 'katex_template'
            ? 'e.g. \\frac{#0}{#1}'
            : ''
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

      {/* --- Arity (single line, sits above Argument overrides) ------------ */}
      <div style={{ marginBottom: '0.5rem' }}>
        <RadioGroup
          legend="Arity"
          name="arity"
          value={arity}
          options={['fixed', 'variadic']}
          onChange={(v) => setArity(v as Arity)}
        />
      </div>

      {/* --- Argument overrides -------------------------------------------- */}
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
          <strong style={{ fontSize: '0.9rem' }}>Argument overrides</strong>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {arity === 'variadic' ? (
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
            {arity === 'fixed'
              ? 'No #N placeholders in the template — nothing to fill.'
              : 'No argument slots. Use “+ Add Arg”.'}
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
        <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>
          {templateEmpty ? 'KaTeX template is required.' : ''}
        </span>
      </div>

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

  return (
    <>
      <SectionHeader title="Styles" />
      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        {styles.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
            <TabButton active={i === activeStyle} onClick={() => setActiveStyle(i)}>
              {s.tag.trim() || '(empty)'}
              {i === 0 ? ' ★' : ''}
            </TabButton>
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
        <strong>↑</strong> to make another style the default.
      </p>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1.5rem',
          marginBottom: '1rem',
          alignItems: 'flex-start'
        }}
      >
        <div>
          <label htmlFor="m-style-tag" style={labelStyle}>
            Style tag
          </label>
          <input
            id="m-style-tag"
            type="text"
            value={current?.tag ?? ''}
            placeholder="e.g. infix"
            onChange={(e) => patchStyle({ tag: e.target.value })}
            style={{ ...inputStyle, width: '12rem' }}
          />
        </div>
        <RadioGroup
          legend="Mode"
          name="mode"
          value={current?.mode ?? 'formula'}
          options={['formula', 'text', 'block']}
          onChange={(v) => patchStyle({ mode: v as Mode })}
        />
        {(current?.mode ?? 'formula') === 'formula' ? (
          <RadioGroup
            legend="Display"
            name="display"
            value={current?.display ?? 'inline'}
            options={['inline', 'block']}
            onChange={(v) => patchStyle({ display: v as Display })}
          />
        ) : null}
        <div>
          <label htmlFor="m-vjoin" style={labelStyle}>
            Variadic join
          </label>
          <input
            id="m-vjoin"
            type="text"
            value={current?.variadic_join ?? ''}
            placeholder=", "
            onChange={(e) => patchStyle({ variadic_join: e.target.value })}
            style={{ ...inputStyle, width: '8rem' }}
          />
        </div>
        {(current?.mode ?? 'formula') !== 'formula' ? (
          <div>
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
      </div>
    </>
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
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        transition: 'background 80ms ease'
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

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }
  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `\u2705 Created macro "${status.name}".`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = `\u2705 Updated macro "${status.name}".`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
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
