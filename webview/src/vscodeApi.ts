// Tiny helpers shared by every SNL webview entry.
import type React from 'react';
import './components/ui.css';

/**
 * Minimal shape of the VS Code webview API we rely on.
 *
 * `getState`/`setState` are the webview's own persisted scratch space. They
 * survive the DOM being torn down. Since 2026-07-25 panels run with
 * `retainContextWhenHidden: true`, so hiding no longer tears anything down —
 * but a window reload / VS Code restart still does, and this is what carries
 * an in-progress draft across it.
 */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// `acquireVsCodeApi` may only be called once per webview load; cache it.
// The panel HTML calls it first (in an inline bootstrap script that emits
// timing marks) and parks the handle on `window.__snlApi`, so prefer that
// over calling again — a second call throws. Cat 2026-07-25.
let vscodeApi: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi | undefined {
  if (vscodeApi) {
    return vscodeApi;
  }
  const preAcquired = (globalThis as { __snlApi?: VsCodeApi }).__snlApi;
  if (preAcquired) {
    vscodeApi = preAcquired;
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
  lineHeight: 1.5,
  width: '100%',
  maxWidth: 'none',
  minWidth: 0,
  boxSizing: 'border-box'
};
