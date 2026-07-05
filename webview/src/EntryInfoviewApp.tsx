// Per-entry SNL Infoview surface. Unlike App.tsx (the picker), this webview
// renders exactly one Entry — the host sends its details (plus the full entry
// pool for macro-source resolution) after we announce readiness.

import React, { useEffect, useRef, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import {
  EntryRender,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './render/EntryRender';
import { HoverPopoverProvider } from './render/HoverPopoverProvider';
import type { SnlMacroDb } from '@snl-basics/react';

type Incoming =
  | {
      type: 'entryDetails';
      entry: EntryData | null;
      kind: EntryKind | null;
      entries: EntryOption[];
      macros?: SnlMacroDb;
    }
  | undefined;

export function EntryInfoviewApp(): React.ReactElement {
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<{
    entry: EntryData;
    kind: EntryKind | null;
    entries: EntryOption[];
  } | null>(null);
  const [userMacros, setUserMacros] = useState<SnlMacroDb | undefined>(undefined);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      if (msg.type === 'entryDetails') {
        setLoaded(true);
        if (msg.macros && typeof msg.macros === 'object') {
          setUserMacros(msg.macros);
        }
        if (!msg.entry) {
          setState(null);
          return;
        }
        setState({
          entry: msg.entry,
          kind: msg.kind,
          entries: Array.isArray(msg.entries) ? msg.entries : []
        });
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const postMessage = (message: unknown): void => {
    apiRef.current?.postMessage(message);
  };

  return (
    <HoverPopoverProvider
      postMessage={postMessage}
      entries={state?.entries ?? []}
      userMacros={userMacros}
    >
      <main style={PANEL_STYLE}>
        {!loaded ? (
          <p style={{ opacity: 0.8 }}>Loading entry…</p>
        ) : !state ? (
          <p style={{ opacity: 0.8 }}>Entry not found in this workspace.</p>
        ) : (
          <EntryRender
            entry={state.entry}
            kind={state.kind}
            entries={state.entries}
            postMessage={postMessage}
            userMacros={userMacros}
            counterLabel={undefined}
            disableTitleJump={true}
          />
        )}
      </main>
    </HoverPopoverProvider>
  );
}
