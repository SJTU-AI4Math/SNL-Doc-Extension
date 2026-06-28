// SNL Init guide webview: a small form that asks for the first library title
// and asks the extension host to scaffold `.SNL_Doc/` in the workspace root.

import React, { useEffect, useRef, useState } from 'react';

// Minimal shape of the VS Code webview API we rely on.
interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// `acquireVsCodeApi` may only be called once per webview load; cache it.
let vscodeApi: VsCodeApi | undefined;
function getVsCodeApi(): VsCodeApi | undefined {
  if (vscodeApi) {
    return vscodeApi;
  }
  if (typeof acquireVsCodeApi === 'function') {
    vscodeApi = acquireVsCodeApi();
    return vscodeApi;
  }
  return undefined;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; path: string; slug: string }
  | { kind: 'exists' }
  | { kind: 'error'; message: string };

export function InitApp(): React.ReactElement {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const apiRef = useRef<VsCodeApi | undefined>(undefined);

  useEffect(() => {
    apiRef.current = getVsCodeApi();

    function onMessage(event: MessageEvent): void {
      const msg = event.data as
        | { type: 'created'; path: string; slug: string }
        | { type: 'exists' }
        | { type: 'error'; message: string }
        | undefined;
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'created':
          setStatus({ kind: 'created', path: msg.path, slug: msg.slug });
          break;
        case 'exists':
          setStatus({ kind: 'exists' });
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
    <main
      style={{
        fontFamily:
          'var(--vscode-font-family, system-ui, -apple-system, sans-serif)',
        color: 'var(--vscode-foreground, #ddd)',
        padding: '1.5rem',
        lineHeight: 1.5,
        maxWidth: '32rem'
      }}
    >
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>SNL Init</h1>
      <p style={{ margin: '0 0 1rem', opacity: 0.8 }}>
        在当前工作区根目录创建 <code>.SNL_Doc/</code> 结构。请输入首个 library 的标题。
      </p>

      <label
        htmlFor="snl-init-title"
        style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 600 }}
      >
        Library 标题
      </label>
      <input
        id="snl-init-title"
        type="text"
        value={title}
        placeholder="例如：我的数学库"
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
        style={{
          padding: '0.45rem 1rem',
          color: 'var(--vscode-button-foreground, #fff)',
          background: canCreate
            ? 'var(--vscode-button-background, #0e639c)'
            : 'var(--vscode-button-secondaryBackground, #444)',
          border: 'none',
          borderRadius: '2px',
          cursor: canCreate ? 'pointer' : 'default',
          fontFamily: 'inherit',
          fontSize: '0.95rem',
          opacity: canCreate ? 1 : 0.6
        }}
      >
        {status.kind === 'creating' ? '创建中…' : '创建 SNL Doc'}
      </button>

      <StatusLine status={status} />
    </main>
  );
}

function StatusLine({ status }: { status: Status }): React.ReactElement | null {
  if (status.kind === 'idle' || status.kind === 'creating') {
    return null;
  }

  let text = '';
  let color = 'var(--vscode-foreground, #ddd)';
  if (status.kind === 'created') {
    text = `✅ 已创建 ${status.path}/，library: ${status.slug}`;
    color = 'var(--vscode-testing-iconPassed, #89d185)';
  } else if (status.kind === 'exists') {
    text = '⚠️ .SNL_Doc 已存在，未做任何更改';
    color = 'var(--vscode-editorWarning-foreground, #cca700)';
  } else if (status.kind === 'error') {
    text = `❌ 错误：${status.message}`;
    color = 'var(--vscode-errorForeground, #f48771)';
  }

  return (
    <p style={{ marginTop: '1rem', marginBottom: 0, color, fontWeight: 600 }}>
      {text}
    </p>
  );
}
