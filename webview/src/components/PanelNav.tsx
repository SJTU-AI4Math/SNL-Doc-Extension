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
import { Button } from './Button';
import { formatDirectionalLabel } from './interactionModel';
import {
  use_localized,
  type LocalizedString
} from '../runtime/useLocalized';

export interface PanelNavAction {
  /** Text on the button. Kept terse. */
  label: LocalizedString;
  /** Tooltip. Full sentence explaining what happens. */
  title?: LocalizedString;
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
  const backLabel = use_localized(back.label);
  const backTitle = use_localized(back.title ?? back.label);
  const viewLabel = use_localized(viewInInfoview?.label ?? '');
  const viewTitle = use_localized(
    viewInInfoview?.title ?? viewInInfoview?.label ?? ''
  );
  const navigationLabel = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: { en: 'Panel navigation', 'zh-CN': '面板导航' }
  });
  const refreshTitle = use_localized({
    type: 'i18n',
    default_language: 'en',
    values: { en: 'Refresh this panel from disk', 'zh-CN': '从磁盘刷新此面板' }
  });
  return (
    <nav
      aria-label={navigationLabel}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem',
        padding: '0.4rem 0.6rem',
        marginBottom: '0.75rem',
        borderBottom:
          '1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, #333))',
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background:
          'var(--vscode-editor-background, var(--vscode-editorWidget-background, #1e1e1e))'
      }}
    >
      <Button
        variant="secondary"
        size="md"
        title={backTitle}
        onClick={() => vsApi?.postMessage(back.message)}
      >
        {formatDirectionalLabel('back', backLabel)}
      </Button>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        {/* Cat 2026-07-13: universal manual refresh — data-file changes
            SHOULD auto-sync via the FS watcher on the host, but this
            gives the user an escape hatch when a rename / async delay
            leaves a panel showing stale data. Every panel that mounts
            PanelNav gets it for free. */}
        <Button
          variant="secondary"
          size="md"
          title={refreshTitle}
          onClick={() => vsApi?.postMessage({ type: 'nav.refresh' })}
        >
          {'↻'}
        </Button>
        {viewInInfoview ? (
          <Button
            variant="secondary"
            size="md"
            title={viewTitle}
            onClick={() => vsApi?.postMessage(viewInInfoview.message)}
          >
            {formatDirectionalLabel('forward', viewLabel)}
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
