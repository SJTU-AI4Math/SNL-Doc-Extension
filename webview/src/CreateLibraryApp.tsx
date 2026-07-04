// SNL Create/Edit Library webview: a single-field form for the library's
// title. Create mode forwards to createLibrary (host slugifies + creates dir);
// edit mode forwards to updateLibrary (host only rewrites the title in
// config.json; slug is the directory name and is immutable).

import React, { useEffect, useRef, useState } from 'react';
import {
  getVsCodeApi,
  PANEL_STYLE,
  primaryButton,
  type VsCodeApi
} from './vscodeApi';

type Mode = 'create' | 'edit';

interface ExistingLibrary {
  slug: string;
  title: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; slug: string; title: string }
  | { kind: 'updated'; slug: string; title: string }
  | { kind: 'duplicate'; slug: string; message: string }
  | { kind: 'notFound'; slug: string; message: string }
  | { kind: 'noSnlDoc'; message: string }
  | { kind: 'noWorkspace'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

export function CreateLibraryApp(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('create');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | {
            type: 'context';
            mode: Mode;
            slug?: string;
            existing?: ExistingLibrary | null;
          }
        | { type: 'created'; slug: string; title: string }
        | { type: 'updated'; slug: string; title: string }
        | { type: 'duplicate'; slug: string; message: string }
        | { type: 'notFound'; slug: string; message: string }
        | { type: 'noSnlDoc'; message: string }
        | { type: 'noWorkspace'; message: string }
        | { type: 'invalid'; message: string }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'context':
          setMode(msg.mode);
          if (msg.mode === 'edit') {
            setSlug(msg.slug ?? '');
            if (msg.existing) {
              setTitle(msg.existing.title);
            }
          }
          break;
        case 'created':
          setStatus({ kind: 'created', slug: msg.slug, title: msg.title });
          setTitle('');
          break;
        case 'updated':
          setStatus({ kind: 'updated', slug: msg.slug, title: msg.title });
          break;
        case 'duplicate':
          setStatus({
            kind: 'duplicate',
            slug: msg.slug,
            message: msg.message
          });
          break;
        case 'notFound':
          setStatus({
            kind: 'notFound',
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
        case 'invalid':
          setStatus({ kind: 'invalid', message: msg.message });
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

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && status.kind !== 'creating';

  function handleSubmit(): void {
    if (!canSubmit) {
      return;
    }
    setStatus({ kind: 'creating' });
    apiRef.current?.postMessage({
      type: mode === 'edit' ? 'update' : 'create',
      title: trimmed
    });
  }

  return (
    <main style={{ ...PANEL_STYLE, maxWidth: '34rem' }}>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
        {mode === 'edit' ? 'Edit Library' : 'Create Library'}
      </h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        {mode === 'edit'
          ? 'Update this library\u2019s display title. The slug (directory name) is immutable — delete + recreate to rename.'
          : 'Add a new library to the existing .SNL_Doc/. The title is preserved verbatim in config.json; a filesystem-safe slug is derived for the directory name.'}
      </p>

      {mode === 'edit' ? (
        <>
          <label
            htmlFor="snl-library-slug"
            style={{
              display: 'block',
              marginBottom: '0.35rem',
              fontWeight: 600
            }}
          >
            Slug (readonly)
          </label>
          <input
            id="snl-library-slug"
            type="text"
            value={slug}
            readOnly
            title="IDs / slugs are immutable; delete + recreate to rename"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '0.4rem 0.55rem',
              marginBottom: '0.9rem',
              color: 'var(--vscode-descriptionForeground, #999)',
              background: 'var(--vscode-input-background, #2a2a2a)',
              border:
                '1px solid var(--vscode-input-border, var(--vscode-contrastBorder, #444))',
              borderRadius: '2px',
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
              fontSize: '0.95rem',
              opacity: 0.7,
              cursor: 'not-allowed'
            }}
          />
        </>
      ) : null}

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
            handleSubmit();
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
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={primaryButton(canSubmit)}
      >
        {status.kind === 'creating'
          ? mode === 'edit' ? 'Updating\u2026' : 'Creating\u2026'
          : mode === 'edit' ? 'Update Library' : 'Create Library'}
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
    text = `\u2705 Created library "${status.title}" (slug: ${status.slug}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'updated') {
    text = `\u2705 Updated library "${status.title}" (slug: ${status.slug}).`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'duplicate') {
    text = `\u26a0\ufe0f ${status.message}`;
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'notFound') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'noSnlDoc') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'noWorkspace') {
    text = `\u274c ${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  } else if (status.kind === 'invalid') {
    text = `\u274c Invalid: ${status.message}`;
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
