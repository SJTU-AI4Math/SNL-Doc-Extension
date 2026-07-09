// Top-of-panel navigation strip: back button (left) + optional "View in
// Infoview" button (right). Every editor / list panel now hosts one of
// these at its top edge.
//
// Cat 2026-07-09: '应该加一些导航按钮，比如在每个 Panel 左上角 + 返回按钮
// ... Edit 按钮（以及编辑界面应该有一个对应的 View in Infoview 按钮）应
// 该绑定 corresponding 的那个页面.'
//
// VS Code webview panels do NOT have browser history, and each panel is a
// separate WebviewPanel with no cross-panel router. So "back" is
// implemented as "open the parent panel via a command" — not a stack pop.
// That's fine: our nav tree is shallow and every panel has a
// well-defined "parent" (Dashboard for kind/macro/package/entry editors;
// Infoview for CreateLibrary in edit mode).
//
// Left button: caller supplies `back` — a label + a message the parent
// panel's Incoming type understands. We post it via `vsApi.postMessage`
// and the host forwards to `vscode.commands.executeCommand`.
//
// Right button: caller supplies `viewInInfoview` — same shape. Omit for
// panels with no "corresponding infoview view" (kind editors, package
// editor).

import React from 'react';
import type { VsCodeApi } from '../vscodeApi';

export interface PanelNavAction {
  /** Text on the button. Kept terse. */
  label: string;
  /** Tooltip. Full sentence explaining what happens. */
  title?: string;
  /** Message payload posted to the host. Host dispatches via command. */
  message: Record<string, unknown>;
}

export interface PanelNavProps {
  vsApi: VsCodeApi | undefined;
  /** Left-side action (back / go up). Required. */
  back: PanelNavAction;
  /** Right-side action (view corresponding infoview page). Optional —
   *  panels without an infoview counterpart (kind editors, package
   *  editor, init flows) simply omit it. */
  viewInInfoview?: PanelNavAction;
}

export function PanelNav({
  vsApi,
  back,
  viewInInfoview
}: PanelNavProps): React.ReactElement {
  return (
    <nav
      aria-label="Panel navigation"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem',
        padding: '0.4rem 0.6rem',
        marginBottom: '0.75rem',
        borderBottom:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        // Sticky so long-form editors keep the nav visible while scrolling.
        // The webview root has no scroll ancestor here except the body,
        // which is what we want.
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background:
          'var(--vscode-editor-background, var(--vscode-editorWidget-background, #1e1e1e))'
      }}
    >
      <NavButton
        label={`← ${back.label}`}
        title={back.title ?? back.label}
        onClick={() => vsApi?.postMessage(back.message)}
      />
      {viewInInfoview ? (
        <NavButton
          label={`${viewInInfoview.label} →`}
          title={viewInInfoview.title ?? viewInInfoview.label}
          onClick={() => vsApi?.postMessage(viewInInfoview.message)}
        />
      ) : (
        <span />
      )}
    </nav>
  );
}

function NavButton({
  label,
  title,
  onClick
}: {
  label: string;
  title: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        padding: '0.3rem 0.75rem',
        fontFamily: 'inherit',
        fontSize: '0.85rem',
        border:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #444))',
        background:
          'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06))',
        color: 'var(--vscode-button-secondaryForeground, inherit)',
        borderRadius: '3px',
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </button>
  );
}
