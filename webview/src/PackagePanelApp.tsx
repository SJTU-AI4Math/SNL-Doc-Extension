// SNL Macro Package panel webview: lists the macros in one package file and
// offers a big-plus "+ Create Macro" bar. Each row shows a cheap KaTeX-mini
// preview of the macro name, plus name / description / arity / mode columns.
//
// The preview column deliberately does NOT render each macro's full template
// (perf risk for large packages) — it renders `\mathrm{<name>}` as a light
// visual swatch via katex.renderToString.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';

interface SnlMacro {
  name: string;
  description: string;
  source: { entries: string[]; urls: string[] };
  typst: {
    built_in: string;
    synthesis: { output_type: 'formula' | 'text'; macro: string };
  };
  latex: {
    built_in: string;
    synthesis: { output_type: 'formula' | 'text'; macro: string };
  };
  markdown: string;
  text: string;
  katex_react: {
    arity: 'fixed' | 'variadic';
    mode: 'math' | 'text' | 'block';
    template: string;
    variadic_join?: string;
    react_renderer_key?: string;
  };
}

interface MacroPackageFile {
  version: string;
  name: string;
  description?: string;
  macros: Record<string, Omit<SnlMacro, 'name'>>;
}

type Incoming =
  | { type: 'package'; pkg: MacroPackageFile; file: string; macros: SnlMacro[] }
  | { type: 'noFile'; file: string }
  | { type: 'error'; message: string }
  | undefined;

type Model =
  | { kind: 'loading' }
  | { kind: 'package'; pkg: MacroPackageFile; file: string; macros: SnlMacro[] }
  | { kind: 'noFile'; file: string }
  | { kind: 'error'; message: string };

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
            macros: Array.isArray(msg.macros) ? msg.macros : []
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

  const { pkg, file, macros } = model;

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '58rem' }}>
      <h1 style={{ margin: '0 0 0.25rem', fontSize: '1.4rem' }}>{pkg.name}</h1>
      <p style={{ margin: '0 0 0.5rem', opacity: 0.75, fontSize: '0.9rem' }}>
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
        <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>{pkg.description}</p>
      ) : (
        <div style={{ height: '0.5rem' }} />
      )}

      {macros.length > 0 ? (
        <MacroTable macros={macros} />
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

function MacroTable({ macros }: { macros: SnlMacro[] }): React.ReactElement {
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
          <th style={{ ...HEAD, width: '7rem' }}>Preview</th>
          <th style={HEAD}>Name</th>
          <th style={HEAD}>Description</th>
          <th style={{ ...HEAD, width: '5rem' }}>Arity</th>
          <th style={{ ...HEAD, width: '4.5rem' }}>Mode</th>
        </tr>
      </thead>
      <tbody>
        {macros.map((m) => (
          <tr key={m.name}>
            <td style={CELL}>
              <MacroMiniPreview name={m.name} />
            </td>
            <td style={{ ...CELL, ...MONO }}>{m.name}</td>
            <td style={{ ...CELL, opacity: 0.85 }}>
              {truncate(m.description ?? '', 60)}
            </td>
            <td style={CELL}>{m.katex_react.arity}</td>
            <td style={CELL}>{m.katex_react.mode}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Cheap KaTeX-mini render of `\mathrm{<name>}` — no full template render. */
function MacroMiniPreview({ name }: { name: string }): React.ReactElement {
  const html = useMemo(() => {
    try {
      return katex.renderToString(`\\mathrm{${escapeForKatex(name)}}`, {
        throwOnError: false
      });
    } catch {
      return '';
    }
  }, [name]);
  return (
    <span
      className="katex-mini"
      style={{
        display: 'inline-block',
        padding: '0.1rem 0.35rem',
        borderRadius: '4px',
        background: 'var(--vscode-textBlockQuote-background, rgba(64,128,255,0.08))'
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Escape characters KaTeX would treat specially inside \mathrm{...}. */
function escapeForKatex(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, (ch) => `\\${ch}`);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max - 1)}…`;
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
