// SNL Create Macro editor: the full macro form + a customizable Live Preview.
//
// The preview renders the being-edited macro (registered under `_snl_draft`)
// applied to a set of argument slots. Empty slots render as translucent
// numbered placeholder boxes (via injected `_snl_arg_N` macros); non-empty
// slots are parsed as SNL source and substituted as real subtrees.

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
    katex_react: {
      arity: 'fixed',
      mode: 'formula',
      // The view layer auto-wraps this in \htmlData; kind=argPlaceholder comes
      // from placeholderNode's node.kind. The frame is drawn purely in CSS via
      // \htmlClass{snlArgPlaceholder}; KaTeX just renders the digit (no \boxed).
      template: `\\htmlClass{snlArgPlaceholder}{${i}}`
    }
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

/** A user-defined macro kind, sent from the extension host with `context`. */
interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
}

/**
 * The extended, on-disk macro shape written to a package file. It is a superset
 * of the library's render-only `SnlMacro` (0.4.0): it additionally carries the
 * consumer-owned output backends (typst / latex / markdown / text). The preview
 * DB uses the slim lib `SnlMacro`; only the save-to-disk path uses this shape.
 */
interface ExtendedSnlMacro {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  typst: {
    built_in: string;
    synthesis: { mode: SynthesisMode; macro: string };
  };
  latex: {
    built_in: string;
    synthesis: { mode: SynthesisMode; macro: string };
  };
  markdown: string;
  text: string;
  katex_react: {
    arity: Arity;
    mode: Mode;
    display?: Display;
    kind?: string;
    template: string;
    variadic_join?: string;
    react_renderer_key?: string;
  };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; name: string }
  | { kind: 'duplicate'; name: string; message: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'noFile'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

interface ContextMsg {
  type: 'context';
  file: string;
  packageName: string;
  existingNames: string[];
  macroKinds?: MacroKind[];
}

type Incoming =
  | ContextMsg
  | { type: 'created'; name: string }
  | { type: 'duplicate'; name: string; message: string }
  | { type: 'invalid'; reason: string }
  | { type: 'noFile'; message: string }
  | { type: 'noWorkspace'; message: string }
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

  const [file, setFile] = useState('');
  const [packageName, setPackageName] = useState('');
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [macroKinds, setMacroKinds] = useState<MacroKind[]>([]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sourceEntries, setSourceEntries] = useState<string[]>(['']);
  const [sourceUrls, setSourceUrls] = useState<string[]>(['']);

  const [arity, setArity] = useState<Arity>('fixed');
  const [mode, setMode] = useState<Mode>('formula');
  const [display, setDisplay] = useState<Display>('inline');
  const [kind, setKind] = useState<string>('');
  const [variadicJoin, setVariadicJoin] = useState('');
  const [reactRendererKey, setReactRendererKey] = useState('');

  const [content, setContent] = useState({
    katex_template: '',
    typst_built_in: '',
    typst_synthesis: '',
    latex_built_in: '',
    latex_synthesis: '',
    markdown: '',
    text: ''
  });
  const [typstSynthesisMode, setTypstSynthesisMode] = useState<SynthesisMode>('formula');
  const [latexSynthesisMode, setLatexSynthesisMode] = useState<SynthesisMode>('formula');

  const [activeTab, setActiveTab] = useState<TabId>('katex_template');

  const [previewArgs, setPreviewArgs] = useState<string[]>(['', '', '', '']);
  const [variadicArgCount, setVariadicArgCount] = useState(3);

  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    apiRef.current = getVsCodeApi();
    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setFile(msg.file);
          setPackageName(msg.packageName);
          setExistingNames(Array.isArray(msg.existingNames) ? msg.existingNames : []);
          setMacroKinds(Array.isArray(msg.macroKinds) ? msg.macroKinds : []);
          break;
        case 'created':
          setStatus({ kind: 'created', name: msg.name });
          break;
        case 'duplicate':
          setStatus({ kind: 'duplicate', name: msg.name, message: msg.message });
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

  const draftMacro: SnlMacro = useMemo(
    () => ({
      name: DRAFT_KEY,
      description: '',
      source: { entries: [], urls: [] },
      katex_react: {
        arity,
        mode,
        display: mode === 'formula' && display === 'block' ? 'block' : undefined,
        kind: kind || undefined,
        template: content.katex_template,
        variadic_join: variadicJoin || undefined,
        react_renderer_key: reactRendererKey || undefined
      }
    }),
    [arity, mode, display, kind, content.katex_template, variadicJoin, reactRendererKey]
  );

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
    const derived = maxChildIndex(content.katex_template) + 1;
    return Math.min(Math.max(derived, 0), MAX_ARGS);
  }, [arity, variadicArgCount, content.katex_template]);

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
  const isDuplicate = existingNames.includes(trimmedName);
  const templateEmpty = content.katex_template.trim().length === 0;
  const canCreate =
    trimmedName.length > 0 &&
    !isDuplicate &&
    !templateEmpty &&
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

  function handleCreate(): void {
    if (!canCreate) {
      return;
    }
    const macro: ExtendedSnlMacro = {
      name: trimmedName,
      description: description.trim(),
      source: {
        entries: sourceEntries.map((s) => s.trim()).filter((s) => s.length > 0),
        urls: sourceUrls.map((s) => s.trim()).filter((s) => s.length > 0)
      },
      typst: {
        built_in: content.typst_built_in,
        synthesis: { mode: typstSynthesisMode, macro: content.typst_synthesis }
      },
      latex: {
        built_in: content.latex_built_in,
        synthesis: { mode: latexSynthesisMode, macro: content.latex_synthesis }
      },
      markdown: content.markdown,
      text: content.text,
      katex_react: {
        arity,
        mode,
        display: mode === 'formula' && display === 'block' ? 'block' : undefined,
        kind: kind || undefined,
        template: content.katex_template,
        variadic_join: variadicJoin ? variadicJoin : undefined,
        react_renderer_key:
          mode !== 'formula' && reactRendererKey ? reactRendererKey : undefined
      }
    };
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({ type: 'create', macro });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '60rem' }}>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.35rem' }}>
        Create Macro in <code>{file || '…'}</code>
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.75 }}>
        Package: <strong>{packageName || '—'}</strong>
      </p>

      {/* --- Basic fields --------------------------------------------------- */}
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
            Name <span style={{ opacity: 0.6 }}>(unique)</span>
          </label>
          <input
            id="m-name"
            type="text"
            value={name}
            placeholder="e.g. Add.add.infix"
            onChange={(e) => setName(e.target.value)}
            style={{
              ...inputStyle,
              width: '100%',
              borderColor: isDuplicate
                ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
                : undefined
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

      {/* --- Source --------------------------------------------------------- */}
      <SectionHeader title="Source" />
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

      {/* --- Behavior ------------------------------------------------------- */}
      <SectionHeader title="Behavior" />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1.5rem',
          marginBottom: '1rem',
          alignItems: 'flex-start'
        }}
      >
        <RadioGroup
          legend="Arity"
          name="arity"
          value={arity}
          options={['fixed', 'variadic']}
          onChange={(v) => setArity(v as Arity)}
        />
        <RadioGroup
          legend="Mode"
          name="mode"
          value={mode}
          options={['formula', 'text', 'block']}
          onChange={(v) => setMode(v as Mode)}
        />
        {mode === 'formula' ? (
          <RadioGroup
            legend="Display"
            name="display"
            value={display}
            options={['inline', 'block']}
            onChange={(v) => setDisplay(v as Display)}
          />
        ) : null}
        <div>
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
        {arity === 'variadic' ? (
          <div>
            <label htmlFor="m-vjoin" style={labelStyle}>
              Variadic join
            </label>
            <input
              id="m-vjoin"
              type="text"
              value={variadicJoin}
              placeholder=", "
              onChange={(e) => setVariadicJoin(e.target.value)}
              style={{ ...inputStyle, width: '8rem' }}
            />
          </div>
        ) : null}
        {mode !== 'formula' ? (
          <div>
            <label htmlFor="m-rkey" style={labelStyle}>
              React renderer key
            </label>
            <input
              id="m-rkey"
              type="text"
              value={reactRendererKey}
              placeholder="list | table | centered | (custom key)"
              onChange={(e) => setReactRendererKey(e.target.value)}
              style={{ ...inputStyle, width: '18rem' }}
            />
          </div>
        ) : null}
      </div>

      {/* --- Content tabs --------------------------------------------------- */}
      <SectionHeader title="Content" />
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
            {tab.id === 'katex_template' && templateEmpty ? ' *' : ''}
          </TabButton>
        ))}
      </div>

      {activeTab === 'typst_synthesis' ? (
        <SynthesisModeRow
          name="typst-synthesis-mode"
          value={typstSynthesisMode}
          onChange={setTypstSynthesisMode}
        />
      ) : null}
      {activeTab === 'latex_synthesis' ? (
        <SynthesisModeRow
          name="latex-synthesis-mode"
          value={latexSynthesisMode}
          onChange={setLatexSynthesisMode}
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
        value={content[activeTab]}
        onChange={(e) =>
          setContent((prev) => ({ ...prev, [activeTab]: e.target.value }))
        }
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

      {/* --- Live preview --------------------------------------------------- */}
      <SectionHeader title="Preview" />
      <div className="snl-preview-canvas" style={{ marginBottom: '0.75rem' }}>
        <PreviewBoundary key={content.katex_template + arity + mode + display}>
          <SnlSyntaxTreeView
            tree={draftTree}
            macroDb={previewMacroDb}
            query={previewQuery}
            hooks={hooks}
            kindPalette={kindPalette}
          />
        </PreviewBoundary>
      </div>

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

      {/* --- Submit --------------------------------------------------------- */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button
          type="button"
          onClick={handleCreate}
          disabled={!canCreate}
          style={primaryButton(canCreate)}
        >
          {status.kind === 'creating' ? 'Creating…' : 'Create Macro'}
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

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.3rem 0.7rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        borderBottom: active
          ? '2px solid var(--vscode-focusBorder, #0e639c)'
          : '1px solid var(--vscode-panel-border, #444)',
        background: active
          ? 'var(--vscode-tab-activeBackground, #1e1e1e)'
          : 'var(--vscode-tab-inactiveBackground, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '3px 3px 0 0',
        fontFamily: 'inherit',
        fontSize: '0.85rem',
        fontWeight: active ? 600 : 400
      }}
    >
      {children}
    </button>
  );
}

function SmallButton({
  onClick,
  children
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '0.2rem 0.55rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        borderRadius: '3px',
        fontFamily: 'inherit',
        fontSize: '0.8rem'
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
    text = `✅ Created macro "${status.name}".`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = `⚠️ ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'invalid') {
    text = `❌ Invalid: ${status.reason}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'noFile' || status.kind === 'noWorkspace') {
    text = `❌ ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = `❌ Error: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }
  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
