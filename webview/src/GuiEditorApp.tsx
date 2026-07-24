import React from 'react';
import { PanelNav } from './components/PanelNav';
import { getVsCodeApi, type VsCodeApi } from './vscodeApi';

/** Initial shell for the DOM/SVG Entry GUI Editor. */
export function GuiEditorApp(): React.ReactElement {
  const apiRef = React.useRef<VsCodeApi | undefined>(undefined);
  if (!apiRef.current) apiRef.current = getVsCodeApi();

  return (
    <main
      style={{
        width: '100vw',
        height: '100vh',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        padding: '0.75rem',
        overflow: 'hidden'
      }}
    >
      <PanelNav
        vsApi={apiRef.current}
        back={{
          label: 'Dashboard',
          title: 'Back to Dashboard',
          message: { type: 'nav.openDashboard' }
        }}
      />
      <header style={{ marginBottom: '0.65rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>GUI Editor (Canvas)</h1>
        <p style={{ margin: '0.25rem 0 0', opacity: 0.7 }}>
          DOM canvas shell ready. Entry nodes and SVG relationships come next.
        </p>
      </header>
      <div
        data-gui-editor-canvas
        style={{
          position: 'relative',
          flex: '1 1 auto',
          minHeight: 0,
          overflow: 'hidden',
          border: '1px solid var(--vscode-panel-border, #444)',
          borderRadius: '6px',
          backgroundColor: 'var(--vscode-editor-background)',
          backgroundImage:
            'radial-gradient(circle, var(--vscode-editorWidget-border, #555) 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
        aria-label="GUI Editor canvas"
      />
    </main>
  );
}
