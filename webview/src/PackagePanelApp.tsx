// SNL Macro Package panel webview: lists the macros in one package file and
// offers a big-plus "+ Create Macro" bar. Each row shows a real KaTeX Preview
// (macro applied to numbered argument placeholders — same style as the
// CreateMacro editor's Live Preview) plus name / arity / modes / kind /
// styles / description columns.
//
// Preview strategy: build ONE preview macro DB per package load
// (`{ ...bundledMacroDb, ...ARG_PLACEHOLDER_MACROS, ...packageMacros }`) and
// pass it to every row. Each row constructs a syntax tree `{ macro.name,
// [placeholder_0, placeholder_1, ...] }` sized by max #N in the default
// style's template (fixed arity) or a fixed count (variadic). Row-level
// try/catch keeps a bad macro from crashing the whole table.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import '@snl-basics/react/style.css';
import './create-macro.css';
import {
  bundledMacroDb,
  createMacroTemplateQueryFromDb,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  type SnlMacro,
  type SnlMacroDb,
  type SnlSyntaxTree,
  type SnlRenderHooks
} from '@snl-basics/react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';

// Extended, on-disk macro shape — a superset of the library's render-only
// `SnlMacro` (0.7.0 styles system). It keeps the consumer-owned output backends
// (typst / latex / markdown / text) that this panel reads back, *per style*.
// v5: mode / display / tag live on each style, styles is an ordered array
// (styles[0] is the implicit default).
interface MacroPackageStyle {
  tag: string;
  mode: 'formula' | 'text' | 'block';
  display?: 'inline' | 'block';
  template: string;
  variadic_join?: string;
  react_renderer_key?: string;
  typst?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  latex?: { built_in: string; synthesis: { mode: 'formula' | 'text'; macro: string } };
  markdown?: string;
  text?: string;
}

interface MacroPackageEntry {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  kind?: string;
  arity: 'fixed' | 'variadic';
  styles: MacroPackageStyle[];
}

interface MacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
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
      macroKinds?: MacroKind[];
    }
  | { type: 'noFile'; file: string }
  | { type: 'error'; message: string }
  | undefined;

type Model =
  | { kind: 'loading' }
  | {
      kind: 'package';
      pkg: MacroPackageFile;
      file: string;
      macros: MacroPackageEntry[];
      macroKinds: MacroKind[];
    }
  | { kind: 'noFile'; file: string }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Preview constants — mirror the CreateMacro Live Preview so a package row's
// preview matches what the user sees while editing that macro.
// ---------------------------------------------------------------------------

const MAX_ARGS = 8;
const VARIADIC_PREVIEW_ARGS = 3;

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

/**
 * Convert an on-disk {@link MacroPackageEntry} to the render-only lib shape
 * `SnlMacro` (only the fields the view needs — drop typst/latex/markdown/text
 * backends; keep name/description/source/kind/arity/styles).
 */
function macroToLibShape(m: MacroPackageEntry): SnlMacro {
  const styles = Array.isArray(m.styles)
    ? m.styles.map((s) => {
        const out: SnlMacro['styles'][number] = {
          tag: s.tag,
          mode: s.mode,
          template: s.template
        };
        if (s.mode === 'formula' && s.display) {
          out.display = s.display;
        }
        if (s.variadic_join) {
          out.variadic_join = s.variadic_join;
        }
        if (s.mode !== 'formula' && s.react_renderer_key) {
          out.react_renderer_key = s.react_renderer_key;
        }
        return out;
      })
    : [];
  const lib: SnlMacro = {
    name: m.name,
    description: m.description ?? '',
    source: m.source ?? { entries: [], urls: [] },
    arity: m.arity,
    styles: styles.length > 0 ? styles : [{ tag: 'default', mode: 'formula', template: '' }]
  };
  if (m.kind) {
    lib.kind = m.kind;
  }
  return lib;
}

export function PackagePanelApp(): React.ReactElement {
  const [model, setModel] = useState<Model>({ kind: 'loading' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'package':
          setModel({
            kind: 'package',
            pkg: msg.pkg,
            file: msg.file,
            macros: Array.isArray(msg.macros) ? msg.macros : [],
            macroKinds: Array.isArray(msg.macroKinds) ? msg.macroKinds : []
          });
          break;
        case 'noFile':
          setModel({ kind: 'noFile', file: msg.file });
          break;
        case 'error':
          setModel({ kind: 'error', message: msg.message });
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const createMacro = (): void =>
    apiRef.current?.postMessage({ type: 'createMacro' });
  const editMacroPackage = (): void =>
    apiRef.current?.postMessage({ type: 'editMacroPackage' });
  const editMacro = (name: string): void =>
    apiRef.current?.postMessage({ type: 'editMacro', name });

  if (model.kind === 'loading') {
    return (
      <main style={PANEL_STYLE}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
          SNL Macro Package
        </h1>
        <p style={{ opacity: 0.7 }}>Loading package…</p>
      </main>
    );
  }

  if (model.kind === 'noFile') {
    return (
      <main style={{ ...PANEL_STYLE, maxWidth: '40rem' }}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
          SNL Macro Package
        </h1>
        <p style={{ opacity: 0.85 }}>
          The package file <code>{model.file}</code> does not exist (yet).
        </p>
      </main>
    );
  }

  if (model.kind === 'error') {
    return (
      <main style={{ ...PANEL_STYLE, maxWidth: '40rem' }}>
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
          SNL Macro Package
        </h1>
        <p style={{ color: 'var(--vscode-errorForeground, #f48771)' }}>
          ❌ {model.message}
        </p>
      </main>
    );
  }

  const { pkg, file, macros, macroKinds } = model;

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '58rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem'
        }}
      >
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem' }}>
            {pkg.name}
          </h1>
          <p
            style={{ margin: '0 0 0.5rem', opacity: 0.75, fontSize: '0.9rem' }}
          >
            <code
              style={{
                fontFamily: 'var(--vscode-editor-font-family, monospace)'
              }}
            >
              {file}
            </code>{' '}
            · {macros.length} macro{macros.length === 1 ? '' : 's'}
          </p>
          {pkg.description ? (
            <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
              {pkg.description}
            </p>
          ) : (
            <div style={{ height: '0.5rem' }} />
          )}
        </div>
        <button
          type="button"
          onClick={editMacroPackage}
          title="Edit package name / description"
          style={{
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
          }}
        >
          Edit package
        </button>
      </div>

      {macros.length > 0 ? (
        <MacroTable
          macros={macros}
          macroKinds={macroKinds}
          onEdit={editMacro}
        />
      ) : (
        <p style={{ opacity: 0.7, fontStyle: 'italic', margin: '0.5rem 0' }}>
          No macros yet — use the bar below to create the first one.
        </p>
      )}

      <AddBar label="Create Macro" onActivate={createMacro} />
    </main>
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

function MacroTable({
  macros,
  macroKinds,
  onEdit
}: {
  macros: MacroPackageEntry[];
  macroKinds: MacroKind[];
  onEdit: (name: string) => void;
}): React.ReactElement {
  const kindById = useMemo(() => {
    const m = new Map<string, MacroKind>();
    for (const k of macroKinds) {
      m.set(k.id, k);
    }
    return m;
  }, [macroKinds]);

  // Build ONE preview macro DB for the whole table: bundledMacroDb (background
  // math) + argument placeholders + all macros in THIS package (so a macro
  // referencing another sibling macro in the same package still renders). We
  // memoize by the macros array identity — parent's onMessage handler creates
  // a fresh array whenever the package file changes.
  const previewMacroDb: SnlMacroDb = useMemo(() => {
    const pkgDb: SnlMacroDb = {};
    for (const m of macros) {
      pkgDb[m.name] = macroToLibShape(m);
    }
    return { ...bundledMacroDb, ...ARG_PLACEHOLDER_MACROS, ...pkgDb };
  }, [macros]);

  const previewQuery = useMemo(
    () => createMacroTemplateQueryFromDb(previewMacroDb),
    [previewMacroDb]
  );

  // Tooltip / hover pipeline is pointless in a compact row preview and only
  // adds jitter. Suppress via renderTooltip → null.
  const previewHooks: SnlRenderHooks = useMemo(
    () => ({ ...defaultRenderHooks, renderTooltip: () => null }),
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
          <th style={{ ...HEAD, width: '9rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={{ ...HEAD, width: '5rem' }}>Arity</th>
          <th style={{ ...HEAD, width: '10rem' }}>Modes</th>
          <th style={{ ...HEAD, width: '8rem' }}>Kind</th>
          <th style={{ ...HEAD, width: '12rem' }}>Styles</th>
          {/* Description last: it can be long and wrapping is fine here. */}
          <th style={HEAD}>Description</th>
        </tr>
      </thead>
      <tbody>
        {macros.map((m) => (
          <MacroRow
            key={m.name}
            macro={m}
            kindById={kindById}
            previewMacroDb={previewMacroDb}
            previewQuery={previewQuery}
            previewHooks={previewHooks}
            onEdit={onEdit}
          />
        ))}
      </tbody>
    </table>
  );
}

/**
 * A single clickable macro row. Clicking (or Enter/Space) dispatches
 * `editMacro` for this macro name. Hover / focus paint the row with the
 * theme's list-hover background, matching VS Code list affordances.
 */
function MacroRow({
  macro,
  kindById,
  previewMacroDb,
  previewQuery,
  previewHooks,
  onEdit
}: {
  macro: MacroPackageEntry;
  kindById: Map<string, MacroKind>;
  previewMacroDb: SnlMacroDb;
  previewQuery: ReturnType<typeof createMacroTemplateQueryFromDb>;
  previewHooks: SnlRenderHooks;
  onEdit: (name: string) => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const activate = (): void => onEdit(macro.name);
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`Edit macro ${macro.name}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
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
      <td style={CELL}>
        <MacroPreview
          macro={macro}
          macroDb={previewMacroDb}
          query={previewQuery}
          hooks={previewHooks}
        />
      </td>
      <td style={{ ...CELL, ...MONO }}>{macro.name}</td>
      <td style={CELL}>{macro.arity}</td>
      <td style={CELL}>
        <ModesCell styles={macro.styles} />
      </td>
      <td style={CELL}>
        <KindCell
          kindId={macro.kind}
          kind={macro.kind ? kindById.get(macro.kind) : undefined}
        />
      </td>
      <td style={CELL}>
        <StylesCell styles={macro.styles} />
      </td>
      <td style={{ ...CELL, opacity: 0.85 }}>
        {macro.description ?? ''}
      </td>
    </tr>
  );
}

function ModesCell({
  styles
}: {
  styles: MacroPackageStyle[];
}): React.ReactElement {
  // Deduplicate + join modes with '/' so a mixed-mode macro shows e.g. "formula/text".
  const modes: string[] = [];
  for (const s of styles ?? []) {
    if (s?.mode && !modes.includes(s.mode)) {
      modes.push(s.mode);
    }
  }
  if (modes.length === 0) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }
  return <span>{modes.join(' / ')}</span>;
}

function StylesCell({
  styles
}: {
  styles: MacroPackageStyle[];
}): React.ReactElement {
  // Default = styles[0]; show it with a ★, then remaining tags after.
  if (!Array.isArray(styles) || styles.length === 0) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }
  const [first, ...rest] = styles;
  return (
    <span>
      <span style={MONO}>{first.tag} ★</span>
      {rest.length > 0 ? (
        <span style={{ opacity: 0.65 }}>
          {' '}+ {rest.map((s) => s.tag).join(', ')}
        </span>
      ) : null}
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
  if (!kindId) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }
  if (!kind) {
    return (
      <span
        style={{ ...MONO, opacity: 0.75 }}
        title="No matching macro kind in the catalog"
      >
        {kindId}
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span
        title={`stroke ${kind.coloring.stroke} / background ${kind.coloring.background}`}
        style={{
          display: 'inline-block',
          width: '1.2rem',
          height: '1rem',
          borderRadius: '3px',
          background: kind.coloring.background,
          border: `2px solid ${kind.coloring.stroke}`
        }}
      />
      {kind.name}
    </span>
  );
}

/**
 * Real KaTeX preview of a macro: renders it applied to numbered argument
 * placeholders using the same lib pipeline as the CreateMacro editor's Live
 * Preview. For a `fixed`-arity macro, the arg count is derived from the max
 * `#N` in the default (styles[0]) template. For `variadic`, we render with a
 * fixed small number of args (VARIADIC_PREVIEW_ARGS) — sufficient to show
 * the shape without exploding row height.
 *
 * A row-scoped try/catch (via a null template fallback) keeps a broken macro
 * from taking down the whole table.
 */
function MacroPreview({
  macro,
  macroDb,
  query,
  hooks
}: {
  macro: MacroPackageEntry;
  macroDb: SnlMacroDb;
  query: ReturnType<typeof createMacroTemplateQueryFromDb>;
  hooks: SnlRenderHooks;
}): React.ReactElement {
  const argCount = useMemo(() => {
    if (macro.arity === 'variadic') {
      return Math.min(VARIADIC_PREVIEW_ARGS, MAX_ARGS);
    }
    const defaultStyle = macro.styles?.[0];
    const derived = maxChildIndex(defaultStyle?.template ?? '') + 1;
    return Math.min(Math.max(derived, 0), MAX_ARGS);
  }, [macro]);

  const tree: SnlSyntaxTree = useMemo(() => {
    const children: SnlSyntaxTree[] = [];
    for (let i = 0; i < argCount; i++) {
      children.push(placeholderNode(i));
    }
    return { name: macro.name, kind: '', mdata: null, children };
  }, [macro.name, argCount]);

  // A macro with an empty default template renders as nothing useful — bail
  // to a soft "—" so the row doesn't show a phantom empty preview.
  const defaultTemplate = (macro.styles?.[0]?.template ?? '').trim();
  if (!defaultTemplate) {
    return <span style={{ opacity: 0.5 }}>—</span>;
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.15rem 0.4rem',
        borderRadius: '4px',
        background:
          'var(--vscode-textBlockQuote-background, rgba(64,128,255,0.06))'
      }}
    >
      <SnlSyntaxTreeView
        tree={tree}
        query={query}
        macroDb={macroDb}
        hooks={hooks}
      />
    </span>
  );
}

/**
 * Full-width dashed "+" bar (mirrors the Dashboard's AddBar). Clicking (or
 * Enter/Space) fires `onActivate`.
 */
function AddBar({
  label,
  onActivate
}: {
  label: string;
  onActivate: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.4rem',
        width: '100%',
        boxSizing: 'border-box',
        height: '3rem',
        marginTop: '0.75rem',
        borderRadius: '6px',
        border: hover
          ? '1.5px solid var(--vscode-focusBorder, var(--vscode-button-background, #0e639c))'
          : '2px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background: hover
          ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
          : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontWeight: 600,
        userSelect: 'none'
      }}
    >
      <span style={{ fontSize: '1.4rem', lineHeight: 1 }}>+</span>
      <span>{label}</span>
    </div>
  );
}
