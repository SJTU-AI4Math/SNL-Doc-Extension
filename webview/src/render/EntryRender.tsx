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
  type SnlMacroDb,
  type SnlMacroTemplateQuery,
  type SnlRenderHooks
} from '@snl-basics/react';
import { useHoverPopovers, useCurrentPopoverId } from './HoverPopoverProvider';

// Bundled core math macros ship with @snl-basics/react. User-defined macros
// live in `.SNL_Doc/term_macros/*.json` and reach the webview via the
// `macros` field on incoming host messages. `mergeMacroDb` layers the user
// pool over the core so unknown names fall back to the core (matches the
// Entry editor's precedence).
export function mergeMacroDb(userMacros: SnlMacroDb | undefined | null): SnlMacroDb {
  if (!userMacros) {
    return bundledMacroDb;
  }
  return { ...bundledMacroDb, ...userMacros };
}

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
// Coloring magic values (cat 2026-07-06):
//   stroke === ''  → use vscode-editor-foreground (auto light/dark)
//   background === '' or 'transparent' → transparent (chameleon; no fill).
// Any other value is passed through as a literal CSS color.
const FALLBACK_STROKE = '#888888';
const FALLBACK_BACKGROUND = '#eeeeee';
const AUTO_STROKE = 'var(--vscode-editor-foreground, #ddd)';
const TRANSPARENT_BACKGROUND = 'transparent';

function resolveStroke(raw: string | undefined): string {
  if (raw === undefined) return FALLBACK_STROKE;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'auto') return AUTO_STROKE;
  return trimmed;
}

function resolveBackground(raw: string | undefined): string {
  if (raw === undefined) return FALLBACK_BACKGROUND;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'transparent' || trimmed === 'none') {
    return TRANSPARENT_BACKGROUND;
  }
  return trimmed;
}

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
   * User-defined macro DB (name→SnlMacro). Merged over the bundled core DB
   * before rendering, so unknown names still resolve against the core. When
   * undefined, only the core DB is used (all user macros will render as fvar).
   * The host pushes this via `macros` on `entries` / `entryDetails` /
   * `popoverEntryDetails`; wire it here so per-entry, picker, AND popover
   * surfaces all see the same macro universe.
   */
  userMacros?: SnlMacroDb;
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
  userMacros,
  hooksOverride,
  disableTitleJump,
  onTitleCtrlClick
}: EntryRenderProps): React.ReactElement {
  const snl = entry.content?.snl ?? '';
  const popovers = useHoverPopovers();
  const currentPopoverId = useCurrentPopoverId();

  // Merged DB: user macros layered over the bundled core. `MACRO_QUERY`
  // derives from it so `SnlSyntaxTreeView` sees a single consistent DB.
  const macroDb = useMemo<SnlMacroDb>(() => mergeMacroDb(userMacros), [userMacros]);
  const macroQuery = useMemo<SnlMacroTemplateQuery>(
    () => createMacroTemplateQueryFromDb(macroDb),
    [macroDb]
  );

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
      const macro = macroDb[name];
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
    [entries, macroDb]
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
          // Hovering a non-resolvable macro (e.g. fvar) — leave the current
          // popover alone. Doc-level hit-test in HoverPopoverProvider governs
          // dismissal, so we don't need to touch anything here.
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
      // Pointer left this SNL render container.
      //
      // Deliberately do NOT dismiss the popover from here — dismissal is
      // owned by HoverPopoverProvider's document-level union hit-test so the
      // pointer can bridge from a macro node onto the portal-mounted popover
      // DOM (which is outside this container, so leaving here doesn't mean
      // the user actually left the popover's area of influence).
      //
      // We DO drop the pending 3s freeze timer — if the pointer wandered
      // away, we shouldn't freeze the popover in place based on a stale
      // "still hovering" assumption. Bookkeeping (targetEl / popoverId) is
      // left intact so a re-enter on the SAME macro reuses the popover
      // instead of spawning a duplicate.
      onLeave: () => {
        const hs = hoverStateRef.current;
        if (hs.timer) {
          clearTimeout(hs.timer);
          hs.timer = null;
        }
      },
      // Suppress SNL-Basics's built-in tooltip DOM — we render our own
      // hover-preview popover via HoverPopoverProvider and don't want the
      // two overlapping.
      renderTooltip: () => null,
      // Caller overrides (onHover / renderTooltip / …) win over the above.
      ...(hooksOverride ?? {})
    };
  }, [entries, hooksOverride, popovers, currentPopoverId, resolveEntryId, clearCurrentHover]);

  // Body-pointer-move handler was previously used to dismiss unfrozen
  // popovers when the pointer strayed off the origin macro into empty body
  // space. That aggressive dismissal made it impossible to reach the
  // portal-mounted popover to read it. Dismissal is now owned entirely by
  // HoverPopoverProvider's document-level union hit-test.
  //
  // We still install an empty handler (rather than deleting the prop) so
  // React keeps a consistent event delegation topology on this div — no
  // behavioural effect.
  const handleBodyPointerMove = useCallback((): void => {
    /* intentionally empty — see comment */
  }, []);

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
  // Memoize the successful tree so `<SnlSyntaxTreeView tree={...}/>` gets a
  // stable object reference across re-renders. SnlSyntaxTreeView renders
  // KaTeX asynchronously in a useEffect keyed on `tree`; a fresh object on
  // every render invalidates the deps and cancels the async render before
  // it can setState, so the body silently stays empty. This bites popovers
  // hard because HoverPopoverProvider re-renders the whole popover stack on
  // every pointer-move (updatePointer → setPopovers), so the popover
  // EntryRender never gets a stable enough render window for KaTeX to
  // finish. Main-panel EntryRender was accidentally fine because it only
  // re-renders on entry/kind selection, not pointer motion.
  const tree = useMemo(
    () => (parsed.ok ? parseSnlSyntaxTree(snl) : null),
    [parsed.ok, snl]
  );
  const stroke = resolveStroke(kind?.coloring.stroke);
  const background = resolveBackground(kind?.coloring.background);
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

  // Empty SNL = don't render body at all (cat 2026-07-06: no error banner
  // just because there's no content).
  const hasContent = snl.trim().length > 0;
  const isTransparent = background === TRANSPARENT_BACKGROUND;

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
            cursor: disableTitleJump ? 'default' : 'pointer',
            fontSize: '1.25rem',
            lineHeight: 1.3
          }}
        >
          {headerText}
        </strong>
      </header>
      {hasContent ? (
        <>
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
              // Transparent chameleons inherit theme text color; solid
              // backgrounds keep the dark-on-color reading contrast that
              // the light-tinted content-kind backgrounds were designed for.
              color: isTransparent ? undefined : '#111',
              fontSize: '1.05rem'
            }}
          >
            {parsed.ok && tree ? (
              <SnlSyntaxTreeView
                tree={tree}
                macroDb={macroDb}
                query={macroQuery}
                hooks={hooks}
              />
            ) : (
              <div>
                <ErrorBanner
                  text={`SNL parse error: ${!parsed.ok ? parsed.error : ''}${
                    !parsed.ok && parsed.position !== undefined
                      ? ` (at ${parsed.position})`
                      : ''
                  }`}
                />
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    fontSize: '0.85rem',
                    color: isTransparent ? undefined : '#222'
                  }}
                >
                  {snl}
                </pre>
              </div>
            )}
          </div>
        </>
      ) : null}
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
