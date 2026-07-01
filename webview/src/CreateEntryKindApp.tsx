// SNL Create Entry Kind webview: one-shot form. Fields are stored verbatim;
// the numbering DSL isn't validated here — the Entry editor (not built yet)
// owns that.

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; id: string; name: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

const DEFAULT_STROKE = '#888888';
const DEFAULT_BACKGROUND = '#eeeeee';

export function CreateEntryKindApp(): React.ReactElement {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [stroke, setStroke] = useState(DEFAULT_STROKE);
  const [background, setBackground] = useState(DEFAULT_BACKGROUND);
  const [numbering, setNumbering] = useState('');
  const [style, setStyle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'created'; kind: { id: string; name: string } }
        | { type: 'duplicate'; id: string; message: string }
        | { type: 'invalid'; message: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'created':
          setStatus({
            kind: 'created',
            id: msg.kind.id,
            name: msg.kind.name
          });
          // Reset id/name so the panel can be used again quickly; keep
          // colours/style since the user likely wants to reuse them.
          setId('');
          setName('');
          setNumbering('');
          return;
        case 'duplicate':
          setStatus({ kind: 'duplicate', message: msg.message });
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
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const trimmedId = id.trim();
  const trimmedName = name.trim();
  const canCreate =
    trimmedId.length > 0 &&
    trimmedName.length > 0 &&
    status.kind !== 'creating';

  function handleCreate(): void {
    if (!canCreate) return;
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: 'create',
      payload: {
        id: trimmedId,
        name: trimmedName,
        stroke: stroke.trim() || DEFAULT_STROKE,
        background: background.trim() || DEFAULT_BACKGROUND,
        numbering: numbering.trim(),
        style: style.trim()
      }
    });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '40rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        Create Entry Kind
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.85 }}>
        Append a single entry kind to{' '}
        <code>.SNL_Doc/config.json#entry_kinds</code>. The id must be unique
        and non-empty; other fields can be edited later by hand.
      </p>

      <TextField
        label="ID (unique)"
        value={id}
        placeholder="e.g. definition, theorem, remark…"
        onChange={setId}
      />
      <TextField
        label="Name (display)"
        value={name}
        placeholder="e.g. 定义, Definition, Theorem…"
        onChange={setName}
      />

      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <ColorField
          label="Stroke"
          value={stroke}
          onChange={setStroke}
        />
        <ColorField
          label="Background"
          value={background}
          onChange={setBackground}
        />
      </div>

      <ColorPreview stroke={stroke} background={background} name={trimmedName || 'preview'} />

      <TextField
        label="Numbering DSL"
        value={numbering}
        placeholder='e.g. "1.1.1" (three-level), "1" (flat), "" (unnumbered)'
        onChange={setNumbering}
        mono
      />
      <TextField
        label="Style tag"
        value={style}
        placeholder='e.g. "remark", "proof", "problem", "" (default)'
        onChange={setStyle}
        mono
      />

      <button
        type="button"
        onClick={handleCreate}
        disabled={!canCreate}
        style={{ ...primaryButton(canCreate), marginTop: '0.5rem' }}
      >
        {status.kind === 'creating' ? 'Creating…' : 'Create Entry Kind'}
      </button>

      <StatusLine status={status} />
    </main>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  mono
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <label
        style={{ display: 'block', marginBottom: '0.3rem', fontWeight: 600 }}
      >
        {label}
      </label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.4rem 0.55rem',
          color: 'var(--vscode-input-foreground, #ddd)',
          background: 'var(--vscode-input-background, #2a2a2a)',
          border:
            '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
          borderRadius: '2px',
          fontFamily: mono
            ? 'var(--vscode-editor-font-family, monospace)'
            : 'inherit',
          fontSize: '0.95rem'
        }}
      />
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: '0.75rem', flex: 1 }}>
      <label
        style={{ display: 'block', marginBottom: '0.3rem', fontWeight: 600 }}
      >
        {label}
      </label>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch' }}>
        <input
          type="color"
          value={sanitizeForColorInput(value)}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '2.5rem',
            padding: 0,
            border:
              '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
            borderRadius: '2px',
            background: 'transparent'
          }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            flex: 1,
            padding: '0.4rem 0.55rem',
            color: 'var(--vscode-input-foreground, #ddd)',
            background: 'var(--vscode-input-background, #2a2a2a)',
            border:
              '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
            borderRadius: '2px',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            fontSize: '0.95rem'
          }}
        />
      </div>
    </div>
  );
}

/** `<input type="color">` only accepts `#rrggbb`. Fall back to grey for
 *  anything else (short hex, rgb(...), named colours) so the picker keeps
 *  working; the text field always shows the original value. */
function sanitizeForColorInput(value: string): string {
  const v = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v : '#888888';
}

function ColorPreview({
  stroke,
  background,
  name
}: {
  stroke: string;
  background: string;
  name: string;
}): React.ReactElement {
  return (
    <div
      style={{
        marginBottom: '0.9rem',
        padding: '0.55rem 0.75rem',
        border: `2px solid ${stroke}`,
        background,
        color: '#000',
        borderRadius: '3px',
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: '0.9rem'
      }}
    >
      {name} preview
    </div>
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
    text = `✅ Created "${status.name}" (id: ${status.id}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate' || status.kind === 'invalid') {
    text = `⚠️ ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else {
    text = `❌ ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
