// Thin VS Code adapter over SNL-Basics's canonical Entry renderer.
// Presentation, content dispatch, title rendering, context-source resolution,
// and SNL subtree behavior live in @sjtu-ai4math/snl-basics/entry. This module owns
// only host messages and the Extension's recursive-popover interaction policy.

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import 'katex/dist/katex.min.css';
import '@sjtu-ai4math/snl-basics/style.css';
import '@sjtu-ai4math/snl-basics/entry/style.css';
import {
  EntryDataDriver,
  EntrySurface as BasicsEntrySurface,
  MacroDataDriver,
  SnlInteractionDriver,
  type EntryContent as BasicsEntryContent,
  type KindPalette,
  type SnlInteractionContext,
  type SnlRenderHooks
} from '@sjtu-ai4math/snl-basics/entry';
import {
  use_preferences_revision,
  webview_language_runtime
} from '../runtime/preferencesRuntime';
import type { MacroRecord } from './macroData';
import { extensionRenderers } from './blockRenderers';
import { useCurrentPopoverId, useHoverPopovers } from './HoverPopoverProvider';

export interface EntryOption {
  id: string;
  title: string;
  hasContent: boolean;
  /** Raw SNL used by Basics to resolve cross-Entry x@source bindings. */
  snl?: string;
}

export type EntryContent = BasicsEntryContent;

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

export interface EntryRenderProps {
  entry: EntryData;
  kind: EntryKind | null;
  entries: EntryOption[];
  postMessage: (msg: unknown) => void;
  counterLabel?: string;
  userMacros?: MacroRecord;
  kindPalette?: KindPalette;
  markdownImageUrlTransform?: (source: string) => string;
  hooksOverride?: Partial<SnlRenderHooks>;
  disableTitleJump?: boolean;
  onTitleCtrlClick?: (entryId: string) => void;
}

/** Identity for the context query backend; presentation-only edits are ignored. */
export function entryContextRevision(entry: EntryData, entries: EntryOption[]): string {
  const sources = entries
    .map((option) => [option.id, option.snl ?? ''] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([entry.id, entry.content?.snl ?? '', sources]);
}

function hasStructuralPointer(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pointer = value as Record<string, unknown>;
  if (typeof pointer.file !== 'string' || pointer.file.trim() === '') return false;
  if (pointer.mode === 'lines') {
    if (typeof pointer.line !== 'number' || !Number.isFinite(pointer.line) || pointer.line < 1) {
      return false;
    }
    return pointer.endLine === undefined ||
      (typeof pointer.endLine === 'number' &&
        Number.isFinite(pointer.endLine) &&
        pointer.endLine >= pointer.line);
  }
  if (pointer.mode === 'regex') {
    if (typeof pointer.pattern !== 'string' || pointer.pattern === '') return false;
    if (pointer.flags !== undefined && typeof pointer.flags !== 'string') return false;
    return pointer.occurrence === undefined ||
      (typeof pointer.occurrence === 'number' &&
        Number.isInteger(pointer.occurrence) &&
        pointer.occurrence >= 1);
  }
  return false;
}

/** Local query adapter used only for Basics's cross-Entry context resolution. */
function createEntryDataDriver(entry: EntryData, entries: EntryOption[]): EntryDataDriver {
  const pool = new Map<string, EntryData>();
  pool.set(entry.id, entry);
  for (const option of entries) {
    if (pool.has(option.id)) continue;
    pool.set(option.id, {
      id: option.id,
      kind: '',
      title: option.title,
      content: option.snl === undefined ? {} : { snl: option.snl },
      contribution_info: null,
      pointer: null
    });
  }
  return new EntryDataDriver({
    queries: {
      query_entry: async ({ entry_id, signal }) => {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        return pool.get(entry_id) ?? null;
      },
      query_entry_kind: async () => null
    }
  });
}

function referencedEntryId(context: SnlInteractionContext): string | null {
  return context.macro?.source.entries[0] ??
    context.target.getAttribute('data-src') ??
    null;
}

export function EntryRender({
  entry,
  kind,
  entries,
  postMessage,
  counterLabel,
  userMacros,
  kindPalette,
  markdownImageUrlTransform,
  hooksOverride,
  disableTitleJump,
  onTitleCtrlClick
}: EntryRenderProps): React.ReactElement {
  const preferencesRevision = use_preferences_revision();
  const popovers = useHoverPopovers();
  const currentPopoverId = useCurrentPopoverId();
  const macroDataDriver = useMemo(
    () => new MacroDataDriver({
      queries: {
        query_macro: async ({ macro_name, signal }) => {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
          }
          return userMacros?.[macro_name] ?? null;
        }
      }
    }),
    [userMacros]
  );
  const contextRevision = entryContextRevision(entry, entries);
  const entryDataDriver = useMemo(
    () => createEntryDataDriver(entry, entries),
    // The adapter only queries ids and SNL. Title/pointer/contribution edits
    // must not restart context resolution or flash the loading placeholder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextRevision]
  );

  const hoverStateRef = useRef<{
    target: HTMLElement | null;
    popoverId: string | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ target: null, popoverId: null, timer: null });

  const clearCurrentHover = useCallback((): void => {
    const state = hoverStateRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.popoverId) popovers.cancelUnfrozen(state.popoverId);
    state.target = null;
    state.popoverId = null;
  }, [popovers]);

  useEffect(() => () => {
    const timer = hoverStateRef.current.timer;
    if (timer) clearTimeout(timer);
  }, []);

  const activateReferencedEntry = useCallback((context: SnlInteractionContext): void => {
    const entryId = referencedEntryId(context);
    if (entryId) postMessage({ type: 'openEntryInfoview', entryId });
  }, [postMessage]);

  const interactionDriver = useMemo(() => new SnlInteractionDriver({
    on_hover: (context) => {
      const entryId = referencedEntryId(context);
      if (!entryId) return;
      const state = hoverStateRef.current;
      if (
        state.target === context.target &&
        state.popoverId &&
        popovers.isAlive(state.popoverId)
      ) {
        popovers.updatePointer(state.popoverId, context.client_x, context.client_y);
        return;
      }
      clearCurrentHover();
      const id = popovers.spawn(
        entryId,
        context.target.getBoundingClientRect(),
        context.client_x,
        context.client_y,
        currentPopoverId
      );
      state.target = context.target;
      state.popoverId = id;
      state.timer = setTimeout(() => popovers.freeze(id), 3000);
    },
    on_leave: () => {
      const state = hoverStateRef.current;
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    },
    on_ctrl_click: activateReferencedEntry,
    // Basics deliberately keeps Meta distinct from Ctrl. Preserve the former
    // Extension behavior by handling Cmd-click through the regular callback.
    on_click: (context) => {
      if (context.meta_key) activateReferencedEntry(context);
    }
  }), [activateReferencedEntry, clearCurrentHover, currentPopoverId, popovers]);

  const hooks = useMemo<SnlRenderHooks>(() => ({
    renderTooltip: () => null,
    // `renderers` is a WHOLE-registry replacement (the view shallow-merges
    // hooks), and `extensionRenderers` already spreads SNL-Basics's defaults.
    // Placed before the override spread so a caller can still swap it out.
    //
    // The cast is a packaging artifact, not a semantic one: SNL-Basics ships
    // the same renderer types through two entry points (`.` and `/entry`) as
    // structurally identical but nominally distinct declarations, and this
    // module imports from the barrel while EntrySurface's hooks come from
    // `/entry`.
    renderers: extensionRenderers as unknown as SnlRenderHooks['renderers'],
    ...(hooksOverride ?? {})
  }), [hooksOverride]);

  const interactionPorts = useMemo(() => ({
    on_title_activate: disableTitleJump
      ? undefined
      : (entryId: string, event: React.MouseEvent) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          onTitleCtrlClick?.(entryId);
        },
    on_source_activate: (_pointer: unknown, entryId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      postMessage({ type: 'revealPointer', entryId });
    }
  }), [disableTitleJump, onTitleCtrlClick, postMessage]);

  return (
    <BasicsEntrySurface
      key={`preferences-${preferencesRevision}`}
      entry={entry}
      kind={kind}
      entry_data_driver={entryDataDriver}
      macro_data_driver={macroDataDriver}
      reader_runtime={webview_language_runtime}
      interaction_driver={interactionDriver}
      interaction_ports={interactionPorts}
      hooks={hooks}
      kind_palette={kindPalette}
      markdown_image_url_transform={markdownImageUrlTransform}
      counter_label={counterLabel}
      show_source_action={hasStructuralPointer(entry.pointer)}
    />
  );
}
