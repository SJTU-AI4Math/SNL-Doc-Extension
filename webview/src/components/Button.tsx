import React from 'react';
import './ui.css';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  title?: string;
  style?: React.CSSProperties;
  loading?: boolean;
  loadingLabel?: React.ReactNode;
}

/** Single exit for every webview button; interaction styling lives in ui.css. */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className,
  title,
  disabled,
  loading = false,
  loadingLabel,
  type = 'button',
  ...rest
}: ButtonProps): React.ReactElement {
  const classes = ['snl-btn', `snl-btn--${variant}`, `snl-btn--${size}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      title={title}
      aria-label={rest['aria-label'] ?? title}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={classes}
      {...rest}
    >
      {loading ? (loadingLabel ?? children) : children}
    </button>
  );
}
