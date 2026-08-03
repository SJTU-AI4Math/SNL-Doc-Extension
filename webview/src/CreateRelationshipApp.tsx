// SNL Create/Edit Relationship webview (cat 2026-07-10).
//
// A pool-wide relationship is a directed edge between two entries with a
// free-text label + arbitrary `metadata: any`. The editor is deliberately
// minimal — see snlDoc.ts §Relationships for the storage contract and
// createRelationshipPanel.ts for the message protocol.
//
// Layout (top → bottom):
//   1. PanelHeader — shared branding, language, and back to Dashboard
//   2. ID       — string field; requireUnique in create, read-only in edit
//   3. From     — EntityIdSearchBox against the entry pool (requireMatch)
//   4. To       — EntityIdSearchBox against the entry pool (requireMatch)
//   5. Label    — free text
//   6. Metadata — raw JSON textarea (parsed on submit; empty → null)
//   7. Submit + status banner

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { PanelHeader } from './components/PanelHeader';
import { Button } from './components/Button';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES,
  resolveEntryOption
} from './components/EntityIdSearchBox';
import type { EntryOption } from './render/EntryRender';
import { useSaveShortcut } from './components/draftState';

interface RelationshipData {
  id: string;
  from: string;
  to: string;
  label: string;
  metadata: unknown;
}

interface ContextMessage {
  type: 'context';
  mode: 'create' | 'edit';
  id?: string;
  existing?: RelationshipData | null;
  entryPool: Array<{ id: string; title: string }>;
  existingIds: string[];
}

type IncomingMessage =
  | ContextMessage
  | { type: 'created'; id: string }
  | { type: 'updated'; id: string }
  | { type: 'duplicate'; id: string; message: string }
  | {
      type: 'unknownEndpoint';
      endpoint: 'from' | 'to';
      id: string;
      message: string;
    }
  | { type: 'notFound'; id: string; message: string }
  | { type: 'invalid'; reason: string }
  | { type: 'noSnlDoc'; message: string }
  | { type: 'noWorkspace'; message: string }
  | { type: 'error'; message: string };

interface Banner {
  kind: 'ok' | 'warn' | 'error';
  text: string;
}

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  marginBottom: '0.25rem',
  opacity: 0.85
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '0.4rem 0.55rem',
  fontFamily: 'inherit',
  fontSize: '0.95rem',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  background: 'var(--vscode-input-background, rgba(255,255,255,0.04))',
  color: 'inherit',
  borderRadius: '3px',
  boxSizing: 'border-box'
};

const MONO_INPUT_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};

const ROW_STYLE: React.CSSProperties = { marginBottom: '1rem' };

/** Stringify metadata for the textarea. `null`/`undefined` → empty. */
function formatMetadata(v: unknown): string {
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return '';
  }
}

/** Parse the metadata textarea. Empty → null. Invalid JSON → thrown Error. */
function parseMetadata(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function CreateRelationshipApp(): React.ReactElement {
  const apiRef = useRef<VsCodeApi | undefined>(undefined);
  const [mode, setMode] = useState<'create' | 'edit'>('create');
  const [id, setId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [label, setLabel] = useState('');
  const [metadata, setMetadata] = useState('');
  const [entryPool, setEntryPool] = useState<EntryOption[]>([]);
  const [existingIds, setExistingIds] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as IncomingMessage | undefined;
      if (!msg) return;
      switch (msg.type) {
        case 'context': {
          setMode(msg.mode);
          const pool: EntryOption[] = msg.entryPool.map((e) => ({
            id: e.id,
            title: e.title,
            hasContent: false
          }));
          setEntryPool(pool);
          setExistingIds(msg.existingIds ?? []);
          if (msg.mode === 'edit' && msg.existing) {
            setId(msg.existing.id);
            setFrom(msg.existing.from);
            setTo(msg.existing.to);
            setLabel(msg.existing.label);
            setMetadata(formatMetadata(msg.existing.metadata));
          } else {
            setId('');
            setFrom('');
            setTo('');
            setLabel('');
            setMetadata('');
          }
          setLoaded(true);
          return;
        }
        case 'created':
          setBanner({ kind: 'ok', text: `Created relationship "${msg.id}".` });
          setBusy(false);
          return;
        case 'updated':
          setBanner({ kind: 'ok', text: `Updated relationship "${msg.id}".` });
          setBusy(false);
          return;
        case 'duplicate':
          setBanner({ kind: 'warn', text: msg.message });
          setBusy(false);
          return;
        case 'unknownEndpoint':
          setBanner({
            kind: 'warn',
            text: `${msg.message} (endpoint: ${msg.endpoint})`
          });
          setBusy(false);
          return;
        case 'notFound':
        case 'noSnlDoc':
        case 'noWorkspace':
        case 'error':
          setBanner({ kind: 'error', text: msg.message });
          setBusy(false);
          return;
        case 'invalid':
          setBanner({ kind: 'error', text: `Invalid: ${msg.reason}` });
          setBusy(false);
          return;
      }
    }
    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Validation helpers.
  const trimmedId = id.trim();
  const trimmedLabel = label.trim();
  const trimmedFrom = from.trim();
  const trimmedTo = to.trim();
  const idDupeInCreate =
    mode === 'create' &&
    trimmedId.length > 0 &&
    existingIds.includes(trimmedId);
  const fromResolved = useMemo(
    () => resolveEntryOption(trimmedFrom, entryPool),
    [entryPool, trimmedFrom]
  );
  const toResolved = useMemo(
    () => resolveEntryOption(trimmedTo, entryPool),
    [entryPool, trimmedTo]
  );
  let metadataError: string | null = null;
  try {
    parseMetadata(metadata);
  } catch (err) {
    metadataError = err instanceof Error ? err.message : String(err);
  }

  const canSubmit =
    loaded &&
    !busy &&
    trimmedId.length > 0 &&
    !idDupeInCreate &&
    !!fromResolved &&
    !!toResolved &&
    trimmedLabel.length > 0 &&
    metadataError === null;

  // Ctrl/Cmd+S is the same action as the Create/Update button.
  useSaveShortcut(() => onSubmit(), canSubmit);

  function onSubmit(): void {
    if (!canSubmit) return;
    let parsedMetadata: unknown;
    try {
      parsedMetadata = parseMetadata(metadata);
    } catch (err) {
      setBanner({
        kind: 'error',
        text: `Metadata is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      });
      return;
    }
    setBusy(true);
    setBanner(null);
    const payload: RelationshipData = {
      id: trimmedId,
      from: trimmedFrom,
      to: trimmedTo,
      label: trimmedLabel,
      metadata: parsedMetadata
    };
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      relationship: payload
    });
  }

  if (!loaded) {
    return (
      <main style={PANEL_STYLE}>
        <PanelHeader
          vsApi={apiRef.current}
          title={mode === 'edit' ? 'Edit Relationship' : 'Create Relationship'}
          back={{
            label: 'Dashboard',
            title: 'Back to SNL Dashboard',
            message: { type: 'nav.openDashboard' }
          }}
        />
        <p style={{ opacity: 0.7 }}>Loading relationship context…</p>
      </main>
    );
  }

  return (
    <main style={PANEL_STYLE}>
      <PanelHeader
        vsApi={apiRef.current}
        title={mode === 'edit'
          ? `Edit Relationship — ${trimmedId || id}`
          : 'Create Relationship'}
        back={{
          label: '← Dashboard',
          title: 'Back to SNL Dashboard',
          message: { type: 'nav.openDashboard' }
        }}
      />

      <div style={ROW_STYLE}>
        <label htmlFor="rel-id" style={LABEL_STYLE}>
          ID {mode === 'edit' ? '(read-only)' : '(required, unique)'}
        </label>
        <input
          id="rel-id"
          type="text"
          value={id}
          readOnly={mode === 'edit'}
          onChange={(e) => setId(e.target.value)}
          placeholder="e.g. depends.contMul.mulComm"
          style={{
            ...MONO_INPUT_STYLE,
            opacity: mode === 'edit' ? 0.7 : 1,
            borderColor: idDupeInCreate
              ? 'var(--vscode-errorForeground, #f14c4c)'
              : MONO_INPUT_STYLE.border as string
          }}
        />
        {idDupeInCreate ? (
          <div
            style={{
              marginTop: '0.25rem',
              fontSize: '0.8rem',
              color: 'var(--vscode-errorForeground, #f14c4c)'
            }}
          >
            Id "{trimmedId}" already exists.
          </div>
        ) : null}
      </div>

      <div style={ROW_STYLE}>
        <EntityIdSearchBox
          label="From (source entry)"
          entries={entryPool}
          value={from}
          onChange={setFrom}
          validate={ENTRY_VALIDATE_RULES.requireMatch}
          placeholder="Pick a source entry id"
          idPrefix="rel-from"
        />
      </div>

      <div style={ROW_STYLE}>
        <EntityIdSearchBox
          label="To (target entry)"
          entries={entryPool}
          value={to}
          onChange={setTo}
          validate={ENTRY_VALIDATE_RULES.requireMatch}
          placeholder="Pick a target entry id"
          idPrefix="rel-to"
        />
      </div>

      <div style={ROW_STYLE}>
        <label htmlFor="rel-label" style={LABEL_STYLE}>
          Label (required)
        </label>
        <input
          id="rel-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. depends-on, generalizes, proves"
          style={INPUT_STYLE}
        />
      </div>

      <div style={ROW_STYLE}>
        <label htmlFor="rel-metadata" style={LABEL_STYLE}>
          Metadata (optional, raw JSON — empty ⇒ null)
        </label>
        <textarea
          id="rel-metadata"
          value={metadata}
          onChange={(e) => setMetadata(e.target.value)}
          placeholder='{"weight": 1, "note": "..."}'
          rows={8}
          style={{
            ...MONO_INPUT_STYLE,
            resize: 'vertical',
            borderColor: metadataError
              ? 'var(--vscode-errorForeground, #f14c4c)'
              : MONO_INPUT_STYLE.border as string
          }}
        />
        {metadataError ? (
          <div
            style={{
              marginTop: '0.25rem',
              fontSize: '0.8rem',
              color: 'var(--vscode-errorForeground, #f14c4c)'
            }}
          >
            JSON parse error: {metadataError}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <Button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          variant="primary"
        >
          {busy
            ? 'Saving…'
            : mode === 'edit'
              ? 'Save Changes'
              : 'Create Relationship'}
        </Button>
        {banner ? (
          <span
            style={{
              fontSize: '0.9rem',
              color:
                banner.kind === 'ok'
                  ? 'var(--vscode-terminal-ansiGreen, #4ec9b0)'
                  : banner.kind === 'warn'
                    ? 'var(--vscode-editorWarning-foreground, #d7a35a)'
                    : 'var(--vscode-errorForeground, #f14c4c)'
            }}
          >
            {banner.text}
          </span>
        ) : null}
      </div>
    </main>
  );
}
