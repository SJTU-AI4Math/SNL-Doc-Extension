// VS Code adapter over SNL-Basics's generic recursive hover-popover stack.
// The shared library owns lifecycle, timers, positioning, portal rendering,
// subtree dismissal, and pointer-union hit testing. This file owns only the
// Extension-specific entry loader and EntrySurface rendering.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HoverPopoverProvider as SharedHoverPopoverProvider,
  useCurrentPopoverId as useSharedCurrentPopoverId,
  useHoverPopovers as useSharedHoverPopovers,
  type HoverPopover,
  type HoverPopoverApi,
  type KindPalette,
  type PopoverPhase
} from '@sjtu-ai4math/snl-basics';
import {
  EntrySurface,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './EntrySurface';
import type { MacroRecord } from './macroData';
import { popoverFrameStyle } from './popoverFrame';
import { defineUiMessages, useUiMessages } from '../i18n/uiMessages';

const MESSAGES = defineUiMessages(
  'hoverPopover',
  {
    loading: 'Loading…',
    notFoundPrefix: 'Entry ',
    notFoundSuffix: ' not found in the shared pool.'
  },
  {
    loading: '正在加载…',
    notFoundPrefix: '条目 ',
    notFoundSuffix: ' 不在共享池中。'
  }
);

export type PopoverInstance = HoverPopover<string>;
export type HoverPopoverContextValue = HoverPopoverApi<string>;
export type { PopoverPhase };

export function useHoverPopovers(): HoverPopoverContextValue {
  return useSharedHoverPopovers<string>();
}

export function useCurrentPopoverId(): string | null {
  return useSharedCurrentPopoverId();
}

interface HoverPopoverProviderProps {
  children: React.ReactNode;
  /** Webview→host bridge for lazy entry-detail requests and navigation. */
  postMessage: (msg: unknown) => void;
  /** Entry pool forwarded to popover EntrySurfaces for source resolution. */
  entries: EntryOption[];
  /** User macro DB forwarded to nested EntrySurfaces. */
  userMacros?: MacroRecord;
  /** Workspace Macro Kind colors shared by every nested EntrySurface. */
  kindPalette?: KindPalette;
  /** Workspace asset resolver shared by every nested Markdown Entry. */
  markdownImageUrlTransform?: (source: string) => string;
  /** Unsaved/local entries that win over lazy host details. */
  localDetails?: Record<string, { entry: EntryData; kind: EntryKind | null }>;
}

const HOVER_OPEN_DELAY_MS = 1000;
const FADE_MS = 150;
const POPOVER_MAX_WIDTH = 720;

function EntryPopoverContent({
  entryId,
  detail,
  requestDetails,
  entries,
  postMessage,
  userMacros,
  kindPalette,
  markdownImageUrlTransform
}: {
  entryId: string;
  detail: { entry: EntryData | null; kind: EntryKind | null } | undefined;
  requestDetails: (entryId: string) => void;
  entries: EntryOption[];
  postMessage: (msg: unknown) => void;
  userMacros?: MacroRecord;
  kindPalette?: KindPalette;
  markdownImageUrlTransform?: (source: string) => string;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  useEffect(() => {
    if (detail === undefined) requestDetails(entryId);
  }, [detail, entryId, requestDetails]);

  if (detail === undefined) {
    return <div style={{ padding: '0.6rem 0.8rem', color: '#333' }}>{t('loading')}</div>;
  }
  if (detail.entry === null) {
    return (
      <div style={{ padding: '0.6rem 0.8rem', color: '#333', fontStyle: 'italic' }}>
        {t('notFoundPrefix')}<code>{entryId}</code>{t('notFoundSuffix')}
      </div>
    );
  }
  return (
    <EntrySurface
      entry={detail.entry}
      kind={detail.kind}
      entries={entries}
      postMessage={postMessage}
      userMacros={userMacros}
      kindPalette={kindPalette}
      markdownImageUrlTransform={markdownImageUrlTransform}
      counterLabel={undefined}
      disableTitleJump={false}
      onTitleCtrlClick={(id) => postMessage({ type: 'openEntryInfoview', entryId: id })}
    />
  );
}

export function HoverPopoverProvider({
  children,
  postMessage,
  entries,
  userMacros,
  kindPalette,
  markdownImageUrlTransform,
  localDetails
}: HoverPopoverProviderProps): React.ReactElement {
  const [details, setDetails] = useState<
    Record<string, { entry: EntryData | null; kind: EntryKind | null }>
  >({});
  const requestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type?: string;
            entryId?: string;
            entry?: EntryData | null;
            kind?: EntryKind | null;
          }
        | undefined;
      if (!msg || msg.type !== 'popoverEntryDetails' || typeof msg.entryId !== 'string') {
        return;
      }
      setDetails((previous) => ({
        ...previous,
        [msg.entryId as string]: {
          entry: msg.entry ?? null,
          kind: msg.kind ?? null
        }
      }));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const requestDetails = useCallback(
    (entryId: string): void => {
      const local = localDetails?.[entryId];
      if (local) {
        setDetails((previous) => ({ ...previous, [entryId]: local }));
        return;
      }
      if (requestedRef.current.has(entryId)) return;
      requestedRef.current.add(entryId);
      postMessage({ type: 'requestEntryDetails', entryId });
    },
    [localDetails, postMessage]
  );

  const renderPopover = useCallback(
    (popover: HoverPopover<string>): React.ReactNode => (
      <EntryPopoverContent
        entryId={popover.subject}
        detail={details[popover.subject]}
        requestDetails={requestDetails}
        entries={entries}
        postMessage={postMessage}
        userMacros={userMacros}
        kindPalette={kindPalette}
        markdownImageUrlTransform={markdownImageUrlTransform}
      />
    ),
    [details, entries, postMessage, requestDetails, userMacros, kindPalette, markdownImageUrlTransform]
  );

  const style = useMemo(
    () => (popover: HoverPopover<string>): React.CSSProperties => ({
      ...popoverFrameStyle(),
      maxWidth: POPOVER_MAX_WIDTH,
      width: 'max-content',
      background: '#ffffff',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
      borderRadius: 0,
      overflowX: 'hidden',
      overflowY: 'auto',
      maxHeight: '80vh',
      // The shared provider owns phase transitions; these values remain here
      // because the visual frame is Extension-specific.
      opacity: popover.phase === 'visible' ? 1 : 0,
      pointerEvents: popover.phase === 'visible' ? 'auto' : 'none'
    }),
    []
  );

  return (
    <SharedHoverPopoverProvider<string>
      renderPopover={renderPopover}
      options={{ openDelayMs: HOVER_OPEN_DELAY_MS, fadeMs: FADE_MS }}
      style={style}
    >
      {children}
    </SharedHoverPopoverProvider>
  );
}
