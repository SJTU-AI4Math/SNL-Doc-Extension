// SNL Create/Edit Macro Kind webview: one-shot form. Appends / updates a
// single macro kind in `config.json#macro_kinds`. Macro kinds carry only
// id/name/description and a stroke+background coloring (no numbering /
// style).
//
// In edit mode the id is readonly (it's referenced by macros' `kind` field).

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';
import { Button } from './components/Button';
import { KindTextField as TextField, ColorField, ColorPreview } from './components/KindFormFields';
import {
  EntityIdSearchBox,
  ENTRY_VALIDATE_RULES
} from './components/EntityIdSearchBox';
import type { EntryOption } from './render/EntryRender';
import { isEntityIdUnique } from './components/formValidation';

type Mode = 'create' | 'edit';

interface ExistingMacroKind {
  id: string;
  name: string;
  description: string;
  coloring: { stroke: string; background: string };
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; id: string; name: string }
  | { kind: 'updated'; id: string; name: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'notFound'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

const DEFAULT_STROKE = '#888888';
const DEFAULT_BACKGROUND = '#eeeeee';

export function CreateMacroKindApp(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('create');
  const [id, setId] = useState('');
  // Existing kind ids for the picker's dedupe check (create mode). See
  // createMacroKindPanel.ts for the shape and cat 2026-07-09 note.
  const [existingIds, setExistingIds] = useState<EntryOption[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stroke, setStroke] = useState(DEFAULT_STROKE);
  const [background, setBackground] = useState(DEFAULT_BACKGROUND);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'context';
            mode: Mode;
            id?: string;
            existing?: ExistingMacroKind | null;
            existingIds?: EntryOption[];
          }
        | { type: 'created'; kind: { id: string; name: string } }
        | { type: 'updated'; kind: { id: string; name: string } }
        | { type: 'duplicate'; id: string; message: string }
        | { type: 'notFound'; id: string; message: string }
        | { type: 'invalid'; message: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'context':
          setMode(msg.mode);
          setExistingIds(Array.isArray(msg.existingIds) ? msg.existingIds : []);
          if (msg.mode === 'edit') {
            setId(msg.id ?? '');
            if (msg.existing) {
              setName(msg.existing.name);
              setDescription(msg.existing.description || '');
              setStroke(msg.existing.coloring?.stroke || DEFAULT_STROKE);
              setBackground(
                msg.existing.coloring?.background || DEFAULT_BACKGROUND
              );
            }
          }
          return;
        case 'created':
          setStatus({
            kind: 'created',
            id: msg.kind.id,
            name: msg.kind.name
          });
          setId('');
          setName('');
          setDescription('');
          return;
        case 'updated':
          setStatus({
            kind: 'updated',
            id: msg.kind.id,
            name: msg.kind.name
          });
          return;
        case 'duplicate':
          setStatus({ kind: 'duplicate', message: msg.message });
          return;
        case 'notFound':
          setStatus({ kind: 'notFound', message: msg.message });
          return;
        case 'invalid':
          setStatus({ kind: 'invalid', message: msg.message });
          return;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          return;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          return;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          return;
      }
    }

    window.addEventListener('message', onMessage);
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const trimmedId = id.trim();
  const trimmedName = name.trim();
  const canSubmit =
    trimmedId.length > 0 &&
    trimmedName.length > 0 &&
    isEntityIdUnique(trimmedId, existingIds, mode === 'edit' ? trimmedId : undefined) &&
    status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canSubmit) return;
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      payload: {
        id: trimmedId,
        name: trimmedName,
        description: description.trim(),
        stroke: stroke.trim() || DEFAULT_STROKE,
        background: background.trim() || DEFAULT_BACKGROUND
      }
    });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '40rem' }}>
      <PanelNav
        vsApi={apiRef.current}
        back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }}
      />
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        {mode === 'edit' ? 'Edit Macro Kind' : 'Create Macro Kind'}
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        {mode === 'edit'
          ? 'Update this macro kind in .SNL_Doc/config.json#macro_kinds. The id is immutable (referenced by every macro with this kind).'
          : 'Append a single macro kind to .SNL_Doc/config.json#macro_kinds. The id must be unique and non-empty; it is referenced by a macro\u2019s kind field.'}
      </p>

      {mode === 'edit' ? (
        <TextField
          label="ID (readonly)"
          value={id}
          placeholder="e.g. rule, const, bvar\u2026"
          onChange={setId}
          readOnly
        />
      ) : (
        <div style={{ marginBottom: '0.75rem' }}>
          <label
            style={{
              display: 'block',
              marginBottom: '0.25rem',
              fontSize: '0.85rem',
              opacity: 0.85
            }}
          >
            ID (unique)
          </label>
          {/* Dedupe against existing macro-kind ids (cat 2026-07-09). */}
          <EntityIdSearchBox
            entries={existingIds}
            value={id}
            validate={ENTRY_VALIDATE_RULES.requireUnique}
            hideResolvedChip
            placeholder="e.g. rule, const, bvar\u2026"
            onChange={setId}
          />
        </div>
      )}
      <TextField
        label="Name (display)"
        value={name}
        placeholder="e.g. Rule, Constant, Bound variable\u2026"
        onChange={setName}
      />
      <TextField
        label="Description (optional)"
        value={description}
        placeholder="One-line summary of what this kind means."
        onChange={setDescription}
      />

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <ColorField label="Stroke" value={stroke} onChange={setStroke} />
        <ColorField
          label="Background"
          value={background}
          onChange={setBackground}
        />
      </div>

      <ColorPreview
        stroke={stroke}
        background={background}
        name={trimmedName || 'preview'}
      />

      <Button
        variant="primary"
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{ marginTop: '0.5rem' }}
      >
        {status.kind === 'creating'
          ? mode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
          : mode === 'edit' ? 'Update Macro Kind' : 'Create Macro Kind'}
      </Button>

      <StatusLine status={status} />
    </main>
  );
}

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') return null;

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `\u2705 Created "${status.name}" (id: ${status.id}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = `\u2705 Updated "${status.name}" (id: ${status.id}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (
    status.kind === 'duplicate' ||
    status.kind === 'invalid' ||
    status.kind === 'notFound'
  ) {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
