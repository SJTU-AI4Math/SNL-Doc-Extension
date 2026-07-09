// SNL Create/Edit Macro Package webview.
//
// Create mode: file name + display name + optional description; host creates
// an empty canonical macro package at .SNL_Doc/term_macros/<file>.json.
//
// Edit mode: file name is readonly (renaming == delete + recreate). Only the
// display name and description are editable.

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';
import { PanelNav } from './components/PanelNav';

type Mode = 'create' | 'edit';

interface ExistingPackage {
  file: string;
  name: string;
  description: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; file: string }
  | { kind: 'updated'; file: string; name: string }
  | { kind: 'duplicate'; file: string; message: string }
  | { kind: 'notFound'; file: string; message: string }
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

const readonlyStyle: React.CSSProperties = {
  ...inputStyle,
  color: 'var(--vscode-descriptionForeground, #999)',
  opacity: 0.7,
  cursor: 'not-allowed',
  fontFamily: 'var(--vscode-editor-font-family, monospace)'
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.35rem',
  fontWeight: 600
};

export function CreateMacroPackageApp(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('create');
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'context';
            mode: Mode;
            file?: string;
            existing?: ExistingPackage | null;
          }
        | { type: 'created'; file: string }
        | { type: 'updated'; file: string; name: string }
        | { type: 'duplicate'; file: string; message: string }
        | { type: 'notFound'; file: string; message: string }
        | { type: 'invalid'; reason: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setMode(msg.mode);
          if (msg.mode === 'edit') {
            setFile(msg.file ?? '');
            if (msg.existing) {
              setName(msg.existing.name);
              setDescription(msg.existing.description);
            }
          }
          break;
        case 'created':
          setStatus({ kind: 'created', file: msg.file });
          setFile('');
          setName('');
          setDescription('');
          break;
        case 'updated':
          setStatus({ kind: 'updated', file: msg.file, name: msg.name });
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            file: msg.file,
            message: msg.message
          });
          break;
        case 'notFound':
          setStatus({
            kind: 'notFound',
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
    apiRef.current?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const trimmedFile = file.trim();
  const trimmedName = name.trim();
  const fileValid = mode === 'edit' ? true : FILE_RE.test(trimmedFile);
  const canSubmit =
    fileValid && trimmedName.length > 0 && status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canSubmit) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      file: trimmedFile,
      name: trimmedName,
      description: description.trim()
    });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '34rem' }}>
      <PanelNav
        vsApi={apiRef.current}
        back={{ label: 'Dashboard', title: 'Back to Dashboard', message: { type: 'nav.openDashboard' } }}
      />
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        {mode === 'edit' ? 'Edit Macro Package' : 'Create Macro Package'}
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        {mode === 'edit'
          ? 'Update this package\u2019s display name and description. The file name is immutable \u2014 renaming means delete + recreate.'
          : 'Create an empty macro package under .SNL_Doc/term_macros/. The file name becomes the JSON filename; the display name is stored in the package.'}
      </p>

      <label htmlFor="pkg-file" style={labelStyle}>
        {mode === 'edit' ? 'File name (readonly)' : 'File name'}
      </label>
      <input
        id="pkg-file"
        type="text"
        value={file}
        readOnly={mode === 'edit'}
        placeholder="e.g. mathlib_basic"
        onChange={(e) => setFile(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleSubmit();
          }
        }}
        title={
          mode === 'edit'
            ? 'File names are immutable; delete + recreate to rename'
            : undefined
        }
        style={{
          ...(mode === 'edit' ? readonlyStyle : inputStyle),
          marginBottom: '0.35rem',
          borderColor:
            mode !== 'edit' && trimmedFile.length > 0 && !fileValid
              ? 'var(--vscode-inputValidation-errorBorder, #be1100)'
              : undefined
        }}
      />
      {mode !== 'edit' && trimmedFile.length > 0 && !fileValid ? (
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
      ) : mode !== 'edit' ? (
        <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', opacity: 0.7 }}>
          will create:{' '}
          <code>
            .SNL_Doc/term_macros/{fileValid ? trimmedFile : '<file>'}.json
          </code>
        </p>
      ) : (
        <div style={{ height: '0.6rem' }} />
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
            handleSubmit();
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
        placeholder="What this package is for\u2026"
        rows={3}
        onChange={(e) => setDescription(e.target.value)}
        style={{ ...inputStyle, marginBottom: '1rem', resize: 'vertical' }}
      />

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={primaryButton(canSubmit)}
      >
        {status.kind === 'creating'
          ? mode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
          : mode === 'edit' ? 'Update Package' : 'Create Package'}
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
    text = `\u2705 Created package "${status.file}".`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = `\u2705 Updated package "${status.file}" (name: ${status.name}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate' || status.kind === 'notFound') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'invalid') {
    text = `\u274c Invalid: ${status.reason}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (
    status.kind === 'noSnlDoc' ||
    status.kind === 'noWorkspace'
  ) {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'error') {
    text = `\u274c Error: ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
