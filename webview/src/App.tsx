// SNL Infoview: the READING surface. Picks an entry from the shared pool and
// renders its SNL content via @snl-basics/react, demonstrating consumer-side
// customization of the render hooks (resolveSource + onHover).

import React, { useEffect, useRef, useState } from 'react';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';
import {
  EntryRender,
  type EntryOption,
  type EntryData,
  type EntryKind
} from './render/EntryRender';

type Incoming =
  | { type: 'entries'; entries: EntryOption[] }
  | { type: 'entryDetails'; entry: EntryData; kind: EntryKind | null }
  | undefined;

export function App(): React.ReactElement {
  const [entries, setEntries] = useState<EntryOption[]>([]);
  const [entriesLoaded, setEntriesLoaded] = useState(false);
  const [selected, setSelected] = useState<
    { entry: EntryData; kind: EntryKind | null } | null
  >(null);
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as Incoming;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'entries':
          setEntries(Array.isArray(msg.entries) ? msg.entries : []);
          setEntriesLoaded(true);
          break;
        case 'entryDetails':
          setSelected({ entry: msg.entry, kind: msg.kind });
          break;
        default:
          break;
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
    <main style={PANEL_STYLE}>
      <h1 style={{ margin: '0 0 0.75rem', fontSize: '1.25rem' }}>SNL Infoview</h1>

      {!entriesLoaded ? (
        <p style={{ opacity: 0.8 }}>Loading entries…</p>
      ) : entries.length === 0 ? (
        <NoEntries />
      ) : (
        <>
          <EntryPicker
            entries={entries}
            selectedId={selected?.entry.id}
            onSelect={(id) => postMessage({ type: 'selectEntry', id })}
          />
          {selected ? (
            <EntryRender
              entry={selected.entry}
              kind={selected.kind}
              entries={entries}
              postMessage={postMessage}
              counterLabel={undefined}
              disableTitleJump={true}
            />
          ) : (
            <p style={{ marginTop: '1rem', opacity: 0.7 }}>
              Pick an entry above to render its SNL content.
            </p>
          )}
        </>
      )}
    </main>
  );
}

function NoEntries(): React.ReactElement {
  return (
    <div style={{ opacity: 0.85 }}>
      <p style={{ margin: '0 0 0.5rem' }}>
        No entries with SNL content found in this workspace.
      </p>
      <p style={{ margin: 0, fontSize: '0.9rem' }}>
        Create one via <code>SNL: Create Entry</code> and fill in the SNL tab.
      </p>
    </div>
  );
}

function EntryPicker({
  entries,
  selectedId,
  onSelect
}: {
  entries: EntryOption[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: '1rem' }}>
      <label
        htmlFor="snl-entry-picker"
        style={{
          display: 'block',
          marginBottom: '0.35rem',
          fontWeight: 600,
          fontSize: '0.95rem'
        }}
      >
        Entry
      </label>
      <select
        id="snl-entry-picker"
        value={selectedId ?? ''}
        onChange={(e) => {
          if (e.target.value) {
            onSelect(e.target.value);
          }
        }}
        style={{
          minWidth: '20rem',
          padding: '0.4rem 0.5rem',
          color: 'var(--vscode-input-foreground, #ddd)',
          background: 'var(--vscode-input-background, #2a2a2a)',
          border:
            '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
          borderRadius: '2px',
          fontFamily: 'inherit',
          fontSize: '0.95rem'
        }}
      >
        <option value="">— select an entry —</option>
        {entries.map((e) => (
          <option key={e.id} value={e.id}>
            {e.title} ({e.id})
          </option>
        ))}
      </select>
    </div>
  );
}
