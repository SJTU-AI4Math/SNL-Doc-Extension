// SNL Init webview: a single "Initialize" button that asks the extension host
// to scaffold the empty `.SNL_Doc/` skeleton in the workspace root. Library
// creation lives in a separate command (`SNL: Create Library`).

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

type Status =
  | { kind: 'idle' }
  | { kind: 'initializing' }
  | { kind: 'created'; path: string }
  | { kind: 'exists' }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'error'; message: string };

export function InitApp(): React.ReactElement {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'created'; path: string }
        | { type: 'exists' }
        | { type: 'noWorkspace'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'created':
          setStatus({ kind: 'created', path: msg.path });
          break;
        case 'exists':
          setStatus({ kind: 'exists' });
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

  const canInit = status.kind !== 'initializing';

  function handleInit(): void {
    if (!canInit) {
      return;
    }
    setStatus({ kind: 'initializing' });
    apiRef.current?.postMessage({ type: 'init' });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '34rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>SNL Init</h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        Create an empty <code>.SNL_Doc/</code> skeleton in the current
        workspace root. This sets up the shared <code>entries.json</code>{' '}
        pool, the <code>term_macros/</code> folder, and an empty{' '}
        <code>libraries/</code> folder.
      </p>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        To add your first library, run{' '}
        <code>SNL: Create Library</code> after initialization.
      </p>

      <button
        type="button"
        onClick={handleInit}
        disabled={!canInit}
        style={primaryButton(canInit)}
      >
        {status.kind === 'initializing' ? 'Initializing…' : 'Initialize'}
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
  if (status.kind === 'idle' || status.kind === 'initializing') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `✅ Created ${status.path}/`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'exists') {
    text =
      '⚠️ .SNL_Doc already exists — use "SNL: Create Library" to add libraries.';
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
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
