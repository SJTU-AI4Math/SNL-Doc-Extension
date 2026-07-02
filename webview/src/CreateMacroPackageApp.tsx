// SNL Create Macro Package webview: a small form (file name / display name /
// description) that forwards to the host, which creates an EMPTY canonical
// macro package at `.SNL_Doc/term_macros/<file>.json`. Requires `.SNL_Doc/`
// to already exist (see SNL: Init).

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
  | { kind: 'created'; file: string }
  | { kind: 'duplicate'; file: string; message: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

const FILE_RE = /^[a-zA-Z0-9_-]+$/;

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.4rem 0.55rem',
  color: 'var(--vscode-input-foreground, #ddd)',
  background: 'var(--vscode-input-background, #2a2a2a)',
  border:
    '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
  borderRadius: '2px',
  fontFamily: 'inherit',
  fontSize: '0.95rem'
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.35rem',
  fontWeight: 600
};

export function CreateMacroPackageApp(): React.ReactElement {
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'created'; file: string }
        | { type: 'duplicate'; file: string; message: string }
        | { type: 'invalid'; reason: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'created':
          setStatus({ kind: 'created', file: msg.file });
          setFile('');
          setName('');
          setDescription('');
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            file: msg.file,
            message: msg.message
          });
          break;
        case 'invalid':
          setStatus({ kind: 'invalid', reason: msg.reason });
          break;
        case 'noSnlDoc':
          setStatus({ kind: 'noSnlDoc', message: msg.message });
          break;
        case 'noWorkspace':
          setStatus({ kind: 'noWorkspace', message: msg.message });
          break;
        case 'error':
          setStatus({ kind: 'error', message: msg.message });
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const trimmedFile = file.trim();
  const trimmedName = name.trim();
  const fileValid = FILE_RE.test(trimmedFile);
  const canCreate =
    fileValid && trimmedName.length > 0 && status.kind !== 'creating';

  function handleCreate(): void {
    if (!canCreate) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: 'create',
      file: trimmedFile,
      name: trimmedName,
      description: description.trim()
    });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '34rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        Create Macro Package
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        Create an empty macro package under{' '}
        <code>.SNL_Doc/term_macros/</code>. The file name becomes the JSON
        filename; the display name is stored in the package.
      </p>

      <label htmlFor="pkg-file" style={labelStyle}>
        File name
      </label>
      <input
        id="pkg-file"
        type="text"
        value={file}
        placeholder="e.g. mathlib_basic"
        onChange={(e) => setFile(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleCreate();
          }
        }}
        style={{
          ...inputStyle,
          marginBottom: '0.35rem',
          borderColor:
            trimmedFile.length > 0 && !fileValid
              ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
              : undefined
        }}
      />
      {trimmedFile.length > 0 && !fileValid ? (
        <p
          style={{
            margin: '0 0 0.6rem',
            fontSize: '0.85rem',
            color: 'var(--vscode-errorForeground, #f48771)'
          }}
        >
          Only letters, digits, <code>_</code> and <code>-</code> allowed (no
          dots, no slashes).
        </p>
      ) : (
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', opacity: 0.7 }}>
          will create:{' '}
          <code>
            .SNL_Doc/term_macros/{fileValid ? trimmedFile : '<file>'}.json
          </code>
        </p>
      )}

      <label htmlFor="pkg-name" style={labelStyle}>
        Display name
      </label>
      <input
        id="pkg-name"
        type="text"
        value={name}
        placeholder="e.g. Mathlib Basic"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleCreate();
          }
        }}
        style={{ ...inputStyle, marginBottom: '0.9rem' }}
      />

      <label htmlFor="pkg-desc" style={labelStyle}>
        Description <span style={{ opacity: 0.6 }}>(optional)</span>
      </label>
      <textarea
        id="pkg-desc"
        value={description}
        placeholder="What this package is for…"
        rows={3}
        onChange={(e) => setDescription(e.target.value)}
        style={{ ...inputStyle, marginBottom: '1rem', resize: 'vertical' }}
      />

      <button
        type="button"
        onClick={handleCreate}
        disabled={!canCreate}
        style={primaryButton(canCreate)}
      >
        {status.kind === 'creating' ? 'Creating…' : 'Create Package'}
      </button>

      <StatusLine status={status} />
    </main>
  );
}

function StatusLine({
  status
}: {
  status: Status;
}): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `✅ Created package "${status.file}".`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = `⚠️ ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'invalid') {
    text = `❌ Invalid: ${status.reason}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noSnlDoc' ||
    status.kind === 'noWorkspace'
  ) {
    text = `❌ ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = `❌ Error: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
