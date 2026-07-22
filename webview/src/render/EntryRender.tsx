// Reusable Entry render surface. Renders one Entry's SNL content via
// @snl-basics/react with the shared macro DB / query, wrapped in the SNL-Doc
// visual spec (left-border-only frame, kind-colored bold header, thin
// horizontal separator, SNL body).
//
// Self-contained: each webview entry bundles this file locally (no shared
// runtime chunk — see webview/vite.config.ts).

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import '@snl-basics/react/style.css';
import { MarkdownBody } from './MarkdownBody';
import { LatexBody } from './LatexBody';
import { Button } from '../components/Button';
import {
  parseSnlSyntaxTree,
  tryParseSnlSyntaxTree,
  createMacroTemplateQueryFromDb,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  bundledMacroDb,
  type KindPalette,
  type SnlMacroDb,
  type SnlMacroTemplateQuery,
  type SnlRenderHooks
} from '@snl-basics/react';
import { useHoverPopovers, useCurrentPopoverId } from './HoverPopoverProvider';
import { buildContextIndex, applyContextSrcLookup } from './contextSrcLookup';

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
// Entry-title KaTeX helpers (cat 2026-07-09 spec).
//
// Titles render as TEXT by default (KaTeX `\text{…}`), with `$…$` spans
// escaping into inline math. See the block-level comment above `titleHtml`
// in `EntryHeaderAndBody` for the full semantic rules; these two helpers
// implement the escape and the segment-and-splice.
// ---------------------------------------------------------------------------

/**
 * Escape a string so it survives inside KaTeX `\text{…}`.
 *
 * KaTeX text mode is not LaTeX text mode: `\` needs `\textbackslash{}`,
 * `^` needs `\textasciicircum{}`, and `~` needs `\textasciitilde{}` because
 * the naive `\^` / `\~` / `\backslash` are not defined here. Other special
 * characters (`{`, `}`, `$`, `&`, `#`, `_`, `%`) take a plain backslash.
 * Order matters — escape backslashes first, then the caret/tilde words
 * (they contain braces we'd otherwise double-escape), then the single
 * chars.
 */
export function escapeForKatexText(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/([{}$&#_%])/g, '\\$1');
}

/**
 * Convert an Entry title string into a KaTeX source string:
 *   - Text runs are wrapped in `\text{…}` with `escapeForKatexText`.
 *   - `$…$` runs become inline math (raw KaTeX, unescaped) between the
 *     surrounding text runs.
 *   - `\$` in a text run is a literal dollar sign; it does NOT open math.
 *   - Adjacent `$$` in a text run is a literal `$$`; it does NOT open an
 *     empty math seg (would otherwise emit empty math, which parses fine
 *     but is almost certainly a typo). We collapse it before segmenting.
 *   - Unbalanced `$` (no closing pair) is a syntax error; caller catches
 *     the KaTeX throw and falls back to whole-title text.
 *
 * Returns a KaTeX source string ready for `renderToString`.
 */
export function titleToKatexSource(src: string): string {
  if (src.length === 0) return '';

  interface Seg { mode: 'text' | 'math'; text: string; }
  const parts: Seg[] = [];
  let mode: 'text' | 'math' = 'text';
  let buf = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // Only interpret `\$` as literal in text mode. Inside math, `\$` is
    // valid LaTeX and passes through unchanged for KaTeX to handle.
    if (mode === 'text' && c === '\\' && src[i + 1] === '$') {
      buf += '\\$';
      i += 2;
      continue;
    }
    if (c === '$') {
      // Adjacent `$$` in text mode: collapse to a literal `$$` glyph
      // rather than opening then immediately closing an empty math seg.
      if (mode === 'text' && src[i + 1] === '$') {
        buf += '$$';
        i += 2;
        continue;
      }
      parts.push({ mode, text: buf });
      buf = '';
      mode = mode === 'text' ? 'math' : 'text';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  parts.push({ mode, text: buf });

  // Unbalanced dollar sign: force a KaTeX throw so the caller's Pass-2
  // fallback (whole-title `\text{…}`) kicks in. We do that by returning
  // a source string with an unclosed math seg — KaTeX's parser will
  // reject it, our try/catch handles the rest.
  if (mode !== 'text') {
    return '$';
  }

  return parts
    .map((p) => {
      if (p.mode === 'math') {
        // Empty math seg (e.g. from a stray `$$` we didn't collapse) →
        // emit nothing rather than an empty `${}$` that would render as
        // a zero-width invisible bump. `$$` is already collapsed to a
        // literal above, so this branch normally only triggers for the
        // trailing empty seg after a closing `$`.
        return p.text;
      }
      if (!p.text) return '';
      return `\\text{${escapeForKatexText(p.text)}}`;
    })
    .join('');
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
  /**
   * Optional raw SNL content — used by the cross-entry `x@foo` bvar-
   * upgrade lookup (cat 2026-07-09 Stage 1 §5). Included in the
   * Infoview push so EntryRender can build the context index without
   * a second round-trip. Other panels (search boxes, list dropdowns)
   * don't need this and receive `undefined`.
   */
  snl?: string;
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

/**
 * Webview-side structural check for an entry pointer (cat 2026-07-11).
 * Mirrors `isStructuralPointer` in src/pointer.ts — kept here as an
 * independent copy because the webview bundle can't import from src/
 * (that pulls in `vscode`).
 *
 * Used to decide whether to render the pointer-jump button. Actual
 * filesystem resolution happens host-side at click time.
 */
function hasStructuralPointer(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.file !== 'string' || p.file.trim() === '') return false;
  if (p.mode === 'lines') {
    if (typeof p.line !== 'number' || !Number.isFinite(p.line) || p.line < 1) {
      return false;
    }
    if (
      p.endLine !== undefined &&
      (typeof p.endLine !== 'number' ||
        !Number.isFinite(p.endLine) ||
        p.endLine < p.line)
    ) {
      return false;
    }
    return true;
  }
  if (p.mode === 'regex') {
    if (typeof p.pattern !== 'string' || p.pattern === '') return false;
    if (p.flags !== undefined && typeof p.flags !== 'string') return false;
    if (
      p.occurrence !== undefined &&
      (typeof p.occurrence !== 'number' ||
        !Number.isInteger(p.occurrence) ||
        p.occurrence < 1)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function summarizePointer(value: unknown): string {
  if (!hasStructuralPointer(value)) return '';
  const p = value as Record<string, unknown>;
  if (p.mode === 'lines') {
    const line = p.line as number;
    const endLine = p.endLine as number | undefined;
    const range = endLine && endLine !== line ? `${line}–${endLine}` : `${line}`;
    return `${p.file}:${range}`;
  }
  const occ = (p.occurrence as number | undefined) ?? 1;
  const occSuffix = occ > 1 ? ` (#${occ})` : '';
  return `${p.file} /${p.pattern}/${occSuffix}`;
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
  /** Workspace Macro Kind colors forwarded to SnlSyntaxTreeView. */
  kindPalette?: KindPalette;
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
  kindPalette,
  hooksOverride,
  disableTitleJump,
  onTitleCtrlClick
}: EntryRenderProps): React.ReactElement {
  const snl = entry.content?.snl ?? '';
  const markdown = entry.content?.markdown ?? '';
  const latex = entry.content?.latex ?? '';
  const text = entry.content?.text ?? '';

  // Body-surface priority (cat 2026-07-11): snl > markdown > latex > text.
  // Empty string is treated as "not present" — a whitespace-only field
  // has no render value. TODO: allow config.json override of this
  // priority (`config.body_surface_priority: ['markdown', 'snl', ...]`).
  type BodySurface = 'snl' | 'markdown' | 'latex' | 'text' | 'none';
  const bodySurface: BodySurface =
    snl.trim().length > 0
      ? 'snl'
      : markdown.trim().length > 0
        ? 'markdown'
        : latex.trim().length > 0
          ? 'latex'
          : text.trim().length > 0
            ? 'text'
            : 'none';
  const popovers = useHoverPopovers();
  const currentPopoverId = useCurrentPopoverId();

  // Cat 2026-07-10: src badge (↗<entryId>) removed. Cross-entry
  // `x@foo` context refs no longer surface a visual marker in-line —
  // the bvar palette flip (via applyContextSrcLookup) plus the hover
  // popover (via `data-src` fallback in onHover below) carry the
  // affordance. Keeping this history for the next time someone asks
  // "where did the little arrow go".

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

  // Resolve a hovered/clicked macro name to a popover-target entry id.
  //
  // Cat 2026-07-10: cross-library popovers must work. Previously we only
  // returned an id when it appeared in the CURRENT library's entry pool,
  // which meant macros pointing at another library's entry silently
  // failed to spawn a popover. The host owns the DB and can resolve
  // ANY entry id — so we just return the macro's declared first source
  // entry id (if any) and let the host answer.
  //
  // `preferInPool` is used by resolveSource() for the KaTeX inline link
  // (which needs a title we already have locally); popover onHover uses
  // preferInPool=false so cross-library works.
  const resolveEntryId = useCallback(
    (name: string, preferInPool = false): string | null => {
      const macro = macroDb[name];
      if (!macro) return null;
      if (preferInPool) {
        for (const ref of macro.source.entries) {
          if (entries.some((e) => e.id === ref)) return ref;
        }
        return null;
      }
      // Cross-library-friendly: first declared source, in-pool or not.
      return macro.source.entries[0] ?? null;
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
        let entryId = resolveEntryId(event.name);
        if (!entryId) {
          // Cat 2026-07-10: fallback for cross-entry `x@foo` refs. The
          // node is a bvar (post-context-lookup) whose *name* is `x`,
          // not a macro name → resolveEntryId returns null. The parser
          // attached mdata.src which SnlSyntaxTreeView surfaced as
          // `data-src`; use it verbatim (cross-library ok — the host
          // owns the DB).
          const rawSrc = event.target.getAttribute('data-src') ?? '';
          if (rawSrc) entryId = rawSrc;
        }
        if (!entryId) {
          // Hovering a non-resolvable macro (e.g. plain fvar) — leave the
          // current popover alone. Doc-level hit-test in
          // HoverPopoverProvider governs dismissal.
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
    () => {
      if (!parsed.ok) return null;
      const t = parseSnlSyntaxTree(snl);
      // Cat 2026-07-09 Stage 1 §5 — upgrade `x@foo` fvars to bvar when
      // the target entry actually declares @x at top level. Runs post
      // parse (annotate-bind only sees local scope) so any node whose
      // mdata.src resolves picks up kind='bvar' and thus the bvar
      // palette color + hover treatment.
      const ctxIndex = buildContextIndex(
        entries
          .filter((e) => typeof e.snl === 'string' && e.snl.length > 0)
          .map((e) => ({ id: e.id, content: { snl: e.snl } }))
      );
      if (ctxIndex.size > 0) {
        applyContextSrcLookup(t, ctxIndex);
      }
      return t;
    },
    [parsed.ok, snl, entries]
  );
  const stroke = resolveStroke(kind?.coloring.stroke);
  const background = resolveBackground(kind?.coloring.background);
  const kindName = kind ? kind.name : entry.kind;
  // Header shape (cat 2026-07-08 spec): "<KindName> <counter> -- <title>"
  // where the prefix ("<KindName> <counter> -- ") is PLAIN TEXT and the
  // title after "--" is rendered by KaTeX (NOT SNL). Rationale
  // (verbatim from cat): 标题不走 SNL，只走裸的 KaTeX；标题给人看，
  // 一个 Entry 只有 content 走 SNL，不能混淆语义。
  const headerPrefix = counterLabel
    ? `${kindName} ${counterLabel} -- `
    : `${kindName} -- `;
  // Title rendering (cat 2026-07-09 revision, verbatim):
  //   "Entry Title 的渲染应该是一段 text 而不是公式环境，里面有美刀的
  //    话内部再调公式环境。"
  //
  // Semantics:
  //   - Default is TEXT mode (KaTeX `\text{…}`), NOT math mode. So a
  //     title like `Continuity of f on X` renders as prose, and a bare
  //     `\alpha` in a title is a literal backslash-α, not the Greek
  //     letter. Authors who want math must wrap it in `$…$`.
  //   - `$…$` switches to inline math for the enclosed span, then back
  //     to text. `Ring $R$ with unit` → text "Ring " + math R + text
  //     " with unit".
  //   - `\$` is a literal dollar sign in text (does NOT open math).
  //   - Adjacent `$$` in text mode is a literal `$$` (does NOT open an
  //     empty math seg or display math).
  //   - Unbalanced `$` (no closing pair) falls back to whole-title text.
  //
  // Fallback chain (3 passes) preserved from the pre-2026-07-09 code:
  //   Pass 1 — parsed source through KaTeX with throwOnError.
  //   Pass 2 — whole title escaped and wrapped in `\text{…}` for KaTeX.
  //   Pass 3 — HTML-escaped raw text as last-ditch defense.
  //
  // Supersedes the 2026-07-08 "raw KaTeX for the entire title" behavior.
  const titleHtml = useMemo(() => {
    const raw = entry.title ?? '';
    if (raw.length === 0) return '';
    const parsed = titleToKatexSource(raw);
    try {
      return katex.renderToString(parsed, {
        displayMode: false,
        throwOnError: true,
        strict: false,
        trust: false
      });
    } catch {
      try {
        return katex.renderToString(
          `\\text{${escapeForKatexText(raw)}}`,
          {
            displayMode: false,
            throwOnError: false,
            strict: false,
            trust: false
          }
        );
      } catch {
        return raw
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }
    }
  }, [entry.title]);

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
  const hasContent = bodySurface !== 'none';
  const isTransparent = background === TRANSPARENT_BACKGROUND;

  // Hover state for the inset glow affordance. The glow is drawn entirely
  // inside the Entry box so neither the panel layout nor the visible outer
  // boundary changes, and popover Entries never acquire a white rim.
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <section
      onClick={handleSectionClick}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      style={{
        // Left border is always visible. Hover feedback is a solid 5px inset
        // edge, so it never changes layout or the Entry's outer boundary.
        borderLeft: `5px solid ${stroke}`,
        borderRadius: 0,
        width: '100%',
        // Hover keeps the established white-background feedback, while the
        // solid inset edge stays entirely inside the fixed outer boundary.
        background: isHovered ? '#ffffff' : background,
        boxShadow: isHovered ? `inset 0 0 0 5px ${stroke}` : 'none',
        transition: 'background-color 150ms ease, box-shadow 150ms ease'
      }}
    >
      <header
        style={{
          // Header vertical padding halved (cat 2026-07-08): 0.55rem → 0.275rem
          // to tighten the title band. Horizontal padding preserved.
          padding: '0.275rem 0.8rem',
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.5rem'
        }}
      >
        <strong
          onClick={handleTitleClick}
          style={{
            color: stroke,
            cursor: disableTitleJump ? 'default' : 'pointer',
            fontSize: '1.25rem',
            lineHeight: 1.3,
            flex: '1 1 auto',
            minWidth: 0
          }}
        >
          {/* Prefix = plain text "<KindName> <counter> -- ". */}
          {headerPrefix}
          {/* Title = raw KaTeX HTML injected via dangerouslySetInnerHTML.
              Wrapped in an inline <span> so the click / cursor styles on
              the parent <strong> still apply. `.katex` KaTeX-emitted spans
              inherit color from `stroke` via the parent — no extra CSS. */}
          <span
            style={{ display: 'inline' }}
            dangerouslySetInnerHTML={{ __html: titleHtml }}
          />
        </strong>
        {hasStructuralPointer(entry.pointer) ? (
          <Button
            variant="ghost"
            size="sm"
            title={`Jump to source: ${summarizePointer(entry.pointer)}`}
            onClick={(e) => {
              e.stopPropagation();
              postMessage({ type: 'revealPointer', entryId: entry.id });
            }}
            style={{
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25em',
              padding: '0.05em 0.5em',
              fontSize: '0.75rem',
              lineHeight: 1.3,
              color: stroke,
              fontFamily: 'inherit',
              // Codicon-like arrow glyph; the extension's webviews don't
              // bundle codicons, so use a Unicode symbol that reads as
              // "jump / open in editor". `↗` fits with the outline aesthetic.
              whiteSpace: 'nowrap'
            }}
          >
            ↗ source
          </Button>
        ) : null}
      </header>
      {hasContent ? (
        <>
          <div
            style={{
              borderTop: `0.5px solid ${stroke}`,
              // Horizontal 10px margin so the separator doesn't touch
              // the left/right borders of the block (cat 2026-07-08).
              margin: '4px 10px'
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
            {bodySurface === 'snl' ? (
              parsed.ok && tree ? (
                <SnlSyntaxTreeView
                  tree={tree}
                  macroDb={macroDb}
                  query={macroQuery}
                  kindPalette={kindPalette}
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
              )
            ) : bodySurface === 'markdown' ? (
              <MarkdownBody source={markdown} />
            ) : bodySurface === 'latex' ? (
              <LatexBody source={latex} />
            ) : bodySurface === 'text' ? (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                  fontSize: 'inherit'
                }}
              >
                {text}
              </pre>
            ) : null}
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
