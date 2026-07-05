// Reusable Entry render surface. Renders one Entry's SNL content via
// @snl-basics/react with the shared macro DB / query, wrapped in the SNL-Doc
// visual spec (left-border-only frame, kind-colored bold header, thin
// horizontal separator, SNL body).
//
// Self-contained: each webview entry bundles this file locally (no shared
// runtime chunk — see webview/vite.config.ts).

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
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
import { useHoverPopovers, useCurrentPopoverId } from './HoverPopoverProvider';

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
  const popovers = useHoverPopovers();
  const currentPopoverId = useCurrentPopoverId();

  // Per-macro hover continuity: which macro element currently owns a popover,
  // and the pending 3s freeze timer. Persists across hook rebuilds (ref).
  const hoverStateRef = useRef<{
    targetEl: Element | null;
    popoverId: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ targetEl: null, popoverId: null, timer: null });

  // Resolve a hovered/clicked macro name to an in-pool entry id (or null).
  const resolveEntryId = useCallback(
    (name: string): string | null => {
      const macro = MACRO_DB[name];
      if (!macro) {
        return null;
      }
      for (const ref of macro.source.entries) {
        if (entries.some((e) => e.id === ref)) {
          return ref;
        }
      }
      return null;
    },
    [entries]
  );

  // Dismiss this container's active (unfrozen) popover and cancel any pending
  // freeze. No-op on a popover that has already frozen (it persists until the
  // provider's document-level hit-test dismisses it).
  const clearCurrentHover = useCallback((): void => {
    const hs = hoverStateRef.current;
    if (hs.timer) {
      clearTimeout(hs.timer);
      hs.timer = null;
    }
    if (hs.popoverId) {
      popovers.cancelUnfrozen(hs.popoverId);
    }
    hs.targetEl = null;
    hs.popoverId = null;
  }, [popovers]);

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
      // Hover a macro that resolves to an in-pool entry → spawn a preview
      // popover that follows the pointer, freezing after a 3s dwell.
      onHover: (event) => {
        const entryId = resolveEntryId(event.name);
        if (!entryId) {
          clearCurrentHover();
          return;
        }
        const originEl = event.target;
        const hs = hoverStateRef.current;
        if (
          hs.targetEl === originEl &&
          hs.popoverId &&
          popovers.isAlive(hs.popoverId)
        ) {
          popovers.updatePointer(hs.popoverId, event.clientX, event.clientY);
          return;
        }
        clearCurrentHover();
        const rect = originEl.getBoundingClientRect();
        const id = popovers.spawn(
          entryId,
          rect,
          event.clientX,
          event.clientY,
          currentPopoverId
        );
        hs.targetEl = originEl;
        hs.popoverId = id;
        hs.timer = setTimeout(() => popovers.freeze(id), 3000);
      },
      // Pointer left this render container → drop its unfrozen popover.
      onLeave: () => {
        clearCurrentHover();
      },
      // Caller overrides (onHover / renderTooltip / …) win over the above.
      ...(hooksOverride ?? {})
    };
  }, [entries, hooksOverride, popovers, currentPopoverId, resolveEntryId, clearCurrentHover]);

  // Guard: SNL-Basics only fires onHover over macro nodes, so moving the
  // pointer off the originating macro onto empty container space produces no
  // event. Track pointer position over the whole body and drop the active
  // (unfrozen) popover — and cancel its pending freeze — once the pointer is
  // outside the originating macro's rect.
  const handleBodyPointerMove = useCallback(
    (e: React.PointerEvent): void => {
      const hs = hoverStateRef.current;
      if (!hs.targetEl || !hs.popoverId) {
        return;
      }
      const rect = (hs.targetEl as HTMLElement).getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (!inside) {
        clearCurrentHover();
      }
    },
    [clearCurrentHover]
  );

  // Clear any pending freeze timer when this render surface unmounts so a
  // stale timer can't fire freeze() on a popover after the source is gone.
  useEffect(() => {
    const hs = hoverStateRef.current;
    return () => {
      if (hs.timer) {
        clearTimeout(hs.timer);
        hs.timer = null;
      }
    };
  }, []);

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

  // Event-delegated Ctrl/Meta+click on any rendered macro node: SNL-Basics
  // annotates macro nodes with `data-name`, so walk up from the click target
  // to find the nearest macro and open its resolved entry in the Infoview.
  const handleSectionClick = (e: React.MouseEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    let el: HTMLElement | null = e.target as HTMLElement | null;
    const stop = e.currentTarget as HTMLElement;
    while (el && el !== stop) {
      const name = el.getAttribute('data-name');
      if (name) {
        const entryId = resolveEntryId(name);
        if (entryId) {
          e.preventDefault();
          postMessage({ type: 'openEntryInfoview', entryId });
        }
        return;
      }
      el = el.parentElement;
    }
  };

  return (
    <section
      onClick={handleSectionClick}
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
        onPointerMove={handleBodyPointerMove}
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
