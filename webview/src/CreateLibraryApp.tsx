// SNL Create Library webview: a single-field form that asks the user for the
// new library's title and forwards it to the extension host, which appends to
// an existing `.SNL_Doc/`. Requires `.SNL_Doc/` to already exist (see
// SNL: Init).

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
  | { kind: 'created'; slug: string; title: string }
  | { kind: 'duplicate'; slug: string; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

export function CreateLibraryApp(): React.ReactElement {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'created'; slug: string; title: string }
        | { type: 'duplicate'; slug: string; message: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'created':
          setStatus({ kind: 'created', slug: msg.slug, title: msg.title });
          setTitle('');
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            slug: msg.slug,
            message: msg.message
          });
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

  const trimmed = title.trim();
  const canCreate = trimmed.length > 0 && status.kind !== 'creating';

  function handleCreate(): void {
    if (!canCreate) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({ type: 'create', title: trimmed });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '34rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        Create Library
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        Add a new library to the existing <code>.SNL_Doc/</code>. The title
        is preserved verbatim in <code>config.json</code>; a filesystem-safe
        slug is derived for the directory name.
      </p>

      <label
        htmlFor="snl-library-title"
        style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}
      >
        Library title
      </label>
      <input
        id="snl-library-title"
        type="text"
        value={title}
        placeholder="e.g. Real Analysis"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            handleCreate();
          }
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '0.4rem 0.55rem',
          marginBottom: '0.9rem',
          color: 'var(--vscode-input-foreground, #ddd)',
          background: 'var(--vscode-input-background, #2a2a2a)',
          border:
            '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #555))',
          borderRadius: '2px',
          fontFamily: 'inherit',
          fontSize: '0.95rem'
        }}
      />

      <button
        type="button"
        onClick={handleCreate}
        disabled={!canCreate}
        style={primaryButton(canCreate)}
      >
        {status.kind === 'creating' ? 'Creating…' : 'Create Library'}
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
    text = `✅ Created library "${status.title}" (slug: ${status.slug}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = `⚠️ ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'noSnlDoc') {
    text = `❌ ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'noWorkspace') {
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
