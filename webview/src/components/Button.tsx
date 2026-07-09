// Shared Button component (cat 2026-07-09: '所有 Button 都应该有悬浮和点
// 击的视效反馈，你应该让所有 Button 从一个 React 组件出口出，不要每个地
// 方单独设 CSS').
//
// Every clickable element in the webviews should route through this
// component so hover / active / focus / disabled affordances stay
// consistent and get fixed in one place.
//
// Variants map to the four visual roles we've been using ad-hoc:
//
//   primary     — main CTA (Save / Submit / Create). Filled with the
//                 VS Code button-background color.
//   secondary   — default, most toolbar buttons + nav buttons. Muted
//                 background, subtle border.
//   destructive — Delete / Remove. Red border + red text; hover fills
//                 with a light red wash.
//   ghost       — icon-only or utility buttons that shouldn't shout —
//                 transparent background, colored on hover.
//
// Sizes: 'sm' (0.15rem 0.5rem), 'md' (default, 0.3rem 0.75rem),
// 'lg' (0.5rem 1.1rem). Size only affects padding + font-size, not the
// visual variant.
//
// The hover / active / focus feedback is implemented as a scoped
// <style> block auto-injected on first mount — pure CSS, no React
// state (see the OutlineRow bug 2026-07-09 for why React-state hover
// is unsafe in this codebase). All Button instances share the class
// names so the stylesheet is de-duplicated.

import React, { useEffect, useRef } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Visible label. Emoji + text are both fine. */
  children: React.ReactNode;
  /** Visual role. Defaults to 'secondary'. */
  variant?: ButtonVariant;
  /** Padding + font-size preset. Defaults to 'md'. */
  size?: ButtonSize;
  /** When true renders as an <a>-like link; otherwise a real <button>. */
  as?: 'button';
  /** Tooltip. Also used as aria-label if none was passed. */
  title?: string;
  /** Merge into the computed base style. */
  style?: React.CSSProperties;
}

const STYLE_TAG_ID = 'snl-shared-button-style';

const STYLESHEET = `
.snl-btn {
  font-family: inherit;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: background-color 100ms ease-in, border-color 100ms ease-in,
    color 100ms ease-in, transform 60ms ease-out, opacity 100ms ease-in;
  user-select: none;
}
.snl-btn:disabled,
.snl-btn[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
}
.snl-btn:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
}
.snl-btn:active:not(:disabled):not([aria-disabled="true"]) {
  transform: translateY(1px);
}

/* Size presets */
.snl-btn--sm { padding: 0.15rem 0.5rem; font-size: 0.75rem; }
.snl-btn--md { padding: 0.3rem 0.75rem; font-size: 0.85rem; }
.snl-btn--lg { padding: 0.5rem 1.1rem; font-size: 0.95rem; }

/* Primary */
.snl-btn--primary {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
  border-color: var(--vscode-button-border, transparent);
}
.snl-btn--primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #1177bb);
}
.snl-btn--primary:active:not(:disabled) {
  background: var(--vscode-button-background, #0e639c);
  filter: brightness(0.92);
}

/* Secondary — default */
.snl-btn--secondary {
  background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06));
  color: var(--vscode-button-secondaryForeground, inherit);
  border-color: var(--vscode-panel-border, var(--vscode-contrastBorder, #444));
}
.snl-btn--secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.12));
  border-color: var(--vscode-focusBorder, var(--vscode-contrastActiveBorder, #007fd4));
}
.snl-btn--secondary:active:not(:disabled) {
  filter: brightness(0.9);
}

/* Destructive — Delete / Remove */
.snl-btn--destructive {
  background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.15));
  color: var(--vscode-errorForeground, #f48771);
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}
.snl-btn--destructive:hover:not(:disabled) {
  background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.3));
  filter: brightness(1.15);
}
.snl-btn--destructive:active:not(:disabled) {
  filter: brightness(0.9);
}

/* Ghost — transparent utility */
.snl-btn--ghost {
  background: transparent;
  color: inherit;
  border-color: transparent;
}
.snl-btn--ghost:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
}
.snl-btn--ghost:active:not(:disabled) {
  background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.14));
}
`;

function ensureStylesheet(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_TAG_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_TAG_ID;
  el.textContent = STYLESHEET;
  document.head.appendChild(el);
}

/**
 * The shared Button. All feedback (hover / active / focus / disabled) is
 * done via the injected stylesheet — do NOT add inline background /
 * border via `style` unless you truly need a one-off tweak, or you'll
 * clobber the hover states.
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className,
  title,
  disabled,
  style,
  type = 'button',
  ...rest
}: ButtonProps): React.ReactElement {
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    ensureStylesheet();
  }, []);

  const classes = ['snl-btn', `snl-btn--${variant}`, `snl-btn--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      title={title}
      aria-label={rest['aria-label'] ?? title}
      disabled={disabled}
      className={classes}
      style={style}
      {...rest}
    >
      {children}
    </button>
  );
}
