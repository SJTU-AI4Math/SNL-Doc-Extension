// Tiny helpers shared by every SNL webview entry.
import type React from 'react';

/** Minimal shape of the VS Code webview API we rely on. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// `acquireVsCodeApi` may only be called once per webview load; cache it.
let vscodeApi: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi | undefined {
  if (vscodeApi) {
    return vscodeApi;
  }
  if (typeof acquireVsCodeApi === 'function') {
    vscodeApi = acquireVsCodeApi();
    return vscodeApi;
  }
  return undefined;
}

/** Shared style tokens — keep panels visually aligned with VS Code themes. */
export const PANEL_STYLE: React.CSSProperties = {
  fontFamily:
    'var(--vscode-font-family, system-ui, -apple-system, sans-serif)',
  color: 'var(--vscode-foreground, #ddd)',
  padding: '1.5rem',
  lineHeight: 1.5
};

export function primaryButton(enabled: boolean): React.CSSProperties {
  return {
    padding: '0.45rem 1rem',
    color: 'var(--vscode-button-foreground, #fff)',
    background: enabled
      ? 'var(--vscode-button-background, #0e639c)'
      : 'var(--vscode-button-secondaryBackground, #444)',
    border: 'none',
    borderRadius: '2px',
    cursor: enabled ? 'pointer' : 'default',
    fontFamily: 'inherit',
    fontSize: '0.95rem',
    opacity: enabled ? 1 : 0.6
  };
}
