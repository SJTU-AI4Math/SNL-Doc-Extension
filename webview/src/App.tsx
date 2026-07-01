// SNL Infoview: the READING surface. Picks an entry from the shared pool and
// renders its SNL content via @snl-basics/react, demonstrating consumer-side
// customization of the render hooks (resolveSource + onHover).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import '@snl-basics/react/style.css';
import {
  parseSnlSyntaxTree,
  tryParseSnlSyntaxTree,
  createMacroTemplateQueryFromDb,
  defaultRenderHooks,
  SnlSyntaxTreeView,
  type SnlMacroDb,
  type SnlMacroTemplateQuery,
  type SnlRenderHooks
} from '@snl-basics/react';
import macroDbJson from '@snl-basics/react/snl-macro-db.json';
import { getVsCodeApi, PANEL_STYLE, type VsCodeApi } from './vscodeApi';

// Static, network-free macro DB bundled from @snl-basics/react. The JSON
// import is typed `any`, so we assert the published shape once here.
const MACRO_DB = macroDbJson as unknown as SnlMacroDb;
const MACRO_QUERY: SnlMacroTemplateQuery = createMacroTemplateQueryFromDb(MACRO_DB);

// KaTeX must run with the HTML extension enabled (trust) and non-strict so the
// `\htmlData{...}` attributes SNL-Basics emits survive into the DOM — these
// back the hover / source-resolution features. Without this, hover is inert.
const KATEX_OPTIONS = { trust: true, strict: false as const };

// ---------------------------------------------------------------------------
// Host <-> webview shapes (mirrors src/snlDoc.ts, kept local so the webview
// doesn't pull in the `vscode`-dependent extension module).
// ---------------------------------------------------------------------------

interface EntryOption {
  id: string;
  title: string;
  hasContent: boolean;
}

interface EntryContent {
  snl?: string;
  typst?: string;
  latex?: string;
  markdown?: string;
  text?: string;
}

interface EntryData {
  id: string;
  kind: string;
  title: string;
  content: EntryContent;
  contribution_info: unknown;
  pointer: unknown;
}

interface EntryKind {
  id: string;
  name: string;
  coloring: { stroke: string; background: string };
  numbering: string;
  style: string;
}

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

function EntryRender({
  entry,
  kind,
  entries,
  postMessage
}: {
  entry: EntryData;
  kind: EntryKind | null;
  entries: EntryOption[];
  postMessage: (message: unknown) => void;
}): React.ReactElement {
  const snl = entry.content?.snl ?? '';

  // Consumer-injected hooks. Rebuilt when the pool changes so resolveSource
  // always sees the current entry universe.
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
      // Demo: forward hover events to the extension host output channel.
      onHover: (event) => {
        postMessage({ type: 'log', level: 'info', msg: `hover ${event.name}` });
      }
    };
  }, [entries, postMessage]);

  const parsed = useMemo(() => tryParseSnlSyntaxTree(snl), [snl]);
  const stroke = kind?.coloring.stroke ?? '#888888';
  const background = kind?.coloring.background ?? '#eeeeee';

  return (
    <section
      style={{
        border: `1px solid ${stroke}`,
        borderRadius: '4px',
        overflow: 'hidden'
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.55rem 0.8rem',
          background,
          color: '#111'
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: '0.9rem',
            height: '0.9rem',
            borderRadius: '2px',
            border: `1px solid ${stroke}`,
            background: kind?.coloring.background ?? '#fff'
          }}
        />
        <strong style={{ color: stroke }}>{entry.title}</strong>
        <span style={{ opacity: 0.7, fontSize: '0.85rem' }}>
          {kind ? kind.name : entry.kind}
        </span>
      </header>
      <div
        style={{
          padding: '0.9rem',
          background: '#ffffff',
          color: '#111',
          fontSize: '1.05rem'
        }}
      >
        {parsed.ok ? (
          <SnlSyntaxTreeView
            tree={parseSnlSyntaxTree(snl)}
            templateDb={MACRO_DB}
            query={MACRO_QUERY}
            hooks={hooks}
            katexOptions={KATEX_OPTIONS}
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
