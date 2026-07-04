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

// Extended, on-disk macro shape (v6) — a superset of the library's render-only
// `SnlMacro`. It keeps the consumer-owned output backends (typst / latex /
// markdown / text) that this panel reads back, *per style*.
// v6: `mode` is 4 flat values (formula_inline/formula_display/text/block),
// no `display` axis; `dynamic_arity: boolean` replaces `arity`; variadic
// delimiters are 3 optional strings; per-macro + per-style `tags`.
interface MacroPackageStyle {
  tag: string;
  mode: 'formula_inline' | 'formula_display' | 'text' | 'block';
  template: string;
  variadic_left?: string;
  variadic_join?: string;
  variadic_right?: string;
  react_renderer_key?: string;
  tags?: string[];
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
  dynamic_arity: boolean;
  styles: MacroPackageStyle[];
  tags?: string[];
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

/** One placeholder macro per index — a rounded translucent numbered box.
 *  Uses the same `\mathord{\htmlClass{...}}` shape as CreateMacroApp so
 *  KaTeX emits the trailing atom-spacing OUTSIDE the frame — otherwise a
 *  placeholder followed by `+` shows an empty right gap inside its border. */
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
 * Convert an on-disk v6 {@link MacroPackageEntry} to the render-only lib shape
 * `SnlMacro` (only the fields the view needs — drop typst/latex/markdown/text
 * backends; keep name/description/source/kind/dynamic_arity/styles).
 */
function macroToLibShape(m: MacroPackageEntry): SnlMacro {
  const styles = Array.isArray(m.styles)
    ? m.styles.map((s) => {
        const out: SnlMacro['styles'][number] = {
          tag: s.tag,
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
        if (s.mode === 'block' && s.react_renderer_key) {
          out.react_renderer_key = s.react_renderer_key;
        }
        return out;
      })
    : [];
  const lib: SnlMacro = {
    name: m.name,
    description: m.description ?? '',
    source: m.source ?? { entries: [], urls: [] },
    dynamic_arity: !!m.dynamic_arity,
    styles: styles.length > 0
      ? styles
      : [{ tag: 'default', mode: 'formula_inline', template: '' }]
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

/**
 * Human-readable arity label for a macro row (bug 2 fix).
 * For a fixed-arity macro, show the derived argument count (from max #N in
 * the default template + 1). For dynamic-arity, show "dynamic". "0" (a
 * fixed nullary macro like `\LaTeX`) is a legitimate value.
 */
function arityLabel(macro: MacroPackageEntry): string {
  if (macro.dynamic_arity) {
    return 'dynamic';
  }
  const defaultStyle = macro.styles?.[0];
  const count = Math.max(0, maxChildIndex(defaultStyle?.template ?? '') + 1);
  return String(count);
}

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
          {/* Expand-toggle stub column — 1.4rem wide, matches the button. */}
          <th style={{ ...HEAD, width: '1.6rem', padding: '0.45rem 0.2rem' }} />
          <th style={{ ...HEAD, width: '9rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={{ ...HEAD, width: '5rem' }}>Arity</th>
          <th style={{ ...HEAD, width: '9rem' }}>Mode</th>
          <th style={{ ...HEAD, width: '8rem' }}>Kind</th>
          <th style={{ ...HEAD, width: '11rem' }}>Style</th>
          <th style={{ ...HEAD, width: '13rem' }}>Macro Tags</th>
          <th style={{ ...HEAD, width: '13rem' }}>Style Tags</th>
          {/* Description last: it can be long and wrapping is fine here. */}
          <th style={HEAD}>Description</th>
        </tr>
      </thead>
      <tbody>
        {macros.map((m) => (
          <MacroRowGroup
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
  const [expanded, setExpanded] = useState(false);
  const styles = Array.isArray(macro.styles) ? macro.styles : [];
  const defaultStyle = styles[0];
  const extraStyles = styles.slice(1);
  const canExpand = extraStyles.length > 0;
  return (
    <>
      <MacroStyleRow
        macro={macro}
        style={defaultStyle}
        styleIndex={0}
        isDefault
        showMacroLevel
        expanded={expanded}
        canExpand={canExpand}
        onToggleExpand={
          canExpand ? () => setExpanded((v) => !v) : undefined
        }
        kindById={kindById}
        previewMacroDb={previewMacroDb}
        previewQuery={previewQuery}
        previewHooks={previewHooks}
        onEdit={onEdit}
      />
      {expanded
        ? extraStyles.map((s, i) => (
            <MacroStyleRow
              key={`${macro.name}::${s.tag}::${i + 1}`}
              macro={macro}
              style={s}
              styleIndex={i + 1}
              isDefault={false}
              showMacroLevel={false}
              expanded={false}
              canExpand={false}
              onToggleExpand={undefined}
              kindById={kindById}
              previewMacroDb={previewMacroDb}
              previewQuery={previewQuery}
              previewHooks={previewHooks}
              onEdit={onEdit}
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
  styleIndex,
  isDefault,
  showMacroLevel,
  expanded,
  canExpand,
  onToggleExpand,
  kindById,
  previewMacroDb,
  previewQuery,
  previewHooks,
  onEdit
}: {
  macro: MacroPackageEntry;
  style: MacroPackageStyle | undefined;
  styleIndex: number;
  isDefault: boolean;
  /** If true, render Name / Arity / Kind / Macro Tags / Description; else `—`. */
  showMacroLevel: boolean;
  expanded: boolean;
  canExpand: boolean;
  onToggleExpand: (() => void) | undefined;
  kindById: Map<string, MacroKind>;
  previewMacroDb: SnlMacroDb;
  previewQuery: ReturnType<typeof createMacroTemplateQueryFromDb>;
  previewHooks: SnlRenderHooks;
  onEdit: (name: string) => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  const activate = (): void => onEdit(macro.name);
  const macroTags = Array.isArray(macro.tags) ? macro.tags : [];
  const styleTags = Array.isArray(style?.tags) ? (style?.tags as string[]) : [];
  const styleTag = style?.tag ?? '(untagged)';
  const styleMode = style?.mode ?? '';
  const rowBackground = hover
    ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))'
    : isDefault
      ? 'transparent'
      : 'var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.02))';
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={
        isDefault
          ? `Edit macro ${macro.name}`
          : `Edit macro ${macro.name} — style ${styleTag}`
      }
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
        background: rowBackground,
        // Extra rows visually attach to their default row with no top border
        // so the group reads as one block.
        borderTop: isDefault
          ? undefined
          : '1px dashed var(--vscode-panel-border, var(--vscode-contrastBorder, #333))'
      }}
    >
      {/* Expand toggle — only rendered on the default row of a multi-style macro. */}
      <td
        style={{
          ...CELL,
          width: '1.6rem',
          padding: '0.45rem 0.2rem',
          textAlign: 'center'
        }}
      >
        {isDefault && canExpand ? (
          <button
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
            aria-label={expanded ? 'Collapse styles' : 'Expand styles'}
            title={
              expanded
                ? 'Collapse this macro\u2019s style rows'
                : `Show ${macro.styles.length - 1} more style row${macro.styles.length - 1 === 1 ? '' : 's'}`
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
          </button>
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
              styleTag={isDefault ? undefined : style.tag}
              macroDb={previewMacroDb}
              query={previewQuery}
              hooks={previewHooks}
            />
          ) : (
            <span style={{ opacity: 0.5 }}>—</span>
          )}
        </div>
      </td>
      {/* Name: macro-level. */}
      <td style={{ ...CELL, ...MONO }}>
        {showMacroLevel ? macro.name : <Dash />}
      </td>
      {/* Arity: macro-level. */}
      <td style={CELL}>{showMacroLevel ? arityLabel(macro) : <Dash />}</td>
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
          <span style={{ opacity: 0.7, marginLeft: '0.3rem' }} title="Default style">
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
    </tr>
  );
}

/** Placeholder cell used to signal "same as macro's default row". */
function Dash(): React.ReactElement {
  return (
    <span aria-label="same as default" style={{ opacity: 0.45 }}>
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
 * Real KaTeX preview of a macro applied to numbered argument placeholders.
 *
 * When `styleTag` is undefined the macro's default style (styles[0]) is
 * used — the tree omits `[style]` and the render pipeline falls through to
 * SnlMacro.styles[0]. When `styleTag` is provided, the tree carries that
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
  macroDb,
  query,
  hooks
}: {
  macro: MacroPackageEntry;
  /** Non-default style tag to preview. Undefined → use the default (styles[0]). */
  styleTag: string | undefined;
  macroDb: SnlMacroDb;
  query: ReturnType<typeof createMacroTemplateQueryFromDb>;
  hooks: SnlRenderHooks;
}): React.ReactElement {
  // Locate the specific style being previewed (fall back to styles[0]).
  const style = useMemo<MacroPackageStyle | undefined>(() => {
    if (!Array.isArray(macro.styles) || macro.styles.length === 0)
      return undefined;
    if (styleTag == null) return macro.styles[0];
    return macro.styles.find((s) => s.tag === styleTag) ?? macro.styles[0];
  }, [macro.styles, styleTag]);

  const argCount = useMemo(() => {
    if (macro.dynamic_arity) {
      return Math.min(VARIADIC_PREVIEW_ARGS, MAX_ARGS);
    }
    const derived = maxChildIndex(style?.template ?? '') + 1;
    return Math.min(Math.max(derived, 0), MAX_ARGS);
  }, [macro.dynamic_arity, style?.template]);

  const tree: SnlSyntaxTree = useMemo(() => {
    const children: SnlSyntaxTree[] = [];
    for (let i = 0; i < argCount; i++) {
      children.push(placeholderNode(i));
    }
    const node: SnlSyntaxTree = {
      name: macro.name,
      kind: '',
      mdata: null,
      children
    };
    // Only stamp `style` when the caller asked for a non-default style —
    // omitting the field lets the render pipeline pick styles[0] cleanly.
    if (styleTag != null) node.style = styleTag;
    return node;
  }, [macro.name, argCount, styleTag]);

  // A style with an empty template renders as nothing useful — bail to
  // a soft "—" so the row doesn't show a phantom empty preview.
  const template = (style?.template ?? '').trim();
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
      tree={tree}
      query={query}
      macroDb={macroDb}
      hooks={hooks}
    />
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
