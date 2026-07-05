// Reusable Entry render surface. Renders one Entry's SNL content via
// @snl-basics/react with the shared macro DB / query, wrapped in the SNL-Doc
// visual spec (left-border-only frame, kind-colored bold header, thin
// horizontal separator, SNL body).
//
// Self-contained: each webview entry bundles this file locally (no shared
// runtime chunk — see webview/vite.config.ts).

import React, { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import '@snl-basics/react/style.css';
import {
  parseSnlSyntaxTree,
  tryParseSnlSyntaxTree,
  createMacroTemplateQueryFromDb,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  bundledMacroDb,
  type SnlMacroTemplateQuery,
  type SnlRenderHooks
} from '@snl-basics/react';

// Static, network-free macro DB bundled from @snl-basics/react.
const MACRO_DB = bundledMacroDb;
const MACRO_QUERY: SnlMacroTemplateQuery = createMacroTemplateQueryFromDb(MACRO_DB);

// ---------------------------------------------------------------------------
// Host <-> webview shapes (mirrors src/snlDoc.ts, kept local so the webview
// doesn't pull in the `vscode`-dependent extension module). Exported so every
// webview entry shares one definition.
// ---------------------------------------------------------------------------

export interface EntryOption {
  id: string;
  title: string;
  hasContent: boolean;
}

export interface EntryContent {
  snl?: string;
  typst?: string;
  latex?: string;
  markdown?: string;
  text?: string;
}

export interface EntryData {
  id: string;
  kind: string;
  title: string;
  content: EntryContent;
  contribution_info: unknown;
  pointer: unknown;
}

export interface EntryKind {
  id: string;
  name: string;
  coloring: { stroke: string; background: string };
  numbering: string;
  style: string;
}

// Neutral fallback palette when the entry's kind can't be resolved.
const FALLBACK_STROKE = '#888888';
const FALLBACK_BACKGROUND = '#eeeeee';

export interface EntryRenderProps {
  entry: EntryData;
  /** Resolved kind, or null → neutral gray palette. */
  kind: EntryKind | null;
  /** Entry pool used by the default resolveSource hook. */
  entries: EntryOption[];
  postMessage: (msg: unknown) => void;
  /**
   * Optional counter label (e.g. "1.2.3"). Caller-supplied — EntryKind.numbering
   * is NOT consulted here. Undefined → header omits the counter fragment.
   */
  counterLabel?: string;
  /**
   * Caller-injected hooks merged OVER the defaults + resolveSource (so a caller
   * can override onHover / renderTooltip while keeping source resolution).
   */
  hooksOverride?: Partial<SnlRenderHooks>;
  /** When true, Ctrl/Meta+click on the header title is a no-op. */
  disableTitleJump?: boolean;
  /** Invoked on Ctrl/Meta+click of the header title (unless disableTitleJump). */
  onTitleCtrlClick?: (entryId: string) => void;
}

export function EntryRender({
  entry,
  kind,
  entries,
  postMessage,
  counterLabel,
  hooksOverride,
  disableTitleJump,
  onTitleCtrlClick
}: EntryRenderProps): React.ReactElement {
  const snl = entry.content?.snl ?? '';

  // Consumer-injected hooks. Rebuilt when the pool / overrides change so
  // resolveSource always sees the current entry universe.
  const hooks: SnlRenderHooks = useMemo(() => {
    return {
      ...defaultRenderHooks,
      // Resolve a macro's source binding against the local Entry pool: the
      // first referenced id that exists becomes an `entry` link; otherwise
      // fall back to the first URL.
      resolveSource: (source) => {
        for (const ref of source.entries) {
          const match = entries.find((e) => e.id === ref);
          if (match) {
            return { kind: 'entry', ref, displayName: match.title };
          }
        }
        if (source.urls.length > 0) {
          const href = source.urls[0];
          return { kind: 'url', ref: href, href };
        }
        return null;
      },
      // Caller overrides (onHover / renderTooltip / …) win over the defaults.
      ...(hooksOverride ?? {})
    };
  }, [entries, hooksOverride]);

  const parsed = useMemo(() => tryParseSnlSyntaxTree(snl), [snl]);
  const stroke = kind?.coloring.stroke ?? FALLBACK_STROKE;
  const background = kind?.coloring.background ?? FALLBACK_BACKGROUND;
  const kindName = kind ? kind.name : entry.kind;
  const headerText = counterLabel
    ? `${kindName} ${counterLabel} -- ${entry.title}`
    : `${kindName} -- ${entry.title}`;

  const handleTitleClick = (e: React.MouseEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!disableTitleJump) {
        onTitleCtrlClick?.(entry.id);
      }
    }
  };

  return (
    <section
      style={{
        borderLeft: `5px solid ${stroke}`,
        borderRadius: 0,
        width: '100%',
        background
      }}
    >
      <header
        style={{
          padding: '0.55rem 0.8rem'
        }}
      >
        <strong
          onClick={handleTitleClick}
          style={{
            color: stroke,
            cursor: disableTitleJump ? 'default' : 'pointer'
          }}
        >
          {headerText}
        </strong>
      </header>
      <div
        style={{
          borderTop: `0.5px solid ${stroke}`,
          margin: '4px 0'
        }}
      />
      <div
        style={{
          padding: '0.9rem',
          color: '#111',
          fontSize: '1.05rem'
        }}
      >
        {parsed.ok ? (
          <SnlSyntaxTreeView
            tree={parseSnlSyntaxTree(snl)}
            macroDb={MACRO_DB}
            query={MACRO_QUERY}
            hooks={hooks}
          />
        ) : (
          <div>
            <ErrorBanner
              text={`SNL parse error: ${parsed.error}${
                parsed.position !== undefined ? ` (at ${parsed.position})` : ''
              }`}
            />
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--vscode-editor-font-family, monospace)',
                fontSize: '0.85rem',
                color: '#222'
              }}
            >
              {snl}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}

function ErrorBanner({ text }: { text: string }): React.ReactElement {
  return (
    <div
      style={{
        margin: '0 0 0.5rem',
        padding: '0.4rem 0.6rem',
        borderRadius: '3px',
        background: '#fdecea',
        border: '1px solid #f5c2c0',
        color: '#8a1f11',
        fontSize: '0.8rem',
        fontFamily: 'var(--vscode-editor-font-family, monospace)'
      }}
    >
      {text}
    </div>
  );
}
