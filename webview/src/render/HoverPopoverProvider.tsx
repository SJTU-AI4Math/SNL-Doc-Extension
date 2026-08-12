// VS Code adapter over SNL-Basics's generic recursive hover-popover stack.
// The shared library owns lifecycle, timers, positioning, portal rendering,
// subtree dismissal, and pointer-union hit testing. This file owns only the
// Extension-specific entry loader and EntrySurface rendering.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  HoverPopoverDismissController,
  HoverPopoverProvider as SharedHoverPopoverProvider,
  useCurrentPopoverId as useSharedCurrentPopoverId,
  useHoverPopovers as useSharedHoverPopovers,
  type HoverPopover,
  type HoverPopoverApi,
  type KindPalette,
  type PopoverPhase,
  type SnlActivationLease
} from '@sjtu-ai4math/snl-basics';
import {
  EntrySurface,
  isEntryDataPayload,
  isEntryKindPayload,
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
    notFoundSuffix: ' not found in the shared pool.',
    loadFailed: 'Could not load Entry {id}: {message}'
  },
  {
    loading: '正在加载…',
    notFoundPrefix: '条目 ',
    notFoundSuffix: ' 不在共享池中。',
    loadFailed: '无法加载条目 {id}：{message}'
  }
);

export type PopoverInstance = HoverPopover<string>;
export type HoverPopoverContextValue = HoverPopoverApi<string>;
export type { PopoverPhase };

type RegisterPopoverActivation = (
  popoverId: string | null,
  activation: SnlActivationLease | undefined
) => void;

const PopoverActivationRegistryContext = React.createContext<RegisterPopoverActivation>(() => undefined);
const useSsrSafeLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function useRegisterPopoverActivation(): RegisterPopoverActivation {
  return React.useContext(PopoverActivationRegistryContext);
}

function PopoverApiBridge({
  apiRef
}: {
  apiRef: React.MutableRefObject<HoverPopoverApi<string> | null>;
}): null {
  const api = useSharedHoverPopovers<string>();
  useSsrSafeLayoutEffect(() => {
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [api, apiRef]);
  return null;
}

export function entryDetailsRequest(
  entryId: string,
  entries: EntryOption[],
  entryPackages: Readonly<Record<string, string>> = {},
  popoverRequestKey?: string
): {
  type: 'requestEntryDetails';
  entryId: string;
  entryPackage?: string;
  popoverRequestKey?: string;
} {
  const entryPackage = entries.find((entry) => entry.id === entryId)?.package
    ?? entryPackages[entryId];
  return {
    type: 'requestEntryDetails',
    entryId,
    ...(typeof entryPackage === 'string' && entryPackage ? { entryPackage } : {}),
    ...(popoverRequestKey ? { popoverRequestKey } : {})
  };
}

export function popoverRequestIdentity(
  entryId: string,
  entries: EntryOption[],
  entryPackages: Readonly<Record<string, string>>,
  snapshotGeneration: number
): {
  key: string;
  request: ReturnType<typeof entryDetailsRequest>;
} {
  const entryPackage = entries.find((entry) => entry.id === entryId)?.package
    ?? entryPackages[entryId]
    ?? '';
  const key = JSON.stringify([snapshotGeneration, entryPackage, entryId]);
  return {
    key,
    request: entryDetailsRequest(entryId, entries, entryPackages, key)
  };
}

export interface PopoverDetail {
  entry: EntryData | null;
  kind: EntryKind | null;
  error?: string;
}

/** Parse only correlated, terminal host responses; malformed messages remain pending. */
export function popoverTerminalDetail(
  message: unknown,
  entryId: string,
  popoverRequestKey?: string
): PopoverDetail | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  if (msg.entryId !== entryId) return null;
  if (popoverRequestKey !== undefined && msg.popoverRequestKey !== popoverRequestKey) return null;
  if (msg.type === 'popoverEntryDetailsError') {
    return typeof msg.message === 'string' && msg.message
      ? { entry: null, kind: null, error: msg.message }
      : null;
  }
  if (msg.type !== 'popoverEntryDetails' || !Object.hasOwn(msg, 'entry')) return null;
  if (msg.entry !== null && !isEntryDataPayload(msg.entry)) return null;
  if (msg.kind !== undefined && msg.kind !== null && !isEntryKindPayload(msg.kind)) return null;
  return {
    entry: msg.entry as EntryData | null,
    kind: (msg.kind as EntryKind | null | undefined) ?? null
  };
}

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
  /** Operation-local id→package identity, including Entries outside that pool. */
  entryPackages?: Readonly<Record<string, string>>;
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
const EMPTY_ENTRY_PACKAGES: Readonly<Record<string, string>> = Object.freeze({});

function EntryPopoverContent({
  entryId,
  requestIdentity,
  detail,
  requestDetails,
  entries,
  postMessage,
  userMacros,
  kindPalette,
  markdownImageUrlTransform
}: {
  entryId: string;
  requestIdentity: ReturnType<typeof popoverRequestIdentity>;
  detail: PopoverDetail | undefined;
  requestDetails: (identity: ReturnType<typeof popoverRequestIdentity>) => void;
  entries: EntryOption[];
  postMessage: (msg: unknown) => void;
  userMacros?: MacroRecord;
  kindPalette?: KindPalette;
  markdownImageUrlTransform?: (source: string) => string;
}): React.ReactElement {
  const t = useUiMessages(MESSAGES);
  useEffect(() => {
    if (detail === undefined) requestDetails(requestIdentity);
  }, [detail, requestDetails, requestIdentity]);

  if (detail === undefined) {
    return <div style={{ padding: '0.6rem 0.8rem', color: '#333' }}>{t('loading')}</div>;
  }
  if (detail.error) {
    return (
      <div role="alert" style={{ padding: '0.6rem 0.8rem', color: 'var(--vscode-errorForeground, #a1260d)' }}>
        {t('loadFailed', { id: entryId, message: detail.error })}
      </div>
    );
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
  entryPackages,
  userMacros,
  kindPalette,
  markdownImageUrlTransform,
  localDetails
}: HoverPopoverProviderProps): React.ReactElement {
  const popoverApiRef = useRef<HoverPopoverApi<string> | null>(null);
  const activationRegistryRef = useRef<Map<string, Set<SnlActivationLease>>>(new Map());
  const registerActivation = useCallback<RegisterPopoverActivation>((popoverId, activation) => {
    if (!popoverId || !activation) return;
    let activations = activationRegistryRef.current.get(popoverId);
    if (!activations) {
      activations = new Set();
      activationRegistryRef.current.set(popoverId, activations);
    }
    activations.add(activation);
  }, []);
  const dismissController = useMemo(
    () => new HoverPopoverDismissController<undefined, string>({
      params: undefined,
      on_request: ({ request, runDefault }) => {
        if (request.reason !== 'escape') {
          runDefault();
          return;
        }
        const deepest = request.targets[0];
        const api = popoverApiRef.current;
        if (!deepest || !api) return;
        request.native_event?.preventDefault();
        request.native_event?.stopImmediatePropagation();
        const activations = [...(activationRegistryRef.current.get(deepest.id) ?? [])];
        // Reserve the popover's closing state before leases can re-enter dismissal.
        api.dismissSubtree(deepest.id);
        activationRegistryRef.current.delete(deepest.id);
        for (const activation of activations) {
          try {
            activation.request_deactivate('popover-dismiss', request.native_event);
          } catch {
            // One consumer lease must not prevent the rest of the layer from clearing.
          }
        }
      },
      on_removed: (targets) => {
        for (const target of targets) activationRegistryRef.current.delete(target.id);
      }
    }),
    []
  );
  const packageIdentities = entryPackages && Object.keys(entryPackages).length > 0
    ? entryPackages
    : EMPTY_ENTRY_PACKAGES;
  const [details, setDetails] = useState<{
    generation: number;
    values: Record<string, PopoverDetail>;
  }>({ generation: 0, values: {} });
  const requestedRef = useRef<Set<string>>(new Set());
  const snapshotRef = useRef({ entries, packageIdentities, localDetails, generation: 0 });
  if (snapshotRef.current.entries !== entries ||
      snapshotRef.current.packageIdentities !== packageIdentities ||
      snapshotRef.current.localDetails !== localDetails) {
    snapshotRef.current = {
      entries,
      packageIdentities,
      localDetails,
      generation: snapshotRef.current.generation + 1
    };
    // Each cache key includes the new generation. Clearing the request set
    // bounds memory while still deduplicating every Entry within one snapshot.
    requestedRef.current.clear();
  }
  const snapshotGeneration = snapshotRef.current.generation;

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const message = event.data && typeof event.data === 'object'
        ? event.data as { entryId?: unknown; popoverRequestKey?: unknown }
        : undefined;
      if (typeof message?.entryId !== 'string' ||
          typeof message.popoverRequestKey !== 'string') return;
      if (!requestedRef.current.has(message.popoverRequestKey)) return;
      const detail = popoverTerminalDetail(
        event.data,
        message.entryId,
        message.popoverRequestKey
      );
      if (!detail) return;
      const generation = snapshotRef.current.generation;
      setDetails((previous) => ({
        generation,
        values: {
          ...(previous.generation === generation ? previous.values : {}),
          [message.popoverRequestKey as string]: detail
        }
      }));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const requestDetails = useCallback(
    (identity: ReturnType<typeof popoverRequestIdentity>): void => {
      const local = localDetails?.[identity.request.entryId];
      if (local) {
        const generation = snapshotRef.current.generation;
        setDetails((previous) => ({
          generation,
          values: {
            ...(previous.generation === generation ? previous.values : {}),
            [identity.key]: local
          }
        }));
        return;
      }
      if (requestedRef.current.has(identity.key)) return;
      requestedRef.current.add(identity.key);
      postMessage(identity.request);
    },
    [localDetails, postMessage]
  );

  const renderPopover = useCallback(
    (popover: HoverPopover<string>): React.ReactNode => {
      const requestIdentity = popoverRequestIdentity(
        popover.subject,
        entries,
        packageIdentities,
        snapshotGeneration
      );
      return (
        <EntryPopoverContent
          entryId={popover.subject}
          requestIdentity={requestIdentity}
          detail={details.generation === snapshotGeneration
            ? details.values[requestIdentity.key]
            : undefined}
          requestDetails={requestDetails}
          entries={entries}
          postMessage={postMessage}
          userMacros={userMacros}
          kindPalette={kindPalette}
          markdownImageUrlTransform={markdownImageUrlTransform}
        />
      );
    },
    [details, entries, packageIdentities, snapshotGeneration, postMessage, requestDetails,
      userMacros, kindPalette, markdownImageUrlTransform]
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
    <PopoverActivationRegistryContext.Provider value={registerActivation}>
      <SharedHoverPopoverProvider<string>
        renderPopover={renderPopover}
        options={{ openDelayMs: HOVER_OPEN_DELAY_MS, fadeMs: FADE_MS }}
        style={style}
        dismiss_controller={dismissController}
      >
        <PopoverApiBridge apiRef={popoverApiRef} />
        {children}
      </SharedHoverPopoverProvider>
    </PopoverActivationRegistryContext.Provider>
  );
}
